# Claude Desktop × Muse Spark 1.3 via OpenCode Go

> Run **Muse Spark 1.3 Contributor** (and any OpenCode Go model) inside **Claude Desktop** on macOS via a local translation proxy — no Claude Pro plan needed.

[![OpenCode Go](https://img.shields.io/badge/OpenCode%20Go-%2410%2Fmo-8A2BE2)](https://opencode.ai/docs/go/) [![Claude Desktop](https://img.shields.io/badge/Claude%20Desktop-3P%20Gateway-black)](https://claude.ai) [![Muse Spark](https://img.shields.io/badge/Muse%20Spark-1.3%20Contributor-0467DF)](https://opencode.ai/docs/go/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**[English](#english) | [Türkçe](#türkçe) | [Hazır Prompt / Ready Prompt](#hazır-prompt--ready-prompt)**

---

<a id="english"></a>
## 🇬🇧 English — How This System Works

### Overview

This repo documents the exact setup we built to run **Muse Spark 1.3 Contributor** (free under OpenCode Go Contributor program) inside **Claude Desktop** on macOS — the same UI you use for Claude Pro, but backed by a custom `inferenceGateway`.

Claude Desktop does **not** support custom models natively. On macOS it runs in **3P (third-party) mode** via files under `~/Library/Application Support/Claude-3p/configLibrary/`. We front it with a tiny Node proxy (`~/.claude-go/proxy.mjs`) that translates Anthropic → OpenAI and handles the special case of Muse Spark.

```
┌─────────────────┐      Anthropic API       ┌──────────────────┐      OpenAI API (translated)      ┌─────────────────────────────┐
│ Claude Desktop  │  ─────────────────────►  │  proxy.mjs       │  ─────────────────────────────►  │  opencode.ai/zen/go/v1      │
│ (3P Gateway)    │  http://127.0.0.1:8765   │  127.0.0.1:8765    │  /responses (Muse Spark)         │  Muse Spark 1.3 Contributor │
│ 3P mode         │  ◄─────────────────────  │  (Node)          │  ◄─────────────────────────────  │  DeepSeek / GLM / Kimi ...  │
└─────────────────┘                          └──────────────────┘                                  └─────────────────────────────┘
         ▲                                            │                                                     │
         │ MCP (stdio)                                │ CLAUDE_GO_KEY                                         │ Bearer sk-... (Go subscription)
         │ npx -y opencode-mcp                        │ sk-...                                                │
         ▼                                            ▼                                                     ▼
┌─────────────────┐                          ┌──────────────────┐                                  ┌─────────────────────────────┐
│ opencode TUI    │                          │  ~/.claude-go/   │                                  │  OpenCode Go Console        │
│ + opencode-go   │                          │  proxy.log       │                                  │  https://opencode.ai/auth   │
└─────────────────┘                          └──────────────────┘                                  └─────────────────────────────┘
```

### Why a Proxy is Needed

| Problem | Fix |
|---|---|
| Claude Desktop speaks **Anthropic API** (`POST /v1/messages` with `tools` as `input_schema`) | Proxy translates to **OpenAI-compatible** (`POST /chat/completions` or `/responses`) |
| `deepseek-v4-flash` rejects Anthropic `tools[].input_schema` (400) | Proxy rewrites tools to `type: function / parameters` |
| **Muse Spark 1.3** does **not** use `/chat/completions` — it requires **`/responses`** (`@ai-sdk/openai`) per [opencode.ai/docs/go#endpoints](https://opencode.ai/docs/go/#endpoints) | Proxy detects `muse-spark` → `UPSTREAM.pathname + "/responses"` with `input` instead of `messages` |
| Claude Desktop validates `inferenceModels` — non-Anthropic names like `opencode-go/muse-spark...` are **removed** (`is not an Anthropic model`) | Proxy returns **valid** `claude-sonnet-4-5` in `GET /v1/models` and maps it → `muse-spark-1.3-contributor` upstream |
| Muse Spark spends ~265 reasoning tokens even for `hi` → `max_tokens: 100` → `incomplete` | Proxy defaults `max_output_tokens = 4096` if not set |

### Detailed Setup (macOS)

#### 1. Prerequisites

```bash
brew install node
# Claude Desktop installed in /Applications/Claude.app
# OpenCode Go subscription → https://opencode.ai/auth → copy API key (sk-...)
# API key used in this guide: sk-XYRZ... (replace with yours)
```

#### 2. How `claude-go` Works (Reference)

The existing `claude-go` CLI (for **Claude Code**, not Desktop) is our blueprint:

```bash
# ~/.local/bin/claude-go
export CLAUDE_CONFIG_DIR="$HOME/.claude-go"
export ANTHROPIC_BASE_URL="http://127.0.0.1:8765"
export ANTHROPIC_API_KEY="sk-Jk1693..."
export CLAUDE_GO_KEY="sk-Jk1693..."   # upstream key for opencode.ai
export ANTHROPIC_MODEL="ox-alpha-free"
# starts proxy if not listening, then: exec claude --model ox-alpha-free "$@"
```

`~/.claude-go/proxy.mjs` (Node):
- `GET /v1/models` → returns `ox-alpha-free`
- `POST /v1/messages` → `anToOpenAI()` → `POST https://opencode.ai/zen/go/v1/chat/completions` → `oaiToAn()` (SSE streaming supported)

We adapted this proxy for **Claude Desktop**.

#### 3. Enable Claude Desktop 3P Gateway

On macOS, 3P config lives in **`Claude-3p`**, not `Claude`:

```
~/Library/Application Support/Claude-3p/configLibrary/_meta.json
~/Library/Application Support/Claude-3p/configLibrary/<uuid>.json
```

Inspect the real app to find the keys (we reverse-engineered `app.asar`):

- `inferenceProvider: "gateway"`
- `inferenceGatewayBaseUrl`
- `inferenceGatewayApiKey`
- `inferenceGatewayAuthScheme: "bearer"`
- `modelDiscoveryEnabled`
- `inferenceModels`

Create them:

```bash
uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')
mkdir -p ~/Library/Application\ Support/Claude-3p/configLibrary
cat > ~/Library/Application\ Support/Claude-3p/configLibrary/_meta.json <<EOF
{ "appliedId": "$uuid" }
EOF
cat > ~/Library/Application\ Support/Claude-3p/configLibrary/$uuid.json <<'EOF'
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8765",
  "inferenceGatewayApiKey": "sk-XYRZ6ePAoJpJSL6uGepREn00dgfjDgafZsSvYXClHth9ja13xHX9MyogYAT8HcNr",
  "inferenceGatewayAuthScheme": "bearer",
  "inferenceCredentialKind": "static",
  "modelDiscoveryEnabled": false,
  "inferenceModels": ["claude-sonnet-4-5", "claude-opus-4-5"]
}
EOF
```

> **Why `claude-sonnet-4-5` and not `muse-spark-1.3`?** Desktop's validator removes non-Anthropic names (`is not an Anthropic model`). We return a valid `claude-*` from the proxy and map it upstream.

#### 4. Fix the Proxy for Muse Spark (`/responses`)

Original proxy always used `/chat/completions` → Muse Spark returns `500 Internal server error`. Per docs, Muse Spark requires `/responses`:

```js
// BEFORE (broken for Muse Spark)
const preq = https.request({ path: UPSTREAM.pathname + "/chat/completions" })

// AFTER
const isMuseSpark = upstreamModel.startsWith("muse-spark");
const upstreamPath = isMuseSpark ? UPSTREAM.pathname + "/responses" : UPSTREAM.pathname + "/chat/completions";

// For /responses, build OpenAI Responses payload, not Chat:
if (isMuseSpark) {
  oaiBody = {
    model: upstreamModel,          // e.g. muse-spark-1.3-contributor
    input: parts.join("\n\n"),    // "user: hi\nassistant: ..."
    stream: false,
    max_output_tokens: parsed.max_tokens || 4096,
    tools: parsed.tools?.map(t => ({
      type: "function", name: t.name, description: t.description, parameters: t.input_schema
    }))
  };
} else {
  oaiBody = anToOpenAI({...parsed, model: upstreamModel});
}
```

And return valid models:

```js
if (req.url.startsWith("/v1/models")) {
  res.end(JSON.stringify({ data: [
    { id: "claude-sonnet-4-5", object: "model", display_name: "muse-spark-1.3 (via opencode-go)" },
    { id: "claude-opus-4-5",   object: "model", display_name: "muse-spark-1.3 (via opencode-go)" }
  ]}));
}
```

Post handler must also translate **responses** output (`output: [{type:"message", content:[{type:"output_text", text:"..."}]}, {type:"reasoning"}]`) back to Anthropic `content: [{type:"text", text:"..."}]` and handle `function_call`.

Full patched `proxy.mjs` is in [`proxy.mjs`](./proxy.mjs) (or copy from `~/.claude-go/proxy.mjs` after patch).

#### 5. Run the Proxy

```bash
# kill old
pkill -f "proxy.mjs"
# start with YOUR Go key
nohup env CLAUDE_GO_KEY="sk-XYRZ6ePAoJpJSL6uGepREn00dgfjDgafZsSvYXClHth9ja13xHX9MyogYAT8HcNr" \
  node ~/.claude-go/proxy.mjs >> ~/.claude-go/proxy.log 2>&1 &
curl -s http://127.0.0.1:8765/v1/models
# → {"data":[{"id":"claude-sonnet-4-5",...}]}
```

Test via proxy (should return Muse Spark):

```bash
curl -s -X POST http://127.0.0.1:8765/v1/messages \
  -H "Content-Type: application/json" -H "x-api-key: test" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":1000,"messages":[{"role":"user","content":"hi"}]}' | jq
# → {"type":"message","content":[{"type":"text","text":"Hi! I'm Muse Spark..."}]}
```

Direct upstream test (bypassing proxy, for debugging):

```bash
curl -s https://opencode.ai/zen/go/v1/responses \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"muse-spark-1.3-contributor","input":"user: hi","max_output_tokens":1000}' | jq
```

> **Gotcha:** `max_output_tokens: 100` → `status: incomplete` (Muse Spark spends ~265 reasoning tokens). Use ≥1000.

#### 6. Add opencode as MCP (optional, for tool use)

Claude Desktop can call opencode's tools via MCP:

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
// and also ~/Library/Application Support/Claude-3p/claude_desktop_config.json
{
  "mcpServers": {
    "opencode-go": {
      "command": "npx",
      "args": ["-y", "opencode-mcp"],
      "env": {}
    }
  }
}
```

Verify:

```bash
tail -f ~/Library/Logs/Claude-3p/mcp.log
# → [opencode-go] Server started and connected successfully
```

#### 7. Restart & Verify

```bash
pkill -x Claude; open -a Claude
tail -f ~/Library/Logs/Claude-3p/main.log | grep custom-3p
# → [custom-3p] inference apiHost=http://127.0.0.1:8765
# → [custom-3p] ConfigHealth { state: 'healthy' }   # was 'unreachable' / 'no usable models' before
tail -f ~/.claude-go/proxy.log
# → GET /v1/models, POST /v1/messages model=claude-sonnet-4-5 -> upstream=muse-spark-1.3 ... 200
```

Pick `claude-sonnet-4-5` in the model picker — behind the scenes it's Muse Spark 1.3.

### Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Gateway /v1/models was unreachable: net::ERR_NAME_NOT_RESOLVED` | `inferenceGatewayBaseUrl` is placeholder `https://llm-gateway.example.com` | Set to `http://127.0.0.1:8765` and ensure proxy is running (`lsof -i :8765`) |
| `Gateway returned no usable models. Add entries under Models` | `inferenceModels` contains `opencode-go/...` which is filtered out | Use valid `claude-sonnet-4-5` and map in proxy |
| `Connection refused` on `127.0.0.1:4096` | Pointed to opencode web (4096) not proxy (8765) | Use `8765` |
| `500 Internal server error` for Muse Spark | Used `/chat/completions` instead of `/responses` | Patch proxy to use `/responses` for `muse-spark*` |
| `max_output_tokens` incomplete | Muse Spark needs ~300 reasoning tokens | Default to `4096` if not set |
| `is not an Anthropic model` warning | `inferenceModels` contains `muse-spark...` | Use `claude-sonnet-4-5` and map upstream |

### Endpoints Reference (from opencode.ai/docs/go)

| Model | Model ID | Endpoint |
|---|---|---|
| Muse Spark 1.3 | `muse-spark-1.3-contributor` | `https://opencode.ai/zen/go/v1/responses` |
| DeepSeek V4 Flash | `deepseek-v4-flash` | `.../v1/chat/completions` |
| GLM-5.3 | `glm-5.3` | `.../v1/chat/completions` |
| ... | ... | ... |

Full list: `curl https://opencode.ai/zen/go/v1/models -H "Authorization: Bearer sk-..." | jq`

---

<a id="türkçe"></a>
## 🇹🇷 Türkçe — Sistem Nasıl Çalışıyor

### Özet

Bu repo, **Claude Desktop** içinde **Muse Spark 1.3 Contributor**'ı (OpenCode Go'nun ücretsiz Contributor programı) **macOS**'ta nasıl çalıştırdığımızı adım adım anlatır. Claude Desktop normalde custom model desteklemez — macOS'ta **3P (third-party) modu** ile `~/Library/Application Support/Claude-3p/configLibrary/` altındaki dosyalardan konfigüre edilir. Önüne küçük bir Node proxy (`~/.claude-go/proxy.mjs`) koyarak Anthropic → OpenAI çevirisi yapıyoruz; Muse Spark için özel durum var.

Mimari diyagram ve tablo yukarıdaki İngilizce bölümle aynı — proxy `8765`'te dinler, Claude Desktop `http://127.0.0.1:8765`'e Anthropic formatında atar, proxy `https://opencode.ai/zen/go/v1/responses`'a OpenAI Responses formatında forward eder.

### Neden Proxy Gerekiyor?

- Claude Desktop **Anthropic API** konuşur (`POST /v1/messages`, `tools[].input_schema`)
- `deepseek-v4-flash` Anthropic tool formatını reddeder (400)
- **Muse Spark 1.3** `.../chat/completions` değil **`.../responses`** ister (`@ai-sdk/openai`) — dökümanda böyle. Proxy hep `chat/completions`'a atarsa `500 Internal server error` döner.
- `inferenceModels`'a `opencode-go/muse-spark...` yazarsan Desktop validasyondan silinir (`is not an Anthropic model`). Proxy `GET /v1/models`'ta valid bir `claude-sonnet-4-5` döndürüp arkada `muse-spark-1.3`'e map'ler.
- Muse Spark basit `hi` için bile ~265 reasoning token harcar → `max_tokens: 100` → `incomplete`. Proxy default `4096` yapar.

### Adım Adım Kurulum (macOS)

**1. Gereksinimler** — yukarıdaki İngilizce ile aynı.

**2. `claude-go`'nun mantığı** — `~/.local/bin/claude-go` script'i `ANTHROPIC_BASE_URL=http://127.0.0.1:8765` set edip `proxy.mjs`'i ayağa kaldırır, sonra `claude --model ox-alpha-free` çalıştırır. Biz bunu Desktop için uyarladık.

**3. Claude Desktop 3P Gateway'i aktif et** — dosyalar `Claude` değil **`Claude-3p`** altında. UUID ile `_meta.json` ve `<uuid>.json` oluştur (yukarıdaki İngilizce koddakiyle aynı). Kritik nokta: `inferenceModels: ["claude-sonnet-4-5"]` gibi valid bir isim kullan, `muse-spark...` yazma.

**4. Proxy'yi Muse Spark için düzelt** — `proxy.mjs`'te:

```js
// GET /v1/models artık valid dönsün
{ id: "claude-sonnet-4-5", display_name: "muse-spark-1.3 (via opencode-go)" }

// POST'ta muse-spark ise /responses kullan
const isMuseSpark = upstreamModel.startsWith("muse-spark");
const upstreamPath = isMuseSpark ? "/responses" : "/chat/completions";
// input formatı ve tools'u responses API'ına göre çevir
```

Tam yama için bu repodaki [`proxy.mjs`](./proxy.mjs)'e bak.

**5. Proxy'yi çalıştır** — `CLAUDE_GO_KEY`'i kendi Go key'inle (`sk-...`) export edip `node ~/.claude-go/proxy.mjs` başlat, `curl http://127.0.0.1:8765/v1/models` ile test et.

**6. opencode MCP ekle (opsiyonel)** — `claude_desktop_config.json`'a `opencode-go: npx -y opencode-mcp` ekle. `~/Library/Logs/Claude-3p/mcp.log`'da `Server started and connected successfully` görmen lazım.

**7. Yeniden başlat ve doğrula** — `pkill -x Claude; open -a Claude`, loglarda `[custom-3p] ConfigHealth { state: 'healthy' }` görmelisin (önce `unreachable` idi). Model picker'da `claude-sonnet-4-5` seç, arkada Muse Spark çalışacak.

### Sık Hatalar

Tablodaki İngilizce troubleshooting ile aynı — `ERR_NAME_NOT_RESOLVED` → baseUrl yanlış, `no usable models` → `muse-spark` ismini direkt yazma, `500` → `/responses` kullan, `max_output_tokens` → 100 yetmez.

---

<a id="hazır-prompt--ready-prompt"></a>
## 🤖 Hazır Prompt / Ready Prompt

AI'ya tek seferde kurdurmak için kopyala-yapıştır:

### Türkçe Prompt

```
Sen uzman bir mühendissin. macOS'ta Claude Desktop'u Opencode Go üzerinden Muse Spark 1.3 Contributor kullanacak şekilde custom endpoint ile kur.

Gereksinimler:
- Claude Desktop 3P modu: ~/Library/Application Support/Claude-3p/configLibrary/_meta.json ve <uuid>.json oluştur.
  inferenceProvider=gateway, inferenceGatewayBaseUrl=http://127.0.0.1:8765, inferenceGatewayApiKey=sk-..., modelDiscoveryEnabled=false, inferenceModels=["claude-sonnet-4-5"]
  Neden claude-sonnet-4-5? Çünkü Desktop muse-spark ismini validasyonda siliyor, proxy'de map'leyeceğiz.
- Proxy: ~/.claude-go/proxy.mjs'yi düzelt. GET /v1/models valid claude-sonnet-4-5 dönsün.
  POST /v1/messages'ta claude-* gelirse upstreamModel=muse-spark-1.3-contributor yap ve isMuseSpark ise upstreamPath=/responses kullan, input formatına çevir, tools'u responses API formatına (type:function, name, description, parameters) çevir, max_output_tokens default 4096 yap. Normal modellerde anToOpenAI ile /chat/completions kullanmaya devam et. Response'ta output[].content’ten text ve function_call’ları Anthropic content'e çevir.
- Proxy'yi CLAUDE_GO_KEY=sk-... ile 8765'te ayağa kaldır, curl ile test et.
- Claude Desktop config'e opencode-go MCP ekle: npx -y opencode-mcp
- Sonra pkill -x Claude; open -a Claude ve logları kontrol et: [custom-3p] healthy olmalı.

Döküman: https://opencode.ai/docs/go/#endpoints — Muse Spark için endpoint /responses, diğerleri /chat/completions.
Doğrulama: curl http://127.0.0.1:8765/v1/models ve curl POST /v1/messages ile "Hi I'm Muse Spark" dönmeli.
```

### English Prompt

```
You are an expert engineer. Set up Claude Desktop on macOS to use Muse Spark 1.3 Contributor via OpenCode Go custom endpoint.

Requirements:
- Claude Desktop 3P mode: create ~/Library/Application Support/Claude-3p/configLibrary/_meta.json and <uuid>.json with
  inferenceProvider=gateway, inferenceGatewayBaseUrl=http://127.0.0.1:8765, inferenceGatewayApiKey=sk-..., modelDiscoveryEnabled=false, inferenceModels=["claude-sonnet-4-5"]
  Why claude-sonnet-4-5? Desktop validator removes non-Anthropic names like opencode-go/muse-spark, so return a valid claude-* from the proxy and map upstream.
- Proxy: patch ~/.claude-go/proxy.mjs. GET /v1/models must return valid claude-sonnet-4-5. In POST /v1/messages, if upstreamModel starts with muse-spark, use upstreamPath=/responses (not /chat/completions), convert Anthropic messages+system+tools to Responses API input/tools format, default max_output_tokens=4096, and translate responses output (output[].content output_text + function_call) back to Anthropic content. Otherwise use existing anToOpenAI + /chat/completions.
- Start proxy on 8765 with CLAUDE_GO_KEY=sk-... and verify with curl.
- Add opencode-go MCP to Claude Desktop: npx -y opencode-mcp in claude_desktop_config.json (both Claude and Claude-3p).
- Restart: pkill -x Claude; open -a Claude and check logs: [custom-3p] healthy, proxy GET /v1/models 200.

Docs: https://opencode.ai/docs/go/#endpoints — Muse Spark uses /responses, others use /chat/completions.
Verify: curl http://127.0.0.1:8765/v1/models and POST /v1/messages should return "Hi I'm Muse Spark".
```

---

## 📁 Files in this repo

- `README.md` — this file (bilingual)
- `proxy.mjs` — patched proxy (copy to `~/.claude-go/proxy.mjs`)
- `PROMPT.md` — ready prompts standalone
- `LICENSE` — MIT

## License

MIT — do what you want, no warranty. API keys are yours, never commit them.

## Credits

- [OpenCode Go](https://opencode.ai/docs/go/) — $10/mo Go subscription, Zen API
- [Anthropic Claude Desktop](https://claude.ai) — 3P gateway is undocumented, reverse-engineered from `app.asar`
- Proxy originally from `claude-go` (local translation proxy for `deepseek-v4-flash` tool format)

---

> PRs welcome — especially if you add support for `muse-spark-1.2`, `glm-5.3`, `kimi-k3`, etc. via the same pattern.
