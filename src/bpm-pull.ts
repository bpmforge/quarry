// bpm-pull.ts — SELF-CONTAINED url -> clean markdown. Zero deps.
//
// Vendored from bpm-agent-amplifier/scripts/bpm-pull.mjs (our own fetch->extract->markdown
// method) to REPLACE the external pullmd Docker service (AeternaLabsHQ, localhost:33000).
// Pipeline: fetch -> strip boilerplate -> density-scored main-content extraction -> own
// HTML->MD. Zero external services, zero npm deps.
//
// This is the CONTENT fetcher only. SERP parsing lives in engines/http-configs.ts (jsdom over
// real HTML); a second markdown-parsing SERP layer that sat here was removed — it returned 0
// results because inline() dropped protocol-relative hrefs.
//
// Known limitation (same as the source): JS-rendered SPAs and Cloudflare-challenged pages return
// thin content — callers must fall back to the Playwright fetcher (fetchAndExtract) for those.
// pullToMarkdown() returns "" on failure so those callers degrade rather than throwing.

import { canFetch } from "./fetch/robots.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const MAX_BYTES = 5 * 1024 * 1024; // 5MB guard
export const DEFAULT_PACE_MS = 1500;
export const HOST_PACE_MS: Record<string, number> = {
  "www.reddit.com": 12000,
  "www.youtube.com": 3000,
};

const lastFetchAt = new Map<string, number>(); // hostname -> ms of last fetch start

// Sleep until at least the per-host pace has elapsed since the previous fetch to this host.
export async function paceFor(
  hostname: string,
  now = Date.now(),
): Promise<void> {
  const pace = HOST_PACE_MS[hostname] ?? DEFAULT_PACE_MS;
  const last = lastFetchAt.get(hostname) ?? 0;
  const wait = pace - (now - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetchAt.set(hostname, Date.now());
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

// Paced, robots-checked, size-guarded fetch. Returns raw bytes + Content-Type (decode is a
// separate step). Every redirect hop is checked against its own host's robots.txt, because
// an allowed URL can redirect into a disallowed one.
export async function get(
  url: string,
  redirects = 5,
  opts: { respectRobots?: boolean } = {},
): Promise<{ buf: Buffer; contentType: string }> {
  const respectRobots = opts.respectRobots ?? true;
  if (respectRobots && !(await canFetch(url)))
    throw new RobotsDisallowedError(url);
  await paceFor(new URL(url).hostname);
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "manual",
  });
  if ([301, 302, 307, 308].includes(res.status) && redirects > 0) {
    const loc = res.headers.get("location");
    if (loc) return get(new URL(loc, url).href, redirects - 1, opts);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  const declaredLen = Number(res.headers.get("content-length") || 0);
  if (declaredLen > MAX_BYTES)
    throw new Error(
      `response too large: Content-Length ${declaredLen} exceeds ${MAX_BYTES}-byte cap for ${url}`,
    );
  if (!res.body) throw new Error(`no response body for ${url}`);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          `response exceeded ${MAX_BYTES}-byte cap while streaming ${url}`,
        );
      }
      chunks.push(value);
    }
  }
  return {
    buf: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    contentType: res.headers.get("content-type") || "",
  };
}

// charset sniff: HTTP Content-Type > <meta charset> > <meta http-equiv> > utf-8.
export function sniffCharset(buf: Buffer, contentType = ""): string {
  const headerMatch = /charset=([\w-]+)/i.exec(contentType);
  if (headerMatch) return headerMatch[1]!.toLowerCase();
  const head = buf.subarray(0, 2048).toString("latin1");
  const metaCharset = /<meta\s+charset=["']?([\w-]+)/i.exec(head);
  if (metaCharset) return metaCharset[1]!.toLowerCase();
  const metaHttpEquiv =
    /<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([\w-]+)/i.exec(
      head,
    );
  if (metaHttpEquiv) return metaHttpEquiv[1]!.toLowerCase();
  return "utf-8";
}

export function decodeBody(buf: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};
export const decode = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(\w+);/g, (m, e) => entities[e] ?? m);

export function stripBoilerplate(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|svg|iframe|form|template)[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<(nav|footer|aside|header)[\s\S]*?<\/\1>/gi, "");
}

// Density-scored main-content extraction — our own readability heuristic, no libraries.
export function extractMain(html: string): string {
  const candidates: { score: number; inner: string; textLen: number }[] = [];
  const re = /<(article|main|section|div)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const inner = m[2]!;
    const text = inner.replace(/<[^>]+>/g, " ");
    const textLen = text.replace(/\s+/g, " ").trim().length;
    if (textLen < 250) continue;
    const tags = (inner.match(/<[a-z]/gi) || []).length || 1;
    const linkText = (inner.match(/<a\b[^>]*>([\s\S]*?)<\/a>/gi) || [])
      .join(" ")
      .replace(/<[^>]+>/g, "").length;
    const linkDensity = linkText / (textLen + 1);
    const tag = m[1]!.toLowerCase();
    const score =
      (textLen / tags) *
      (1 - Math.min(linkDensity, 0.9)) *
      (tag === "article" ? 2 : tag === "main" ? 1.6 : 1);
    candidates.push({ score, inner, textLen });
  }
  if (!candidates.length) return html;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.inner;
}

export function inline(s: string): string {
  return decode(
    s
      .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => {
        const text = t.replace(/<[^>]+>/g, "").trim();
        if (!text) return text;
        // Protocol-relative hrefs (//host/path) are links too — the old
        // startsWith("http") guard silently flattened them to plain text, which
        // dropped every outbound link on pages that use them (DDG's SERP is 50/51).
        const href = h.startsWith("//") ? `https:${h}` : h;
        return href.startsWith("http") ? `[${text}](${href})` : text;
      })
      .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
      .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<img\b[^>]*alt="([^"]*)"[^>]*>/gi, "[img: $1]")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]{2,}/g, " "),
  ).trim();
}

export function toMarkdown(html: string): string {
  let s = html;
  s = s.replace(
    /<pre\b[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, c) => "\n```\n" + decode(c.replace(/<[^>]+>/g, "")).trim() + "\n```\n",
  );
  s = s.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, n, c) => `\n${"#".repeat(Number(n))} ${inline(c)}\n`,
  );
  s = s.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, c) => {
    let i = 0;
    return (
      "\n" +
      c.replace(
        /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
        (_: string, li: string) =>
          `${tag.toLowerCase() === "ol" ? `${++i}.` : "-"} ${inline(li)}\n`,
      ) +
      "\n"
    );
  });
  s = s.replace(
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, c) =>
      "\n" +
      inline(c)
        .split("\n")
        .map((l: string) => `> ${l}`)
        .join("\n") +
      "\n",
  );
  s = s.replace(
    /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi,
    (_, r) =>
      "| " +
      [...r.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
        .map((c) => inline((c as RegExpMatchArray)[1]!))
        .join(" | ") +
      " |\n",
  );
  s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_, c) => `\n${inline(c)}\n`);
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = inline(s);
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The public entry point: url -> clean markdown via our own pull. `raw` skips main-content
// extraction, keeping every link on the page. robots.txt is respected unless the caller
// opts out, matching fetchAndExtract's default.
export async function pull(
  url: string,
  opts: { raw?: boolean; respectRobots?: boolean } = {},
): Promise<string> {
  const { buf, contentType } = await get(url, 5, {
    respectRobots: opts.respectRobots,
  });
  const charset = sniffCharset(buf, contentType);
  const html = stripBoilerplate(decodeBody(buf, charset));
  return toMarkdown(opts.raw ? html : extractMain(html));
}

/**
 * `pull` that degrades to "" instead of throwing. Callers treat empty as "thin
 * content" and fall back to the Playwright fetcher, so a Cloudflare-blocked or
 * JS-only page becomes a fallback rather than a hard failure. A robots-disallowed
 * URL also comes back "", and the fallback (fetchAndExtract) then reports it as
 * skipped for robots.
 */
export async function pullToMarkdown(
  url: string,
  opts: { raw?: boolean; respectRobots?: boolean } = {},
): Promise<string> {
  try {
    return await pull(url, opts);
  } catch {
    return "";
  }
}
