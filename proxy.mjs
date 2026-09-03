// claude-go proxy: Claude Code (Anthropic API) <-> opencode-go (OpenAI-compatible)
//
// Why this exists:
//   Claude Code speaks the Anthropic API (POST /v1/messages with Anthropic
//   tool format). The opencode-go subscription endpoint
//   https://opencode.ai/zen/go/v1 fronts several providers; its Anthropic
//   /messages surface internally forwards to OpenAI-compatible backends and
//   does not accept Anthropic-style tool definitions for some models
//   (notably muse-spark-1.3-contributor — returns 400 "tools[0].function: missing field
//   `name`"). This proxy translates the request so the upstream sees the
//   format it expects.
//
// What it does:
//   - GET /v1/models            -> returns one model: ox-alpha-free
//   - POST /v1/messages         -> translates Anthropic request to OpenAI
//                                 chat/completions, forwards to
//                                 https://opencode.ai/zen/go/v1/chat/completions,
//                                 then converts the response back to Anthropic
//                                 format (including SSE streaming).
//
// Auth:
//   The proxy holds the opencode-go API key (default: the key baked in here,
//   can be overridden via the CLAUDE_GO_KEY env var). Callers (claude-go.cmd)
//   send an x-api-key or Authorization: Bearer header to the proxy; the
//   proxy replaces it with the opencode-go key when issuing the upstream
//   request.
//
// To run:  node proxy.mjs
//   Listens on 127.0.0.1:8765. The companion script claude-go.cmd starts
//   this automatically if it isn't already running.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";

const PORT = 8765;
const KEY = process.env.CLAUDE_GO_KEY || "sk-R0ahzBNobXIhY2PybfiIVhQ8t8StPF4GTd6fe3Ck9hWHaOxnJhnjuye940GOo16f";
const UPSTREAM = new URL("https://opencode.ai/zen/go/v1");
const LOG = process.env.CLAUDE_GO_LOG || "/Users/furkanermag/.claude-go/proxy.log";

function log(s) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {}
}

// ---------------- Anthropic -> OpenAI request ----------------
function anToOpenAI(body) {
  const out = {
    model: String(body.model || "muse-spark-1.3-contributor").split("/").pop(),
    messages: [],
    stream: body.stream === true,
    max_tokens: body.max_tokens,
  };
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;

  const sys = body.system;
  if (sys) {
    let sysText = "";
    if (typeof sys === "string") sysText = sys;
    else if (Array.isArray(sys)) sysText = sys.map((b) => (b && b.type === "text" ? b.text : "")).join("\n");
    if (sysText) out.messages.push({ role: "system", content: sysText });
  }

  for (const m of body.messages || []) {
    if (m.role === "user") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const textParts = [];
      for (const b of blocks) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_result") {
          let content = "";
          if (typeof b.content === "string") content = b.content;
          else if (Array.isArray(b.content)) content = b.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
          out.messages.push({ role: "tool", tool_call_id: b.tool_use_id, content });
        }
      }
      if (textParts.length) out.messages.push({ role: "user", content: textParts.join("\n") });
    } else if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
      const textParts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      const msg = { role: "assistant" };
      if (textParts.length) msg.content = textParts.join("\n");
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.messages.push(msg);
    }
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object" } },
    }));
  }
  const tc = body.tool_choice;
  if (tc) {
    if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc.type === "any") out.tool_choice = "required";
    else out.tool_choice = "auto";
  }
  return out;
}

// ---------------- OpenAI -> Anthropic response ----------------
function oaiToAn(body, model) {
  const choice = (body.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch (e) {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
    }
  }
  const u = body.usage || {};
  const stopMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "max_tokens" };
  return {
    id: body.id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopMap[choice.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: u.prompt_tokens ?? 0,
      output_tokens: u.completion_tokens ?? 0,
      cache_creation_input_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
      cache_read_input_tokens: 0,
    },
  };
}

function oaiStreamToAnthropic(model, oaiChunk, state) {
  const events = [];
  const choice = (oaiChunk.choices || [])[0] || {};
  const delta = choice.delta || {};
  const finish = choice.finish_reason;

  if (!state.started) {
    state.started = true;
    events.push({
      event: "message_start",
      data: {
        type: "message_start",
        message: { id: oaiChunk.id || `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      },
    });
  }

  const tc = delta.tool_calls && delta.tool_calls[0];
  if (tc) {
    const index = state.toolIndex ?? 0;
    if (tc.index !== state.toolIndex) {
      if (state.toolOpen) {
        events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: state.toolBlockIndex } });
        state.toolOpen = false;
      }
      state.toolIndex = tc.index;
    }
    if (!state.toolOpen) {
      state.toolOpen = true;
      state.toolBlockIndex = index;
      state.toolId = tc.id || `toolu_${index}`;
      state.toolName = tc.function?.name || "tool";
      state.toolArgs = "";
      events.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index,
          content_block: { type: "tool_use", id: state.toolId, name: state.toolName, input: {} },
        },
      });
    }
    if (tc.function) {
      if (tc.function.name) state.toolName = tc.function.name;
      if (tc.function.arguments) {
        state.toolArgs += tc.function.arguments;
        events.push({
          event: "content_block_delta",
          data: { type: "content_block_delta", index: state.toolBlockIndex, delta: { type: "input_json_delta", partial_json: tc.function.arguments } },
        });
      }
    }
  }

  if (delta.content) {
    if (!state.textBlockOpen) {
      state.textBlockOpen = true;
      state.textIndex = state.toolBlockIndex !== undefined ? state.toolBlockIndex + 1 : (state.lastTextIndex ?? 0);
      events.push({
        event: "content_block_start",
        data: { type: "content_block_start", index: state.textIndex, content_block: { type: "text", text: "" } },
      });
    }
    events.push({
      event: "content_block_delta",
      data: { type: "content_block_delta", index: state.textIndex, delta: { type: "text_delta", text: delta.content } },
    });
  }

  if (finish) {
    if (state.toolOpen) {
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: state.toolBlockIndex } });
      state.toolOpen = false;
    }
    if (state.textBlockOpen) {
      events.push({ event: "content_block_stop", data: { type: "content_block_stop", index: state.textIndex } });
      state.textBlockOpen = false;
    }
    const stopMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use" };
    events.push({
      event: "message_delta",
      data: { type: "message_delta", delta: { stop_reason: stopMap[finish] || "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
  }
  return events;
}

function sseOut(events) {
  let out = "";
  for (const ev of events) {
    out += `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
  }
  return out;
}

// ---------------- HTTP server ----------------
const server = http.createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        log(`GET /v1/models`);
        try {
          const upstreamModelsRes = await new Promise((resolve, reject) => {
            const opts = { hostname: UPSTREAM.hostname, port: 443, path: "/zen/go/v1/models", method: "GET", headers: { authorization: `Bearer ${KEY}` } };
            const ureq = https.request(opts, (ures) => {
              let data = "";
              ures.on("data", c => data += c);
              ures.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ data: [] }); } });
            });
            ureq.on("error", () => resolve({ data: [] }));
            ureq.end();
          });
          const upstreamData = upstreamModelsRes.data || [];
          if (upstreamData.length > 0) {
            const mapped = [];
            for (const m of upstreamData) {
              const baseId = `claude-opencode-${m.id}`;
              // Only add effort variants for Muse Spark, others just one
              if (m.id.startsWith("muse-spark")) {
                for (const eff of ["minimal","low","medium","high","max"]) {
                  mapped.push({
                    id: `${baseId}:${eff}`,
                    object: "model",
                    display_name: `${m.id} (${eff}) via opencode-go`
                  });
                }
              } else {
                mapped.push({
                  id: baseId,
                  object: "model",
                  display_name: `${m.id} (via opencode-go)`
                });
              }
            }
            // Add standard aliases on top
            mapped.unshift(
              { id: "claude-sonnet-4-5", object: "model", display_name: "muse-spark-1.3-contributor (via opencode-go)" },
              { id: "claude-opus-4-5", object: "model", display_name: "muse-spark-1.3-contributor (via opencode-go)" }
            );
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: mapped }));
            log(`GET /v1/models -> ${mapped.length} models (dynamic)`);
            return;
          }
        } catch(e) { log(`GET /v1/models fetch failed: ${e}`); }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{
          id: "claude-sonnet-4-5",
          object: "model",
          display_name: "muse-spark-1.3-contributor (via opencode-go)",
        },{
          id: "claude-opus-4-5",
          object: "model",
          display_name: "muse-spark-1.3-contributor (via opencode-go)",
        }] }));
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        const parsed = JSON.parse(body || "{}");
        const rawModel = String(parsed.model || "claude-sonnet-4-5").split("/").pop();
        // Map valid Anthropic gateway models to upstream muse-spark-1.3-contributor
        let upstreamModel = rawModel.startsWith("claude-opencode-") ? rawModel.replace("claude-opencode-", "") : rawModel.startsWith("opencode-go/") ? rawModel.replace("opencode-go/", "") : rawModel.startsWith("claude-") ? "muse-spark-1.3-contributor" : rawModel;
        // Strip effort suffix if present (e.g. muse-spark-1.3-contributor:low -> muse-spark-1.3-contributor)
        if (upstreamModel.includes(":")) upstreamModel = upstreamModel.split(":")[0];
        const model = rawModel; // for response
        const isMuseSpark = upstreamModel.startsWith("muse-spark");
        const upstreamPath = isMuseSpark ? UPSTREAM.pathname + "/responses" : UPSTREAM.pathname + "/chat/completions";
        let oaiBody, payload;
        if (isMuseSpark) {
          const parts = [];
          if (parsed.system) {
            const sys = parsed.system;
            if (typeof sys === "string") parts.push(sys);
            else if (Array.isArray(sys)) parts.push(sys.map(b => b.type==="text"?b.text:"").join("\n"));
          }
          for (const m of parsed.messages || []) {
            let text = "";
            if (Array.isArray(m.content)) {
              for (const b of m.content) {
                if (b.type === "text") text += (text?"\n":"") + b.text;
                else if (b.type === "tool_result") {
                  let c = b.content;
                  if (Array.isArray(c)) c = c.map(x=>x.type==="text"?x.text:"").join("\n");
                  else if (typeof c !== "string") c = JSON.stringify(c);
                  text += (text?"\n":"") + `tool_result ${b.tool_use_id}: ${c}`;
                }
              }
            }
            else if (typeof m.content==="string") text = m.content;
            if (text) parts.push(`${m.role}: ${text}`);
          }
          oaiBody = { model: upstreamModel, input: parts.join("\n\n"), stream: false };
          // Handle reasoning effort for Muse Spark: check model suffix like :low, :minimal, :high, :max
          let effort = "high";
          if (rawModel.includes(":")) {
            const partsEff = rawModel.split(":");
            const eff = partsEff[1];
            if (["minimal","low","medium","high","max"].includes(eff)) effort = eff;
          } else if (parsed.thinking && parsed.thinking.type === "enabled") {
            // Map Claude thinking budget to Muse Spark effort
            const budget = parsed.thinking.budget_tokens || 0;
            if (budget < 1000) effort = "low";
            else if (budget < 5000) effort = "medium";
            else effort = "high";
          }
          oaiBody.reasoning = { effort };
          if (parsed.max_tokens) oaiBody.max_output_tokens = parsed.max_tokens;
          else oaiBody.max_output_tokens = 4096;
          if (parsed.temperature!==undefined) oaiBody.temperature = parsed.temperature;
          if (Array.isArray(parsed.tools) && parsed.tools.length) {
            oaiBody.tools = parsed.tools.map(t => ({
              type: "function",
              name: t.name,
              description: t.description || "",
              parameters: t.input_schema || { type: "object", properties: {} }
            }));
            const tc = parsed.tool_choice;
            if (tc) {
              if (tc.type === "tool" && tc.name) oaiBody.tool_choice = { type: "function", name: tc.name };
              else if (tc.type === "any") oaiBody.tool_choice = "required";
              else oaiBody.tool_choice = "auto";
            }
          }
        } else {
          oaiBody = anToOpenAI({...parsed, model: upstreamModel});
        }
        payload = JSON.stringify(oaiBody);
        log(`POST /v1/messages model=${model} -> upstream=${upstreamModel} path=${upstreamPath} stream=${oaiBody.stream} -> UPSTREAM https://${UPSTREAM.hostname}${upstreamPath}`);

        const headers = {
          "content-type": "application/json",
          authorization: `Bearer ${KEY}`,
          accept: "text/event-stream",
        };
        const preq = https.request({ hostname: UPSTREAM.hostname, port: 443, path: upstreamPath, method: "POST", headers }, (pres) => {
          if (!oaiBody.stream || isMuseSpark) {
            let raw = "";
            pres.on("data", (c) => (raw += c));
            pres.on("end", () => {
              log(`<<< non-stream ${pres.statusCode} ${raw.slice(0, 200)}`);
              try {
                const oai = JSON.parse(raw);
                let an;
                if (isMuseSpark) {
                  // Responses API: extract output (message + function calls)
                  const content = [];
                  for (const o of oai.output || []) {
                    if (o.type === "message" && Array.isArray(o.content)) {
                      for (const c of o.content) {
                        if (c.type === "output_text" && c.text) content.push({ type: "text", text: c.text });
                        else if (c.type === "text" && c.text) content.push({ type: "text", text: c.text });
                      }
                    } else if (o.type === "function_call") {
                      let input = {};
                      try { input = JSON.parse(o.arguments || "{}"); } catch(e) {}
                      content.push({ type: "tool_use", id: o.call_id || o.id, name: o.name, input });
                    }
                  }
                  // Fallback if no message found
                  if (content.length===0) {
                    const out = (oai.output || []).find(o => o.type === "message");
                    const text = out?.content?.[0]?.text || "";
                    if (text) content.push({ type: "text", text });
                  }
                  const stopMap = { completed: "end_turn", incomplete: "max_tokens", failed: "end_turn" };
                  an = { id: oai.id || `msg_${Date.now()}`, type: "message", role: "assistant", content, model, stop_reason: stopMap[oai.status] || "end_turn", stop_sequence: null, usage: { input_tokens: oai.usage?.input_tokens || 0, output_tokens: oai.usage?.output_tokens || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
                } else {
                  an = oaiToAn(oai, model);
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(an));
              } catch (e) {
                res.writeHead(502, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "error", message: `upstream parse: ${e} ${raw.slice(0,200)}` } }));
              }
            });
            return;
          }
          if (pres.statusCode !== 200) {
            let raw = "";
            pres.on("data", (c) => (raw += c));
            pres.on("end", () => {
              log(`<<< stream-upstream ${pres.statusCode} ${raw.slice(0, 200)}`);
              const msg = (() => { try { return JSON.parse(raw)?.error?.message || raw.slice(0, 200); } catch { return raw.slice(0, 200); } })();
              res.writeHead(502, { "content-type": "application/json" });
              res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `upstream ${pres.statusCode}: ${msg}` } }));
            });
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const state = { started: false, toolOpen: false, textBlockOpen: false, toolIndex: 0, toolBlockIndex: undefined, lastTextIndex: 0, textIndex: 0 };
          let buf = "";
          pres.on("data", (c) => {
            buf += c.toString("utf8");
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const chunk = JSON.parse(data);
                const events = oaiStreamToAnthropic(model, chunk, state);
                if (events.length) res.write(sseOut(events));
              } catch (e) { log(`stream parse err: ${e}`); }
            }
          });
          pres.on("end", () => {
            if (!state.started) res.write(sseOut([{ event: "message_stop", data: { type: "message_stop" } }]));
            res.end();
          });
        });
        preq.on("error", (e) => {
          log(`upstream err: ${e}`);
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "error", message: String(e) } }));
          } else {
            res.end();
          }
        });
        preq.end(payload);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (e) {
      log(`handler err: ${e}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "error", message: String(e) } }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => log(`proxy up on ${PORT}`));
console.log(`claude-go proxy listening on ${PORT}`);
