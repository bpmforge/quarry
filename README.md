# Quarry

**Agent-grade web retrieval.** Human-paced multi-engine search + zero-dep fetch→clean-markdown extraction. Self-hosted, free, polite, local — no third-party scraping API (no Firecrawl/Jina/Tavily dependency). HTTP-first: search engines are queried over plain HTTP and fall back to Playwright only when that path is blocked; page content comes from the site's own API where Quarry has an adapter, else a plain HTTP fetch + Readability.

A quarry is both what you hunt for and the raw material you extract and refine — this fetches the pages your agent is after and refines them to clean markdown. Companion to **Lodestone** (code retrieval); Quarry is retrieval over the open web.

- Query → top-N results from DuckDuckGo, Brave, Bing (Google opt-in)
- Each result URL → readable extraction → clean text/markdown → 24h disk cache
- Site-API adapters for Wikipedia, arXiv, Stack Exchange, GitHub repos and npm packages — used instead of scraping their HTML
- Paragraph-level relevance ranking (BM25-lite) — returns the BEST paragraphs matching your query
- Three entry points: library (`@bpmforge/quarry`), CLI (`quarry`), MCP (`quarry-mcp`, five tools: `web_research`, `web_search`, `web_fetch`, `web_search_pullmd`, `web_research_pullmd`)

> **Naming / compatibility:** the product is **Quarry** (npm `@bpmforge/quarry`, repo `bpmforge/quarry`). The `bpm-pull` command and the `playwright-search` MCP server name remain as **aliases** so existing bpmforge integrations (expert system, amplifier) keep working unchanged.

For consuming this from opencode, Claude Code, Jarvis, claude-experts, bpm-opencode-experts, etc. see [`INTEGRATION.md`](./INTEGRATION.md) and [`MCP.md`](./MCP.md).

## Architecture

**HTTP-first, browser as fallback.** Search engines are queried via plain `fetch()` + jsdom parse first — no Chromium boot. Browser is used only when the HTTP path is blocked by something a browser would actually help with (i.e., not a Proof-of-Work captcha that hits both equally).

- ~15–25s for a 3-source `web_research` call on cold cache
- Sub-second on warm cache
- 7 fingerprint patches in `src/stealth.ts` for the browser fallback path

## Engine status

| Engine  | HTTP-first | Browser fallback | Notes |
|---------|-----------|------------------|-------|
| DDG     | ✓ via `html.duckduckgo.com` | ✓ | Most reliable — html endpoint is no-JS-friendly |
| Bing    | ✓ via `bing.com/search?q=` | ✓ | URLs unwrapped from `bing.com/ck/a?u=a1<base64>` redirects |
| Brave   | ⚠ POW captcha possible | skipped on POW | When Brave shows Proof-of-Work, browser hits same challenge — adapter fails fast instead of hanging |
| Google  | ⚠ unusual-traffic page possible | only if HTTP fail isn't unrecoverable | Best to leave out unless you accept frequent aborts |

## Install

Not published to npm — install from source:

```bash
git clone https://github.com/bpmforge/quarry.git
cd quarry
npm install
npm run build   # emits dist/ (cli.js, mcp.js, index.js)
```

`npm install` runs `playwright install chromium` (postinstall). Requires Node ≥ 20.

## CLI

```bash
# All four engines, top 10, headed (default — most human-like)
npm run search -- "rust async runtime comparison"

# Only the engines that work headless, top 5
npm run search -- "wcag 2.2" --engines ddg,brave,bing -n 5 --headless

# JSON output for piping
npm run search -- "claude api caching" --json --headless > out.json
```

After `npm run build`, the same CLI is `node dist/cli.js` (installed as the `quarry` bin; `bpm-pull` and `playwright-search` are aliases).

Flags: `-e/--engines <list>`, `-n/--top <N>`, `--json`, `--headless`, `--debug`, `-h/--help`.

Engines try plain HTTP first and launch Chromium only when that fails. The browser is headed by default; `--headless` hides it, and `--debug` forces it visible even when `--headless` is also given.

### Enrichment (search + fetch + extract)

```bash
# Search, dedup across engines, fetch top 5, extract article content
npm run search -- "playwright stealth fingerprint" --engines ddg,brave,bing --top 5 --headless --enrich --enrich-top 4 --json
```

With `--json`, returns a list per result with `{rank, engines, title, url, snippet, fetched: {extract: {textContent, byline, siteName, paywalled, …}}}`; without `--json` it prints a human-readable summary.

Enrichment flags:
- `--enrich` — turn on the fetch+extract pipeline
- `--enrich-top <N>` — only enrich top N after dedup (default: `--top`)
- `--concurrency <N>` — parallel fetches (default 3)
- `--no-cache` — skip the 24h disk cache at `~/.playwright-search/cache/`
- `--no-robots` — skip robots.txt checks (impolite — default respects robots)

## Library

```ts
import { searchAll, search } from "./src/index.js";

const runs = await searchAll("playwright stealth 2026", {
  engines: ["ddg", "brave", "bing"],
  top: 10,
  headless: true,
});
for (const r of runs) console.log(r.engine, r.ok ? r.results.length : r.error);

// Single engine
const ddg = await search("playwright stealth", "ddg", { top: 5 });
```

## How it stays under the radar (step 1)

- Persistent Chromium profile under `~/.playwright-search/profile/` — cookies and consent state carry between runs
- Real recent macOS Chrome user-agent + matching locale/timezone/viewport
- 7 fingerprint patches (`src/stealth.ts`): `navigator.webdriver`, plugins/mimeTypes, full `window.chrome` (incl. `loadTimes`/`csi`), permissions query, WebGL vendor/renderer, languages, iframe `contentWindow`
- `--disable-blink-features=AutomationControlled` + drop `--enable-automation`
- Human typing (55–175ms per char with 5% chance of 180–420ms pause), random pre-submit delay, scroll + mouse moves before extraction
- Per-engine cooldown (DDG 6s, Brave 7s, Bing 9s, Google 12s) + 0–2s jitter; `searchAll` runs engines in parallel, staggering each start by 0.2–0.8s
- Headed by default. `--headless` is best-effort: DDG, Brave, Bing reliable; Google trips captcha

## Result shape

```ts
{
  engine: "ddg" | "brave" | "bing" | "google",
  rank: 1..N,
  title: string,
  url: string,        // already unwrapped from engine redirects
  snippet: string,
  fetchedAt: ISO8601 string
}
```

## What's NOT here yet

- Captcha solving (Google headless aborts cleanly)
- Proxy rotation / IP-pool support
- API server / scheduler
- Golden-HTML fixture tests for the SERP parsers (unit tests cover fusion, ranking, robots, decoders, extraction, paywall detection, cache and source adapters)

Cross-engine dedup/merge is done — `src/fuse.ts` ranks by Reciprocal Rank Fusion.

## Layout

```
src/
  types.ts           # SearchResult, EngineAdapter, options
  stealth.ts         # 7 fingerprint patches via addInitScript
  browser.ts         # launchPersistentContext factory
  human.ts           # humanType, humanScroll, humanMoveMouse, jitter
  rateLimit.ts       # per-engine cooldown
  decoders.ts        # unwrap Bing / DDG redirect URLs
  fuse.ts            # cross-engine dedup + Reciprocal Rank Fusion
  pipeline.ts        # searchAndFetch (search → fuse → fetch → extract)
  bpm-pull.ts        # zero-dep url → markdown pull (used by the *_pullmd tools)
  index.ts           # library entry: searchAll, search, searchAndFetch, fetchAndExtract, extract
  cli.ts             # CLI bin entry
  mcp.ts             # MCP stdio server (five tools)
  engines/
    http.ts          # shared plain-HTTP SERP fetch + jsdom parse
    http-configs.ts  # per-engine HTTP URL / parser / block detection
    ddg.ts           # html.duckduckgo.com over HTTP; browser fallback
    brave.ts         # fails fast on Proof-of-Work
    bing.ts          # unwraps /ck/a?u=a1<base64> redirects
    google.ts        # direct /search URL; captcha-aware
  fetch/
    fetcher.ts       # fetchAndExtract: cache → source API → robots → HTTP → Readability
    cache.ts         # 24h disk cache
    robots.ts        # robots.txt parse + check
    domainLimit.ts   # per-domain pacing + failure blacklist
  extract/
    readability.ts   # Mozilla Readability wrapper
    rank.ts          # BM25-lite paragraph ranking
    paywall.ts       # paywall detection
  sources/           # site-API adapters: wikipedia, arxiv, stackexchange, github, npm
tests/               # vitest unit tests (npm test)
```

## Tradeoffs / known gaps

- **Headless Google**: needs proper TLS fingerprint masking (e.g. `curl-impersonate`-style or undetected fork) — out of scope for step 1.
- **DDG headless**: only the `html.duckduckgo.com` path works; the React UI 418s headless Chromium even with stealth patches. Headed mode uses the React UI normally.
- **Brave snippets**: selectors track current Svelte build (`.title.search-snippet-title`, `.generic-snippet .content`); will need re-targeting if Brave reskins the SERP.
- **Bing snippet truncation**: Bing serves "…" truncated snippets; we don't expand them.
- **Rate limit is process-local**: `lastCall` is in-memory, so multiple parallel processes won't share cooldowns. Move to a file/Redis lock for step 2 if needed.

## License

MIT. See [LICENSE](LICENSE).
