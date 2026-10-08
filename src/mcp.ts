#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchAndFetch, type EnrichedResult } from "./pipeline.js";
import { fetchAndExtract } from "./fetch/fetcher.js";
import { searchAll } from "./index.js";
import { rankByQuery } from "./extract/rank.js";
import { pullToMarkdown } from "./bpm-pull.js";
import { findAdapter } from "./sources/index.js";
import { fuseRuns, type FusedResult } from "./fuse.js";

const DEFAULT_MAX_CHARS = 3000;
const HARD_MAX_CHARS = 12000;

const ENGINES = ["ddg", "brave", "bing", "google"] as const;
type EngineId = (typeof ENGINES)[number];

/**
 * Engines used for SERP. Google is excluded on purpose: its HTTP path parses 0
 * results and its browser fallback is skipped on challenge, so including it only
 * bought a per-search timeout.
 */
const SERP_ENGINES: EngineId[] = ["ddg", "brave", "bing"];

/**
 * The SERP path. `searchAll`'s adapters are already HTTP-first (jsdom parse, 12s
 * timeout, block detection, redirect decoding) and only launch a browser when the
 * HTTP attempt fails — so this IS the fast path. A second hand-rolled markdown-parsing
 * SERP layer used to run in front of it; it returned 0 results and has been removed.
 */
async function serpSearch(
  query: string,
  limit: number,
): Promise<FusedResult[]> {
  const runs = await searchAll(query, {
    engines: SERP_ENGINES,
    top: Math.max(limit, 10),
    headless: true,
  });
  return fuseRuns(runs, limit);
}

function formatEnrichedAsText(
  rows: EnrichedResult[],
  maxCharsPerSource: number,
  relevanceQuery: string,
): string {
  if (rows.length === 0) return "No results found.";
  const out: string[] = [];
  for (const r of rows) {
    const fetchTag = r.fetched.skipped
      ? `skipped (${r.fetched.skipped})`
      : r.fetched.error
        ? `error (${r.fetched.error})`
        : r.fetched.extract?.paywalled
          ? "paywalled"
          : r.fetched.extract
            ? `${r.fetched.extract.textContent.length} chars${r.fetched.source ? ` via ${r.fetched.source} api` : ""}`
            : `no extract (status ${r.fetched.status})`;

    out.push(
      `[Source ${r.rank}: ${r.title || "(untitled)"} — ${r.fetched.extract?.siteName || hostname(r.url)} — ${r.url}]`,
    );
    out.push(`engines: ${r.engines.join(", ")} | fetch: ${fetchTag}`);
    if (r.fetched.extract?.byline)
      out.push(`byline: ${r.fetched.extract.byline}`);

    if (r.fetched.extract?.textContent) {
      const ranked = rankByQuery(
        r.fetched.extract.textContent,
        relevanceQuery,
        maxCharsPerSource,
      );
      out.push(
        `(top ${ranked.selectedCount} of ${ranked.totalParagraphs} paragraphs by relevance)`,
      );
      out.push(ranked.paragraphs.join("\n\n"));
    } else if (r.snippet) {
      out.push(`(snippet) ${r.snippet}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const server = new McpServer({ name: "playwright-search", version: "0.4.0" });

server.registerTool(
  "web_research",
  {
    title: "Web research (search → fetch → extract)",
    description:
      "Search the web across multiple engines, deduplicate results, fetch each page, and extract main article content. " +
      "One-call research: returns formatted text with [Source N] markers ready for LLM context. " +
      "Use this when you need full page content to answer a question, not just titles. " +
      "Polite (rate-limited per-domain, robots.txt respected, 24h cache). Free, no API keys.",
    inputSchema: {
      query: z.string().describe("The search query"),
      top: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe(
          "How many top results to return after dedup (default 3). Higher = slower; the MCP request timeout is ~60s, so top>5 may time out on cache miss.",
        ),
      engines: z
        .array(z.enum(ENGINES))
        .default(["ddg", "brave", "bing"])
        .describe(
          "Which engines to query. Google fails captcha headless — leave it out unless you need it.",
        ),
      max_chars_per_source: z
        .number()
        .int()
        .min(500)
        .max(HARD_MAX_CHARS)
        .default(DEFAULT_MAX_CHARS)
        .describe(
          `Max characters of extracted text per source (default ${DEFAULT_MAX_CHARS}, max ${HARD_MAX_CHARS}). Returns the BEST paragraphs matching the query, packed into this budget. Lower = smaller LLM context.`,
        ),
      relevance_query: z
        .string()
        .optional()
        .describe(
          "Optional refined query for paragraph relevance ranking. If omitted, uses `query`. Use this when you want broader search results but tighter content extraction (e.g., search 'rust async' but rank paragraphs by 'tokio runtime model').",
        ),
      headless: z
        .boolean()
        .default(true)
        .describe(
          "Run Chromium headless (default true). Set false to use real browser window.",
        ),
    },
  },
  async (
    { query, top, engines, max_chars_per_source, relevance_query, headless },
    extra,
  ) => {
    const token = extra?._meta?.progressToken;
    const send = (current: number, total: number, message: string) => {
      if (token === undefined) return;
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: current, total, message },
        })
        .catch(() => {});
    };

    send(0, 100, `starting research: "${query}"`);
    const rows = await searchAndFetch(query, {
      engines: engines as EngineId[],
      top: Math.max(top, 3),
      enrichTop: top,
      headless,
      concurrency: 4,
      onProgress: (e) => {
        const overall =
          e.phase === "search"
            ? Math.round((e.current / Math.max(1, e.total)) * 30)
            : 30 + Math.round((e.current / Math.max(1, e.total)) * 65);
        send(overall, 100, e.message);
      },
    });
    send(100, 100, `done — ${rows.length} sources`);
    return {
      content: [
        {
          type: "text",
          text: formatEnrichedAsText(
            rows,
            max_chars_per_source,
            relevance_query || query,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  "web_search",
  {
    title: "Web search (titles + snippets only)",
    description:
      "Fast multi-engine search returning titles, URLs, and snippets only. No page fetching. " +
      "Use this when you're orienting / triaging URLs and don't need full content. " +
      "For full content, use web_research or web_fetch.",
    inputSchema: {
      query: z.string().describe("The search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe("Total unique results to return after dedup (default 10)"),
      engines: z
        .array(z.enum(ENGINES))
        .default(["ddg", "brave", "bing"])
        .describe("Which engines to query"),
      headless: z.boolean().default(true),
    },
  },
  async ({ query, limit, engines, headless }) => {
    const runs = await searchAll(query, {
      engines: engines as EngineId[],
      top: Math.max(limit, 10),
      headless,
    });

    const top = fuseRuns(runs, limit);
    const lines: string[] = [];
    top.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}  (${r.engines.join(", ")})`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push("");
    });
    const failed = runs
      .filter((r) => !r.ok)
      .map((r) => `${r.engine}: ${r.error}`);
    if (failed.length)
      lines.push(`(engines that failed: ${failed.join("; ")})`);

    return {
      content: [
        { type: "text", text: lines.join("\n").trim() || "No results." },
      ],
    };
  },
);

server.registerTool(
  "web_fetch",
  {
    title: "Fetch + extract a single URL",
    description:
      "Fetch a URL and return its main article content via Mozilla Readability. " +
      "Use when you already have a URL (citation, doc link, search result) and want its content. " +
      "Strips nav, ads, scripts. Returns clean text. 24h cache.",
    inputSchema: {
      url: z.string().url().describe("The URL to fetch"),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(HARD_MAX_CHARS)
        .default(8000)
        .describe(
          `Max characters to return (default 8000, max ${HARD_MAX_CHARS})`,
        ),
      no_cache: z.boolean().default(false).describe("Skip the 24h disk cache"),
      relevance_query: z
        .string()
        .optional()
        .describe(
          "Optional query for paragraph relevance ranking. If set, returns the BEST paragraphs matching this query packed into max_chars. If omitted, returns the first max_chars of the article.",
        ),
    },
  },
  async ({ url, max_chars, no_cache, relevance_query }) => {
    const r = await fetchAndExtract(url, { useCache: !no_cache });
    if (r.skipped) {
      return {
        content: [{ type: "text", text: `[skipped: ${r.skipped}] ${url}` }],
        isError: true,
      };
    }
    if (r.error) {
      return {
        content: [{ type: "text", text: `[error: ${r.error}] ${url}` }],
        isError: true,
      };
    }
    if (!r.extract) {
      return {
        content: [
          {
            type: "text",
            text: `[no extractable content, status ${r.status}] ${url}`,
          },
        ],
        isError: true,
      };
    }

    const ex = r.extract;
    let body: string;
    let rankNote = "";
    if (relevance_query && relevance_query.trim().length > 0) {
      const ranked = rankByQuery(ex.textContent, relevance_query, max_chars);
      body = ranked.paragraphs.join("\n\n");
      rankNote = `\nrelevance: top ${ranked.selectedCount} of ${ranked.totalParagraphs} paragraphs for "${relevance_query}"`;
    } else {
      body =
        ex.textContent.length > max_chars
          ? ex.textContent.slice(0, max_chars).trimEnd() +
            ` …[truncated, ${ex.textContent.length - max_chars} more chars]`
          : ex.textContent;
    }
    const header =
      [
        `[${ex.title || "(untitled)"}]`,
        ex.byline ? `byline: ${ex.byline}` : null,
        ex.siteName ? `site: ${ex.siteName}` : null,
        `url: ${r.finalUrl}`,
        ex.paywalled ? "paywalled: true" : null,
        r.cached ? "cached: true" : null,
      ]
        .filter(Boolean)
        .join("\n") + rankNote;

    return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
  },
);

server.registerTool(
  "web_search_pullmd",
  {
    title: "Web search (multi-engine SERP, fast path + browser fallback)",
    description:
      "Step 1 — always start here for any new topic. " +
      "Queries DDG, Brave, and Bing over plain HTTP (no browser), falling back to a real " +
      "browser per-engine only when the HTTP attempt is blocked. " +
      "Deduplicates and ranks by Reciprocal Rank Fusion, so results several engines agree on " +
      "rise above single-engine hits. Returns titles, URLs, and snippets. " +
      "Use before web_research_pullmd to triage which URLs are worth fetching.",
    inputSchema: {
      query: z.string().describe("The search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(10)
        .describe("Total unique results to return (default 10)"),
    },
  },
  async ({ query, limit }) => {
    const results = await serpSearch(query, limit);
    if (results.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }
    const lines: string[] = [];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.url}  (${r.engines.join(", ")})`);
      if (r.snippet) lines.push(`   ${r.snippet}`);
      lines.push("");
    });
    return { content: [{ type: "text", text: lines.join("\n").trim() }] };
  },
);

server.registerTool(
  "web_research_pullmd",
  {
    title: "Web research (SERP + full-page fetch + BM25)",
    description:
      "Step 2 — full content after web_search_pullmd has identified candidate URLs. " +
      "Rank-fused multi-engine SERP + full-page fetch via our own zero-dep pull + BM25 " +
      "paragraph ranking. Any URL where the fast pull returns < 500 chars (or that has a " +
      "site-API adapter: Wikipedia, arXiv, Stack Exchange, GitHub, npm) goes through the full " +
      "fetch path instead (site API, else HTTP fetch + Readability). " +
      "Each source annotated 'fetch: pull', 'fetch: direct fetch', 'fetch: <adapter> api' or 'fetch: snippet only'. " +
      "Escalate to web_research only if this returns < 2 useful sources.",
    inputSchema: {
      query: z.string().describe("The search query"),
      top: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe("Number of top sources to fetch and extract (default 3)"),
      max_chars_per_source: z
        .number()
        .int()
        .min(500)
        .max(HARD_MAX_CHARS)
        .default(DEFAULT_MAX_CHARS)
        .describe(
          `Max characters of extracted text per source (default ${DEFAULT_MAX_CHARS})`,
        ),
      relevance_query: z
        .string()
        .optional()
        .describe(
          "Optional refined query for BM25 paragraph ranking. If omitted, uses the main query.",
        ),
    },
  },
  async ({ query, top, max_chars_per_source, relevance_query }) => {
    const rankQuery = relevance_query || query;
    const PULLMD_MIN_CHARS = 500;

    const serpResults = await serpSearch(query, top * 3);
    const candidates = serpResults.slice(0, top);

    if (candidates.length === 0) {
      return { content: [{ type: "text", text: "No results found." }] };
    }

    // Fetch all candidates via our own pull in parallel. URLs with a source adapter
    // skip it deliberately: the site's API beats anything scraped off the page, so we
    // let them fall through to fetchAndExtract, which routes through the adapter.
    const pullmdFetches = await Promise.allSettled(
      candidates.map(async (r) => ({
        result: r,
        md: findAdapter(r.url) ? "" : await pullToMarkdown(r.url),
      })),
    );

    // Anything the fast pull left thin (or skipped) goes through the full fetch path.
    const richRetries = await Promise.allSettled(
      pullmdFetches.map(async (f) => {
        if (f.status !== "fulfilled") return null;
        if (f.value.md.length >= PULLMD_MIN_CHARS) return null;
        const r = await fetchAndExtract(f.value.result.url, { useCache: true });
        return { url: f.value.result.url, extract: r };
      }),
    );

    const out: string[] = [];
    let sourceNum = 0;
    for (const [i, f] of pullmdFetches.entries()) {
      if (f.status !== "fulfilled") continue;
      const { result, md } = f.value;
      sourceNum++;

      // Prefer the full-fetch content if the fast pull was thin or was skipped.
      const retry = richRetries[i];
      const retryResult =
        retry?.status === "fulfilled" ? (retry.value?.extract ?? null) : null;
      const playwrightText = retryResult?.extract?.textContent ?? null;
      const fetchNote = retryResult?.source
        ? `${retryResult.source} api`
        : playwrightText
          ? "direct fetch"
          : md.length >= PULLMD_MIN_CHARS
            ? "pull"
            : "snippet only";

      out.push(
        `[Source ${sourceNum}: ${result.title || "(untitled)"} — ${hostname(result.url)} — ${result.url}]`,
      );
      out.push(`engines: ${result.engines.join(", ")} | fetch: ${fetchNote}`);

      const content =
        playwrightText ?? (md.length >= PULLMD_MIN_CHARS ? md : null);
      if (content) {
        const ranked = rankByQuery(content, rankQuery, max_chars_per_source);
        out.push(
          `(top ${ranked.selectedCount} of ${ranked.totalParagraphs} paragraphs by relevance)`,
        );
        out.push(ranked.paragraphs.join("\n\n"));
      } else if (result.snippet) {
        out.push(`(snippet) ${result.snippet}`);
      } else {
        out.push("(no content fetched)");
      }
      out.push("");
    }

    return {
      content: [{ type: "text", text: out.join("\n").trim() || "No results." }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[playwright-search-mcp] fatal:", err);
  process.exit(1);
});
