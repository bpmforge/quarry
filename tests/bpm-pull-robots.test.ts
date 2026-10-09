import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pull, pullToMarkdown, RobotsDisallowedError } from "../src/bpm-pull.js";
import { resetForTests } from "../src/fetch/robots.js";

// The fast pull path behind web_research_pullmd must obey robots.txt like
// fetchAndExtract does. fetch is mocked: no network. Each test uses its own host
// so the per-host pacing in bpm-pull never sleeps between tests.

const ARTICLE = `<html><body><article><p>${"Allowed page body text. ".repeat(20)}</p></article></body></html>`;

function mockSite(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const robots = (body: string) => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
const html = (body: string) => () =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

beforeEach(() => resetForTests());
afterEach(() => vi.unstubAllGlobals());

describe("bpm-pull: robots.txt", () => {
  it("refuses a disallowed URL without fetching the page", async () => {
    const calls = mockSite({
      "https://deny.test/robots.txt": robots("User-agent: *\nDisallow: /private\n"),
      "https://deny.test/private/page": html(ARTICLE),
    });
    await expect(pull("https://deny.test/private/page")).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );
    expect(calls).toEqual(["https://deny.test/robots.txt"]);
  });

  it("pullToMarkdown degrades a disallowed URL to empty (so the caller falls back)", async () => {
    const calls = mockSite({
      "https://deny2.test/robots.txt": robots("User-agent: *\nDisallow: /\n"),
      "https://deny2.test/a": html(ARTICLE),
    });
    expect(await pullToMarkdown("https://deny2.test/a")).toBe("");
    expect(calls).not.toContain("https://deny2.test/a");
  });

  it("fetches an allowed URL", async () => {
    mockSite({
      "https://allow.test/robots.txt": robots("User-agent: *\nDisallow: /private\n"),
      "https://allow.test/public": html(ARTICLE),
    });
    expect(await pull("https://allow.test/public")).toContain("Allowed page body text.");
  });

  it("checks robots.txt again on every redirect hop", async () => {
    const calls = mockSite({
      "https://hop.test/robots.txt": robots("User-agent: *\nAllow: /\n"),
      "https://hop.test/go": () =>
        new Response(null, { status: 302, headers: { location: "https://denyhop.test/x" } }),
      "https://denyhop.test/robots.txt": robots("User-agent: *\nDisallow: /x\n"),
      "https://denyhop.test/x": html(ARTICLE),
    });
    await expect(pull("https://hop.test/go")).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls).not.toContain("https://denyhop.test/x");
  });

  it("skips the check only when the caller opts out", async () => {
    const calls = mockSite({
      "https://optout.test/robots.txt": robots("User-agent: *\nDisallow: /\n"),
      "https://optout.test/a": html(ARTICLE),
    });
    expect(await pull("https://optout.test/a", { respectRobots: false })).toContain(
      "Allowed page body text.",
    );
    expect(calls).toEqual(["https://optout.test/a"]);
  });
});
