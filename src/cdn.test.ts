/*
 * Copyright (C) 2026 IndieArk
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CDN_PROVIDERS, clearCdnCache, probeAllCdn, probeCdn, probeCdnByName } from "./cdn.js";

/**
 * The failure paths matter most here: a vendor that does not publish a node header, and one that is
 * unreachable, are both ordinary results rather than errors. Reporting either as a CDN outage would
 * be a fabricated fault, and throwing would take down the whole sweep.
 */

const originalFetch = globalThis.fetch;

function headResponse(headers: Record<string, string>): Response {
  return new Response(null, { status: 200, headers });
}

beforeEach(() => {
  clearCdnCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("probeCdn", () => {
  const cloudflare = CDN_PROVIDERS.find((p) => p.name === "Cloudflare");
  const cloudfront = CDN_PROVIDERS.find((p) => p.name === "AWS CloudFront");
  const edgeone = CDN_PROVIDERS.find((p) => p.name === "Tencent EdgeOne Static");
  const bunny = CDN_PROVIDERS.find((p) => p.name === "Bunny Standard");

  it("reads the colo code out of a Cloudflare trace body", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("fl=123\nh=x\ncolo=HKG\nloc=HK\n", { status: 200 }),
    ) as typeof fetch;

    const result = await probeCdn(cloudflare!);
    expect(result).toMatchObject({ ok: true, node: "HKG" });
  });

  it("reads the node identifier from a response header", async () => {
    globalThis.fetch = vi.fn(async () =>
      headResponse({ "x-amz-cf-pop": "NRT57-C1" }),
    ) as typeof fetch;

    const result = await probeCdn(cloudfront!);
    expect(result).toMatchObject({ ok: true, node: "x-amz-cf-pop: NRT57-C1" });
  });

  it("decodes EdgeOne's base64 node identifier", async () => {
    globalThis.fetch = vi.fn(async () =>
      headResponse({ xcc: Buffer.from("SH-Edge-1", "utf8").toString("base64") }),
    ) as typeof fetch;

    const result = await probeCdn(edgeone!);
    expect(result).toMatchObject({ ok: true, node: "xcc: SH-Edge-1" });
  });

  it("ignores a `server` header that does not name a Bunny node", async () => {
    // `server: nginx` is the web server's name, not an edge node; reporting it would be wrong.
    globalThis.fetch = vi.fn(async () => headResponse({ server: "nginx" })) as typeof fetch;

    const result = await probeCdn(bunny!);
    expect(result).toMatchObject({ ok: false, reason: "该端点未返回节点标识头" });
  });

  it("accepts a `server` header that does name a Bunny node", async () => {
    globalThis.fetch = vi.fn(async () =>
      headResponse({ server: "BunnyCDN-DE1-1034" }),
    ) as typeof fetch;

    const result = await probeCdn(bunny!);
    expect(result).toMatchObject({ ok: true });
  });

  it("reports an unreachable vendor as a result, not an exception", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const result = await probeCdn(cloudfront!);
    expect(result).toMatchObject({ ok: false, reason: "请求失败或被阻断" });
  });

  it("distinguishes a timeout from an outright failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }) as typeof fetch;

    const result = await probeCdn(cloudfront!);
    expect(result).toMatchObject({ ok: false, reason: "请求超时" });
  });

  it("rejects an HTML body masquerading as a node identifier", async () => {
    // An error page or captcha interstitial is not a node code.
    globalThis.fetch = vi.fn(
      async () => new Response("<html><body>blocked</body></html>", { status: 200 }),
    ) as typeof fetch;

    const result = await probeCdn(cloudflare!);
    expect(result).toMatchObject({ ok: false, reason: "未返回有效节点标识" });
  });

  it("reports a non-2xx trace response with its status", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 403 })) as typeof fetch;

    const result = await probeCdn(cloudflare!);
    expect(result).toMatchObject({ ok: false, reason: "响应 403" });
  });
});

describe("probeAllCdn", () => {
  it("returns one row per provider, in catalogue order", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("cdn-cgi/trace")) return new Response("colo=HKG\n", { status: 200 });
      return headResponse({ "x-amz-cf-pop": "NRT57" });
    }) as typeof fetch;

    const results = await probeAllCdn();
    expect(results).toHaveLength(CDN_PROVIDERS.length);
    // Order must match the catalogue so the board's two columns align row for row.
    expect(results.map((r) => r.name)).toEqual(CDN_PROVIDERS.map((p) => p.name));
  });

  it("survives a provider failing without losing the others", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("cloudfront")) throw new TypeError("fetch failed");
      return new Response("colo=HKG\n", { status: 200 });
    }) as typeof fetch;

    const results = await probeAllCdn();
    expect(results).toHaveLength(CDN_PROVIDERS.length);
    expect(results.find((r) => r.name === "AWS CloudFront")).toMatchObject({ ok: false });
  });

  it("serves a second call from cache rather than re-probing", async () => {
    const spy = vi.fn(async () => new Response("colo=HKG\n", { status: 200 }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await probeAllCdn();
    const afterFirst = spy.mock.calls.length;
    await probeAllCdn();
    // This host's routing is the same for every visitor, so repeated loads must not re-sweep.
    expect(spy.mock.calls.length).toBe(afterFirst);
  });
});

describe("probeCdnByName", () => {
  it("rejects an unknown vendor instead of probing an arbitrary URL", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(probeCdnByName("https://internal.example/")).rejects.toThrow(/未知/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a missing name", async () => {
    await expect(probeCdnByName(undefined)).rejects.toThrow(/请指定/);
  });
});
