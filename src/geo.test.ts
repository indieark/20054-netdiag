/*
 * Copyright (C) 2026 IndieArk
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { geoIpAnySource, tertiaryGeo } from "./geo.js";
import { clearPublicApiCache } from "./http.js";

/**
 * These cover the failure behaviour that matters in production: our host cannot reach the first two
 * geo providers, so a single-source lookup returned 502 while a working source sat unused. The
 * lookup must survive losing providers, and must still refuse to invent a location when all are
 * gone.
 */

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  // The upstream helper caches by URL, so state must not leak between cases.
  clearPublicApiCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("geoIpAnySource", () => {
  it("returns the first provider's answer when it works", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ipwho.is")) {
        return jsonResponse({ success: true, ip: "1.1.1.1", country: "Australia" });
      }
      throw new Error("不应查询后备数据源");
    }) as typeof fetch;

    const result = await geoIpAnySource("1.1.1.1");
    expect(result.source).toBe("ipwho.is");
    expect(result.country).toBe("Australia");
  });

  it("falls through to the next provider when the first is unreachable", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      // Mirrors production: the first provider is simply not routable from this host.
      if (url.includes("ipwho.is")) throw new TypeError("fetch failed");
      if (url.includes("api.ip.sb")) {
        return jsonResponse({ ip: "1.1.1.1", country: "Australia", isp: "Cloudflare" });
      }
      throw new Error("不应查询第三数据源");
    }) as typeof fetch;

    const result = await geoIpAnySource("1.1.1.1");
    expect(result.source).toBe("ip.sb");
  });

  it("reaches the third provider when both others are down", async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("ipwho.is") || url.includes("api.ip.sb")) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ ip: "1.1.1.1", country: "Australia", city: "South Brisbane" });
    }) as typeof fetch;

    const result = await geoIpAnySource("1.1.1.1");
    expect(result.source).toBe("ip.net.coffee");
    expect(result.city).toBe("South Brisbane");
  });

  it("fails rather than inventing a location when every provider is gone", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    // A fabricated country would be worse than an honest error.
    await expect(geoIpAnySource("1.1.1.1")).rejects.toThrow(/所有归属地数据源均不可用/);
  });

  it("rejects a private address before contacting any provider", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    await expect(geoIpAnySource("192.168.1.1")).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("tertiaryGeo", () => {
  it("refuses an answer that echoes back a different address", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ip: "8.8.8.8", country: "United States" }),
    ) as typeof fetch;

    // A source describing some other address cannot be trusted to describe the one we asked about.
    await expect(tertiaryGeo("1.1.1.1")).rejects.toThrow(/地址不匹配/);
  });

  it("omits absent fields rather than emitting empty strings", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ip: "1.1.1.1", country: "Australia", city: "", region: null }),
    ) as typeof fetch;

    const result = await tertiaryGeo("1.1.1.1");
    expect(result.country).toBe("Australia");
    // An empty string is the source giving nothing, not a place called "".
    expect(result.city).toBeUndefined();
    expect(result.region).toBeUndefined();
  });
});
