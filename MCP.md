# MCP server (opencode + Claude Code + any MCP host)

The `quarry-mcp` binary (alias `playwright-search-mcp`; both run `dist/mcp.js`) exposes five tools over the standard MCP stdio protocol — usable by opencode, Claude Code, Cursor, Continue, or any other MCP-compatible host. Works with any LLM behind those hosts (LM Studio, Ollama, Anthropic, OpenAI, …).

## Tools exposed

| Tool | Inputs | Returns |
|------|--------|---------|
| `web_research` | `query`, `top` (1–20, default 3), `engines` (default `["ddg","brave","bing"]`), `max_chars_per_source` (500–12000, default 3000), `relevance_query` (optional), `headless` (default true) | Formatted text with `[Source N: title — site — url]` markers; **paragraph-ranked by relevance**: returns the BEST paragraphs matching the query, not the first N chars |
| `web_search` | `query`, `limit` (1–20, default 10), `engines`, `headless` | Numbered list of titles + URLs + snippets, deduped across engines |
| `web_fetch` | `url`, `max_chars` (500–12000, default 8000), `no_cache`, `relevance_query` (optional) | Header (title/byline/site/url) + extracted main article text. With `relevance_query`, returns the BEST paragraphs for that query. |
| `web_search_pullmd` | `query`, `limit` (1–30, default 10) | Numbered list of titles + URLs + snippets from DDG + Brave + Bing (headless, fixed engine set), ranked by Reciprocal Rank Fusion |
| `web_research_pullmd` | `query`, `top` (1–10, default 3), `max_chars_per_source` (500–12000, default 3000), `relevance_query` (optional) | `[Source N]` blocks like `web_research`. Content comes from the zero-dep pull (`src/bpm-pull.ts`); a pull under 500 chars, or a URL with a site-API adapter, goes through `fetchAndExtract` instead. Each source is tagged `fetch: pull`, `direct fetch`, `<adapter> api` or `snippet only` |

The `_pullmd` names are kept for compatibility; they no longer depend on the external pullmd service (removed in v0.3.0).

**Architecture:** HTTP-first. Search engines are queried via plain `fetch()` + jsdom parse first — no browser launch. Browser (Playwright headless Chromium) is only invoked as fallback when the HTTP path is blocked by something a browser would help with (and not, e.g., by a Proof-of-Work captcha that a browser can't solve either). Page content never uses the browser: `fetchAndExtract` tries a site-API adapter (Wikipedia, arXiv, Stack Exchange, GitHub, npm), then a plain HTTP fetch + Mozilla Readability. A 3-source `web_research` call typically returns in ~15–25s on cold cache, near-instant on warm cache.

## Why these specific tools

**`web_research` is the recommended primary** — local LLMs are much better at making one well-formed tool call than chaining `search → fetch → fetch → fetch`. One call, formatted output, citations baked in.

`web_search` and `web_fetch` exist for power-user flows where the agent wants to triage URLs first or has a known URL it wants to read.

The tool descriptions also carry a suggested tier order for researcher agents: `web_search_pullmd` first, `web_research_pullmd` for full content, `web_research` only if that returns fewer than 2 useful sources.

## Build + run

```bash
git clone https://github.com/bpmforge/quarry.git
cd quarry
npm install
npm run build
# Then one of:
node dist/mcp.js                      # production entry (used by opencode.json)
npm run mcp                           # dev (tsx, no build needed)
npm run mcp:start                     # production (built)
```

Verify it works:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node dist/mcp.js
```

You should see the `tools/list` response with all five tools.

## Register in opencode

Add to your project's `opencode.json` (replace `/path/to/quarry` with your clone; the `playwright-search` key is the server name existing integrations use — any name works):

```json
{
  "mcp": {
    "playwright-search": {
      "type": "local",
      "command": ["node", "/path/to/quarry/dist/mcp.js"],
      "enabled": true
    }
  }
}
```

For dev (no build step needed), use tsx:

```json
"command": ["npx", "tsx", "/path/to/quarry/src/mcp.ts"]
```

opencode is **LLM-agnostic** — once registered, the same tools work whether you're running LM Studio (Qwen, Gemma, Nemotron), Ollama, Anthropic API, or OpenAI.

## Register in Claude Code

Project-level: add `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "playwright-search": {
      "command": "node",
      "args": ["/path/to/quarry/dist/mcp.js"]
    }
  }
}
```

User-level (all projects): add to `~/.claude.json` or via `claude mcp add playwright-search node /path/to/quarry/dist/mcp.js`.

## Recommended pairing: register the memory MCP alongside

To close the **search → research → remember** loop, register both this MCP and a memory MCP (`claude-memory` or `mempalace`). The agent uses `web_research` for findings, then `memory_store` / `fact_store` to persist them with the source URL.

```json
{
  "mcp": {
    "playwright-search": { ... },
    "claude-memory": {
      "type": "local",
      "command": ["node", "/path/to/claude-memory/mcp/memory-server/dist/index.js"],
      "enabled": true
    }
  }
}
```

The researcher agent prompts in both `bpm-opencode-experts/agents/researcher.md` and `claude-experts/agents/researcher.md` are already updated to expect this surface.

## Local-LLM tuning

- **Token budget**: default `max_chars_per_source=3000` per source × 3 sources ≈ 9k tokens of context. Comfortable for a 45k budget. Drop to 1500 for tight budgets, raise to 6000 for premium-context models.
- **Engine selection**: `["ddg","brave","bing"]` is the default. Brave may serve a Proof-of-Work captcha to repeated callers; the adapter detects this and skips the browser fallback (since browser hits the same challenge). Google is excluded by default — add it only if you're OK with frequent captcha aborts.
- **Caching**: 24h disk cache at `~/.playwright-search/cache/` — repeat queries within a day are zero-cost. Pass `no_cache: true` on `web_fetch` if you need fresh.
- **Per-engine timeout**: 20s. If an engine hangs, others continue.
- **Progress notifications**: the server emits `notifications/progress` during long calls so MCP clients (opencode, Claude Code) can keep the request alive past their default request timeout.
- **Response shape**: all tools return one `text` content block — no JSON-in-JSON, no nested structures. Friendlier for smaller models.

## Operational notes

- Server runs over stdio; no network port to manage.
- One MCP process per host (opencode/Claude Code spawns it on demand and pipes stdin/stdout).
- Per-engine persistent Chromium profiles under `~/.playwright-search/profile/{ddg,brave,bing,google}/` so engines can run concurrently without serializing on a single profile dir lock. Cookies and consent persist per engine.
- On the `fetchAndExtract` path (`web_research`, `web_fetch`, and `web_research_pullmd`'s fallback), per-domain page-fetch rate limiting (1.2–2.5s) + robots.txt respect are unconditional — no flag to disable in MCP mode (CLI has `--no-robots` for emergencies; MCP doesn't expose it on purpose). Site-API adapter requests are not gated on robots.txt. `web_research_pullmd`'s fast pull (`src/bpm-pull.ts`) paces per host (1.5s default) and checks robots.txt with the same `canFetch` check, on every redirect hop; a disallowed page is not fetched and falls through to `fetchAndExtract`, which reports it as skipped for robots. URLs with a site-API adapter skip the fast pull entirely.
- **All agents in a project see these tools.** Once `playwright-search` is in your `opencode.json` `mcp` block, every agent in that project can call all five tools — not just a designated researcher agent. Whether each agent is *aware of* the tools depends on its system prompt; see `bpm-opencode-experts/agents/shared/RESEARCH_TOOLS.md` for the shared reference doc agents read at runtime.
