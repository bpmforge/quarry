# Changelog

All notable changes are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

Changes on `main` since the `v0.4.0` tag. Version in `package.json` is still 0.4.0.

### Added

- **Site-API source adapters** (`src/sources/`) for Wikipedia (and other Wikimedia wikis), arXiv, Stack Exchange, GitHub repos and npm packages. `fetchAndExtract` uses the site's API instead of scraping its HTML when an adapter matches, and falls back to the normal fetch path when the API declines or fails. Opt out with `useSources: false`; `FetchResult.source` names the adapter that served the content.
- **`src/fuse.ts`** — one shared cross-engine merge that ranks by Reciprocal Rank Fusion, replacing three drifted dedupe copies in `pipeline.ts`, `mcp.ts` and `pullmd-serp.ts`.

### Changed

- `web_search_pullmd` / `web_research_pullmd` now get SERP results from the engine adapters (DDG, Brave, Bing; HTTP-first, browser fallback). Google is no longer in that engine set.
- Extracted text keeps paragraph breaks (derived from the article HTML rather than Readability's flattened `textContent`), so BM25 paragraph ranking actually selects paragraphs instead of head-truncating.
- `web_research_pullmd` labels a thin-pull retry `fetch: direct fetch` (was `playwright fallback`; that path never used Playwright).

### Fixed

- Ranking now uses each engine's own result position. Before, a single-engine result at #10 could outrank another engine's #1.
- URL dedup no longer lowercases the path, and `/x/?a=1` and `/x?a=1` now merge.
- robots.txt: only the group naming us, or the `*` group, applies. Before, every crawler's group applied, so Wikipedia's `Disallow: /` for MJ12bot blocked every Wikipedia article. End-anchored rules (`/*.pdf$`) now match.
- `bpm-pull` keeps protocol-relative links (`//host/path`).
- CLI `--debug` now does what its help says: it forces a visible browser, overriding `--headless`. It was parsed and then ignored.
- `web_research_pullmd`'s fast pull (`src/bpm-pull.ts`) now checks robots.txt before every page fetch and redirect hop, as `fetchAndExtract` already did. It skipped the check before.

### Removed

- `src/pullmd-serp.ts`, the markdown-scraping SERP layer. It returned 0 results.

## [0.4.0] — 2026-07-16

**Renamed to Quarry** — promoted from an infra utility to a named bpmforge product. npm package is now `@bpmforge/quarry` (was `playwright-search`, never published), repo `bpmforge/quarry`. Positioning: agent-grade self-hosted web retrieval (multi-engine search + fetch→clean-markdown), a companion to Lodestone (code retrieval). New `quarry` / `quarry-mcp` bins. **`bpm-pull`, `playwright-search`, and `playwright-search-mcp` bins retained as aliases**, and the `playwright-search` MCP server name is unchanged, so existing integrations (expert system, amplifier) keep working with no migration. No behavior change.

## [0.3.0] — 2026-07-14

Dropped the external **pullmd Docker service** dependency. `web_search_pullmd` / `web_research_pullmd` and all URL fetching now run on our **own zero-dep pull** (`src/bpm-pull.ts`, vendored from bpm-agent-amplifier's `bpm-pull.mjs`: fetch → strip → density-scored main-content extraction → HTML→markdown), no `localhost:33000` required. SERP result-page fetching tries the fast no-browser pull first and **falls back to the native Playwright multi-engine search** (`serpWithFallback`) when an engine blocks plain fetch (Cloudflare/JS); content fetching keeps its existing pull→Playwright fallback. Tool names unchanged for compatibility. `pullmd-serp.ts`'s external HTTP client removed. New `tests/bpm-pull.test.ts` (7 cases) covers the transform pipeline. Verified live with the external service down: content fetch works, SERP returns 30 results across DDG/Brave/Bing via fallback.

## [0.2.0] — 2026-05-04

Tiered research architecture — two new pullmd-backed tools that let the researcher start fast (no browser) and escalate to Playwright only when needed.

### Added

- **`src/pullmd-serp.ts`** — SERP parser for four engines (DDG HTML, Mojeek, Brave, Startpage) fetched via pullmd MCP at `localhost:33000`. Exports `pullmdSearch(query, limit)` which runs all four engines in parallel, deduplicates by URL, and ranks by engine-agreement score. Exports `pullmdReadUrl(url)` for direct page fetches via the same SSE MCP transport.
- **`web_search_pullmd` tool** — Tier 1. SERP-only, no browser. Queries DDG + Mojeek + Brave + Startpage simultaneously via pullmd. Returns titles/URLs/snippets ranked by engine agreement (~5-10s). Use first to triage candidate URLs before fetching full content.
- **`web_research_pullmd` tool** — Tier 2. SERP + full-page fetch via pullmd + BM25 paragraph ranking. Automatically falls back to Playwright (`fetchAndExtract`) for any URL where pullmd returns < 500 chars (JS-heavy SPAs, auth walls, Cloudflare). Each source annotated `fetch: pullmd` or `fetch: playwright fallback`. Escalate to `web_research` only if this returns < 2 useful sources.

### Changed

- **Tool descriptions** — all five tools now carry tier labels and prescriptive "when to use" guidance so the researcher agent cannot rationalize skipping a tier. `web_research` and `web_fetch` descriptions updated to position them as escalation paths, not defaults.

### Research tier order (mandatory)

| Tier | Tool | When |
|------|------|------|
| 1 | `web_search_pullmd` | Every new topic — always start here |
| 2 | `web_research_pullmd` | When full content is needed |
| 3 | `web_research` | Only if tier 2 returns < 2 useful sources |
| 4 | `web_fetch` / `web_search` | Single known URL or Playwright-only SERP |

## [0.1.0] — 2026-05-03

Initial release: human-paced multi-engine search + page extraction via Playwright.

### Added

- **`web_research` tool** — multi-engine SERP (DDG + Brave + Bing + Google) → dedup → Playwright fetch → Mozilla Readability extract → BM25 paragraph ranking → `[Source N]` blocks.
- **`web_search` tool** — SERP-only across DDG + Brave + Bing, returns titles/URLs/snippets.
- **`web_fetch` tool** — single URL fetch via Playwright + Readability + 24h disk cache + optional BM25 ranking with `relevance_query`.
- Per-domain rate limiting, robots.txt respect, stealth Chromium launch.
- HTTP-first architecture: pullmd MCP client (`pullmdReadUrl`) for non-browser fetches.
