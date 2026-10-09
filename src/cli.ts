#!/usr/bin/env node
import { searchAll, type EngineId } from "./index.js";
import { searchAndFetch, type EnrichedResult } from "./pipeline.js";

interface Args {
  query: string;
  engines: EngineId[];
  top: number;
  json: boolean;
  debug: boolean;
  headless: boolean;
  enrich: boolean;
  enrichTop: number;
  noCache: boolean;
  noRobots: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    query: "",
    engines: ["ddg", "brave", "bing", "google"],
    top: 10,
    json: false,
    debug: false,
    headless: false,
    enrich: false,
    enrichTop: 0,
    noCache: false,
    noRobots: false,
    concurrency: 3,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--engines" || a === "-e") {
      const next = argv[++i];
      if (!next) throw new Error("--engines requires a value");
      args.engines = next.split(",").map((s) => s.trim()) as EngineId[];
    } else if (a === "--top" || a === "-n") {
      const next = argv[++i];
      if (!next) throw new Error("--top requires a value");
      args.top = parseInt(next, 10);
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "--debug") {
      args.debug = true;
    } else if (a === "--headless") {
      args.headless = true;
    } else if (a === "--enrich") {
      args.enrich = true;
    } else if (a === "--enrich-top") {
      const next = argv[++i];
      if (!next) throw new Error("--enrich-top requires a value");
      args.enrichTop = parseInt(next, 10);
    } else if (a === "--no-cache") {
      args.noCache = true;
    } else if (a === "--no-robots") {
      args.noRobots = true;
    } else if (a === "--concurrency") {
      const next = argv[++i];
      if (!next) throw new Error("--concurrency requires a value");
      args.concurrency = parseInt(next, 10);
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  // --debug forces a visible browser even alongside --headless. Without
  // either flag the browser is already headed.
  if (args.debug) args.headless = false;
  args.query = positional.join(" ");
  if (!args.query) {
    printHelp();
    process.exit(1);
  }
  return args;
}

function printHelp(): void {
  console.log(`quarry — multi-engine human-paced web search + page extraction
(also installed as bpm-pull and playwright-search)

Usage:
  quarry "your query" [options]

Search options:
  -e, --engines <list>   Comma-separated: ddg,brave,bing,google (default: all)
  -n, --top <N>          Top N results per engine (default: 10)
      --headless         Run Chromium headless (default: headed)
      --debug            Force a visible (headed) browser; overrides --headless
  -h, --help             Show this help

Output:
      --json             Emit JSON (default: human-readable text)

Enrichment (fetch + extract page content with Mozilla Readability):
      --enrich           Fetch each result URL and extract main content
      --enrich-top <N>   Only enrich top N (after dedup); default: --top
      --concurrency <N>  Parallel page fetches (default: 3)
      --no-cache         Skip the 24h disk cache at ~/.playwright-search/cache/
      --no-robots        Skip robots.txt checks (impolite — default: respect robots)

Examples:
  quarry "rust async runtime"
  quarry "wcag 2.2 changes" --engines ddg,brave -n 5 --headless
  quarry "claude api caching" --enrich --enrich-top 5 --headless --json > out.json
`);
}

function formatHuman(runs: Awaited<ReturnType<typeof searchAll>>): string {
  const out: string[] = [];
  for (const run of runs) {
    out.push(
      `\n=== ${run.engine.toUpperCase()} (${run.ok ? "ok" : "FAIL"}, ${run.durationMs}ms) ===`,
    );
    if (!run.ok) {
      out.push(`  ! ${run.error}`);
      continue;
    }
    if (run.results.length === 0) {
      out.push("  (no results)");
      continue;
    }
    for (const r of run.results) {
      out.push(`  ${String(r.rank).padStart(2, " ")}. ${r.title}`);
      out.push(`      ${r.url}`);
      if (r.snippet) {
        const s =
          r.snippet.length > 220 ? r.snippet.slice(0, 217) + "..." : r.snippet;
        out.push(`      ${s}`);
      }
    }
  }
  return out.join("\n");
}

function formatEnriched(rows: EnrichedResult[]): string {
  const out: string[] = [];
  for (const r of rows) {
    out.push(`\n[${r.rank}] ${r.title}`);
    out.push(`    url:     ${r.url}`);
    out.push(`    engines: ${r.engines.join(", ")}`);
    if (r.snippet) {
      const s =
        r.snippet.length > 200 ? r.snippet.slice(0, 197) + "..." : r.snippet;
      out.push(`    snippet: ${s}`);
    }
    const f = r.fetched;
    if (f.skipped) {
      out.push(`    fetch:   skipped (${f.skipped})`);
    } else if (f.error) {
      out.push(`    fetch:   error (${f.error})`);
    } else if (f.extract) {
      const tag = [
        f.cached ? "cached" : "fresh",
        `${f.extract.textContent.length} chars`,
        f.extract.paywalled ? "paywalled" : null,
      ]
        .filter(Boolean)
        .join(", ");
      out.push(`    fetch:   ok (${tag})`);
      if (f.extract.byline) out.push(`    byline:  ${f.extract.byline}`);
      if (f.extract.siteName) out.push(`    site:    ${f.extract.siteName}`);
      const preview = f.extract.textContent
        .slice(0, 280)
        .replace(/\s+/g, " ")
        .trim();
      if (preview)
        out.push(
          `    preview: ${preview}${f.extract.textContent.length > 280 ? "…" : ""}`,
        );
    } else {
      out.push(`    fetch:   no extractable content (status ${f.status})`);
    }
  }
  return out.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.enrich) {
    const rows = await searchAndFetch(args.query, {
      engines: args.engines,
      top: args.top,
      enrichTop: args.enrichTop || args.top,
      headless: args.headless,
      debug: args.debug,
      concurrency: args.concurrency,
      fetchOpts: {
        useCache: !args.noCache,
        respectRobots: !args.noRobots,
      },
    });
    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      process.stdout.write(formatEnriched(rows) + "\n");
    }
    return;
  }

  const runs = await searchAll(args.query, {
    engines: args.engines,
    top: args.top,
    debug: args.debug,
    headless: args.headless,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
  } else {
    process.stdout.write(formatHuman(runs) + "\n");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
