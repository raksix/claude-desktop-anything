# Hazır Promptlar / Ready Prompts

Bu dosyayı AI'ya direkt yapıştırarak tüm kurulumu otomatik yaptırabilirsin.

---

## 🇹🇷 Türkçe — Tek Seferlik Kurulum Promptu

```
Sen uzman bir mühendissin. macOS'ta Claude Desktop'u Opencode Go üzerinden Muse Spark 1.3 Contributor kullanacak şekilde custom endpoint ile kur.

Gereksinimler:
- Claude Desktop 3P modu: ~/Library/Application Support/Claude-3p/configLibrary/_meta.json ve <uuid>.json oluştur.
  inferenceProvider=gateway, inferenceGatewayBaseUrl=http://127.0.0.1:8765, inferenceGatewayApiKey=sk-..., modelDiscoveryEnabled=false, inferenceModels=["claude-sonnet-4-5"]
  Neden claude-sonnet-4-5? Çünkü Desktop muse-spark ismini validasyonda siliyor, proxy'de map'leyeceğiz.
- Proxy: ~/.claude-go/proxy.mjs'yi düzelt. GET /v1/models valid claude-sonnet-4-5 dönsün.
  POST /v1/messages'ta claude-* gelirse upstreamModel=muse-spark-1.3-contributor yap ve isMuseSpark ise upstreamPath=/responses kullan, input formatına çevir, tools'u responses API formatına (type:function, name, description, parameters) çevir, max_output_tokens default 4096 yap. Normal modellerde anToOpenAI ile /chat/completions kullanmaya devam et. Response'ta output[].content’ten text ve function_call’ları Anthropic content'e çevir.
- Proxy'yi CLAUDE_GO_KEY=sk-... ile 8765'te ayağa kaldır, curl ile test et.
- Claude Desktop config'e opencode-go MCP ekle: npx -y opencode-mcp (hem Claude hem Claude-3p claude_desktop_config.json'a).
- Sonra pkill -x Claude; open -a Claude ve logları kontrol et: [custom-3p] healthy olmalı.

Döküman: https://opencode.ai/docs/go/#endpoints — Muse Spark için endpoint /responses, diğerleri /chat/completions.
Doğrulama: curl http://127.0.0.1:8765/v1/models ve curl POST /v1/messages ile "Hi I'm Muse Spark" dönmeli. Başarısız olursa loglara bak: ~/.claude-go/proxy.log ve ~/Library/Logs/Claude-3p/main.log
```

## 🇬🇧 English — One-Shot Setup Prompt

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
Verify: curl http://127.0.0.1:8765/v1/models and POST /v1/messages should return "Hi I'm Muse Spark". If it fails, check logs: ~/.claude-go/proxy.log and ~/Library/Logs/Claude-3p/main.log
```

---

## Kullanım / Usage

1. API key'ini al: https://opencode.ai/auth → Go subscription → `sk-...`
2. Yukarıdaki promptu ChatGPT / Claude / Gemini'ye yapıştır, `sk-...` yerine kendi key'ini koy
3. AI tüm dosyaları oluşturup proxy'yi yamalıcak, sen sadece `open -a Claude` ile test edeceksin

## Notlar / Notes

- Muse Spark 500 verirse `max_output_tokens` 100 yetmez, en az 1000-4096 olmalı (reasoning 265 token harcıyor)
- `opencode-go/muse-spark-1.3-contributor` ismini direkt `inferenceModels`'a yazma — validasyonda silinir, `claude-sonnet-4-5` yaz ve proxy'de map'le
- Farklı model istersen (ör. `deepseek-v4-flash`, `glm-5.3`) proxy'de `upstreamModel`'i değiştirmen yeterli
