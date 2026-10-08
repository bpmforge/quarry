# Integration guide

How to consume Quarry (`@bpmforge/quarry`) from your other projects (Jarvis, claude-experts, bpm-opencode-experts, ai-daytrader, …). Three integration modes ordered by ease.

## 1. CLI (works from anywhere)

Easiest. Subprocess from any language. Always-fresh JSON. After `npm run build`, run `node dist/cli.js`, or `npm link` to put the `quarry` bin (aliases `bpm-pull`, `playwright-search`) on your PATH.

```bash
# Search only (top 10 per engine, all four engines; one entry per engine run, not deduplicated)
quarry "your query" --json

# Search + fetch + extract (enrichment pipeline)
quarry "your query" --enrich --enrich-top 5 --headless --json
```

Output for `--enrich --json`:

```json
[
  {
    "rank": 1,
    "engines": ["ddg", "brave", "bing"],
    "title": "...",
    "url": "https://...",
    "snippet": "...",
    "fetched": {
      "url": "...", "finalUrl": "...", "status": 200,
      "contentType": "text/html", "fetchedAt": "2026-04-27T...",
      "cached": false,
      "fetch": { "url": "...", "html": "<full html>", ... },
      "extract": {
        "title": "...", "byline": "...", "siteName": "...",
        "excerpt": "...", "textContent": "<plain text>",
        "contentHtml": "<readability html>", "paywalled": false
      }
    }
  }
]
```

**Use this when:** the consuming code is in a different language (Python, Go, Rust) or you want zero coupling.

## 2. Library (Node/TypeScript projects)

Import directly. No subprocess overhead, full type safety.

```ts
import { searchAndFetch, search, searchAll } from "@bpmforge/quarry";

// Highest-level: search + fetch + extract in one call
const enriched = await searchAndFetch("rust async runtime", {
  engines: ["ddg", "brave", "bing"],
  top: 10,
  enrichTop: 5,
  headless: true,
  concurrency: 3,
  fetchOpts: { useCache: true, respectRobots: true, ttlMs: 24 * 60 * 60 * 1000 },
});

for (const r of enriched) {
  console.log(r.rank, r.title, r.url);
  console.log(r.engines.join(", "));      // which engines surfaced this
  console.log(r.fetched.extract?.textContent);  // full article text
}

// Lower-level if you only want search results (no fetch)
const ddgOnly = await search("rust async", "ddg", { top: 5 });
```

For Jarvis/claude-experts (already npm-based) this is the cleanest path. The package is not on npm; clone it next to your project, run `npm install && npm run build` there (the package resolves to `dist/`, which is not committed), then add to `package.json`:

```json
{ "dependencies": { "@bpmforge/quarry": "file:../quarry" } }
```

## 3. MCP (built — see [MCP.md](./MCP.md))

The `quarry-mcp` binary (alias `playwright-search-mcp`) speaks the standard MCP stdio protocol. Five tools:

```
tools:
  - web_research(query, top?, engines?, max_chars_per_source?, relevance_query?, headless?)
  - web_search(query, limit?, engines?, headless?)
  - web_fetch(url, max_chars?, no_cache?, relevance_query?)
  - web_search_pullmd(query, limit?)
  - web_research_pullmd(query, top?, max_chars_per_source?, relevance_query?)
```

This is the path for opencode + Claude Code: register the MCP server in `opencode.json` or `.mcp.json`, every agent in the project gets the tools as native function calls — no subprocess plumbing. See `MCP.md` for setup commands and config snippets.

## 4. HTTP API (not yet built)

Sketch for projects that can't speak MCP:

```
POST /search          {query, engines, top}                    → SearchResult[]
POST /search-fetch    {query, engines, top, enrichTop}         → EnrichedResult[]
POST /fetch           {url}                                    → FetchResult
GET  /cache/:hash                                              → cached entry
GET  /healthz
```

Build only if you find a host that needs it.

## How each existing project consumes this

### bpm-opencode-experts → all agents
The MCP is registered in `examples/opencode.json`. Every agent in the project (researcher, coding-agent, security-auditor, api-designer, etc.) can call all five tools — see `agents/shared/RESEARCH_TOOLS.md` for the shared reference doc agents read at runtime.

The researcher agent uses these tools by default and runs an iterative loop (pass 1 broad → pass 2+ refined). Other agents reach for them on demand: e.g., security-auditor for CVE lookups, coding-agent before adopting a new library, api-designer for current REST/GraphQL standards.

### claude-experts → researcher agent
Native `WebSearch`/`WebFetch` remain the default in Claude Code. The MCP is optional — register it via `.mcp.json` or `~/.claude.json` if you want multi-engine, paragraph-ranked, cached research. The researcher agent's prompt documents the choice.

### Jarvis → research-director / chat agent
Already Node. Use the **library** path:

```ts
// In src/services/research.service.ts (or wherever)
import { searchAndFetch } from "@bpmforge/quarry";

export async function deepResearch(query: string) {
  const sources = await searchAndFetch(query, {
    engines: ["ddg", "brave", "bing"],
    top: 10,
    enrichTop: 5,
    headless: true,
  });
  return sources.map((s) => ({
    title: s.title,
    url: s.url,
    sourceType: "web" as const,
    text: s.fetched.extract?.textContent ?? s.snippet,
    siteName: s.fetched.extract?.siteName ?? "",
    extractedAt: s.fetched.fetchedAt,
  }));
}
```

This replaces / augments the existing playbook-based research path. Cached pages mean repeated queries cost nothing.

### ai-daytrader / vulnforge / kryptkeeper
On-demand. Library when Node, CLI otherwise.

## Operational notes for downstream consumers

- **First run is slow** (8–30s for full enrichment of 5 pages). **Cached runs are fast** (<2s). Show a progress indicator or stream results.
- **Cache lives at** `~/.playwright-search/cache/<first 2 hex chars>/<sha1 of url>.json`. Wipe it with `rm -rf ~/.playwright-search/cache`.
- **Profile lives at** `~/.playwright-search/profile/`. Persistent Chromium profile — DON'T delete unless you want to lose accumulated cookies/consent state.
- **Headless caveats:** Google still trips a captcha headless. Use `--headless` only with `--engines ddg,brave,bing`, OR run headed (default) to also get Google.
- **Rate limits are process-local.** Two parallel processes won't share cooldowns. If you need shared rate limit, lift `domainLimit.ts` state into Redis/SQLite (step 3 candidate).
- **Paywall results** still come back, with `fetched.extract.paywalled = true`. Downstream code should usually skip these or fall back to `snippet`.
- **Robots-blocked URLs** come back with `fetched.skipped = "robots"` and no extract. We're polite by default; pass `respectRobots: false` to override (don't).

## What downstream code should do with the output

For LLM context windows, format like this:

```
[Source 1: <title> — <siteName> — <url>]
<extract.textContent>

[Source 2: ...]
...
```

That keeps source attribution clean and makes hallucination guards easier downstream. Trim each `textContent` to ~3000 chars unless you need long-form. For a research summary, 5 sources × 3k chars = 15k tokens, very digestible.
