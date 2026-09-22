/*
 * Copyright (C) 2026 IndieArk
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { HttpError } from "./http.js";

/**
 * CDN edge-node probing.
 *
 * Each vendor reveals which point-of-presence served a request differently: Cloudflare publishes a
 * trace endpoint, most others put a machine room code in a response header. Reading it says which
 * edge location the request was routed to.
 *
 * Probing from here answers "which node serves *this server*". A browser probing the same catalogue
 * answers "which node serves *the visitor*". Both views are useful and they are not interchangeable,
 * so the catalogue is published separately from the probe: the board renders the two side by side.
 *
 * Unlike the browser, this side has no cross-origin restriction, so header-based vendors are
 * readable here even when they are opaque to a page.
 */

export interface CdnProvider {
  name: string;
  url: string;
  /** Domain for the brand icon. */
  site: string;
  /** Read the `colo=` line from a Cloudflare-style trace body. */
  trace?: boolean;
  /** The whole response body is the node identifier. */
  text?: boolean;
  /** Response headers carrying the node identifier, in preference order. */
  headers?: readonly string[];
}

/**
 * The catalogue, served to the board so the provider list has one definition rather than two.
 *
 * URLs are vendor-published test endpoints. They are fixed here rather than accepted as a parameter
 * on purpose: an arbitrary-URL probe would make this service an open proxy.
 */
export const CDN_PROVIDERS: readonly CdnProvider[] = [
  {
    name: "Cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    site: "cloudflare.com",
    trace: true,
  },
  {
    name: "Cloudflare 中国网络",
    url: "https://perfops.cloudflareperf.com/cdn-cgi/trace",
    site: "cloudflare.com",
    trace: true,
  },
  {
    name: "Fastly",
    url: "https://fastly.jsdelivr.net/npm/react@18/umd/react.production.min.js",
    site: "fastly.com",
    headers: ["x-served-by"],
  },
  {
    name: "jsDelivr",
    url: "https://cdn.jsdelivr.net/npm/latency-test@1.0.0/generate_200",
    site: "jsdelivr.com",
    headers: ["x-served-by", "cf-ray", "x-id"],
  },
  {
    name: "AWS CloudFront",
    url: "https://djlzvy5xcvhxt.cloudfront.net/500b-bench.jpg",
    site: "aws.amazon.com",
    headers: ["x-amz-cf-pop"],
  },
  {
    name: "GCP Anycast LB",
    url: "https://global.gcping.com/api/ping",
    site: "cloud.google.com",
    text: true,
  },
  {
    name: "Akamai",
    url: "https://perfopsrum.akamaized.net/500b-bench.jpg",
    site: "akamai.com",
    headers: ["x-cache2"],
  },
  {
    name: "Akamai Edge IP Binding",
    url: "https://perfopsrum-eip.akamaized.net/500b-bench.jpg",
    site: "akamai.com",
    headers: ["x-cache2"],
  },
  {
    name: "Bunny Standard",
    url: "https://test.b-cdn.net",
    site: "bunny.net",
    headers: ["server"],
  },
  {
    name: "Bunny Volume",
    url: "https://testvideo.b-cdn.net",
    site: "bunny.net",
    headers: ["server"],
  },
  {
    name: "CDN77",
    url: "https://1596384882.rsc.cdn77.org/500b-bench.jpg",
    site: "cdn77.com",
    headers: ["x-77-pop"],
  },
  {
    name: "Tencent EdgeOne Static",
    url: "https://eo-static-perfops2.qcloudcdn.com/500b-bench.jpg",
    site: "edgeone.ai",
    headers: ["xcc"],
  },
  {
    name: "CacheFly",
    url: "https://cdnperf.cachefly.net/500b-bench.jpg",
    site: "cachefly.com",
    headers: ["x-cf1"],
  },
  {
    name: "Medianova",
    url: "https://medianova-cdnvperf.mncdn.com/500b-bench.jpg",
    site: "medianova.com",
    headers: ["x-edge-location"],
  },
  {
    name: "Zenlayer",
    url: "https://test-perfops.ecn.zenlayer.net/500b-bench.jpg",
    site: "zenlayer.com",
    headers: ["via"],
  },
  {
    name: "Melbicom",
    url: "https://perfops.swiftycdn.net/500b-sw-bench.jpg",
    site: "melbicom.net",
    headers: ["x-swifty-node"],
  },
  {
    name: "网易",
    url: "https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png",
    site: "163.com",
    headers: ["cdn-source", "cdn-ip"],
  },
  {
    name: "字节跳动",
    url: "https://perfops.byte-test.com/500b-bench.jpg",
    site: "bytedance.com",
    headers: ["via"],
  },
  {
    name: "字节跳动 海外",
    url: "https://perfops2.byte-test.com/500b-bench.jpg",
    site: "bytedance.com",
    headers: ["via"],
  },
  {
    name: "网宿 QUANTIL",
    url: "https://cdnperf-rum.quantil.com/500b-bench.jpg",
    site: "quantil.com",
    headers: ["via", "x-via"],
  },
  {
    name: "网宿 CDNetworks",
    url: "https://cdnperf-rum.cdnetworks.net/500b-bench.jpg",
    site: "cdnetworks.com",
    headers: ["via", "x-via"],
  },
];

export type CdnOutcome =
  | { name: string; ok: true; node: string; cache: string | null; latencyMs: number }
  | { name: string; ok: false; reason: string };

/** Rejects a body that is clearly a page rather than a node identifier. */
function isPlausibleNode(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.includes("<");
}

/** Caps how much of a `trace`/`text` body is read; the identifier sits in the first few lines. */
const MAX_BODY_BYTES = 8192;

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Stop the transfer once we have enough rather than draining a body of unknown size.
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset);
    offset += chunk.byteLength;
    if (offset >= total) break;
  }
  return new TextDecoder().decode(joined);
}

function readNodeHeaders(provider: CdnProvider, response: Response): string[] {
  return (provider.headers ?? []).flatMap((key) => {
    const value = response.headers.get(key);
    if (!value) return [];
    // Tencent EdgeOne base64-encodes its node identifier.
    if (key === "xcc") {
      try {
        return [`${key}: ${Buffer.from(value, "base64").toString("utf8")}`];
      } catch {
        return [];
      }
    }
    // `server` only names the node for Bunny; elsewhere it is the web server's name.
    if (key === "server" && !/bunnycdn-[\w-]+/i.test(value)) return [];
    return [`${key}: ${value}`];
  });
}

/** Probes one vendor. Never throws for a vendor-side failure: that is a result, not an error. */
export async function probeCdn(provider: CdnProvider): Promise<CdnOutcome> {
  const started = performance.now();
  try {
    if (provider.trace || provider.text) {
      const response = await fetch(provider.url, {
        signal: AbortSignal.timeout(8000),
        headers: { "cache-control": "no-cache" },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { name: provider.name, ok: false, reason: `响应 ${response.status}` };
      }
      const body = await boundedText(response);
      const node = provider.trace ? (body.match(/^colo=(.+)$/m)?.[1]?.trim() ?? "") : body.trim();
      if (!isPlausibleNode(node)) {
        return { name: provider.name, ok: false, reason: "未返回有效节点标识" };
      }
      return {
        name: provider.name,
        ok: true,
        node,
        cache: null,
        latencyMs: Math.round(performance.now() - started),
      };
    }

    // HEAD keeps this cheap; the node identifier is in the headers, not the body.
    const response = await fetch(provider.url, {
      method: "HEAD",
      signal: AbortSignal.timeout(8000),
      headers: { "cache-control": "no-cache" },
    });
    const values = readNodeHeaders(provider, response);
    if (values.length === 0) {
      // Not a CDN failure: the vendor simply does not publish a node header on this endpoint.
      return { name: provider.name, ok: false, reason: "该端点未返回节点标识头" };
    }
    return {
      name: provider.name,
      ok: true,
      node: values.join(" · "),
      cache: response.headers.get("x-cache") ?? response.headers.get("cf-cache-status"),
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { name: provider.name, ok: false, reason: timedOut ? "请求超时" : "请求失败或被阻断" };
  }
}

/** Concurrency cap, so one sweep cannot saturate this host's outbound connections. */
const CONCURRENCY = 6;

/**
 * Probes every vendor from this server.
 *
 * Results are cached briefly: the answer is a property of this host's routing, identical for all
 * visitors, so repeated board loads must not re-run 21 outbound requests each time.
 */
let cached: { at: number; results: CdnOutcome[] } | null = null;
let inFlight: Promise<CdnOutcome[]> | null = null;
const CACHE_MS = 120_000;

export async function probeAllCdn(): Promise<CdnOutcome[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.results;
  // Collapse concurrent sweeps into one.
  if (inFlight) return inFlight;

  const run = async (): Promise<CdnOutcome[]> => {
    const queue = [...CDN_PROVIDERS];
    const collected: CdnOutcome[] = [];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const provider = queue.shift();
        if (!provider) return;
        collected.push(await probeCdn(provider));
      }
    });
    await Promise.all(workers);
    // Keep catalogue order so the board's two columns line up row for row.
    const order = new Map(CDN_PROVIDERS.map((provider, index) => [provider.name, index]));
    collected.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
    cached = { at: Date.now(), results: collected };
    return collected;
  };

  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam, and lets an operator force a fresh sweep. */
export function clearCdnCache(): void {
  cached = null;
}

/** Probes a single vendor by name, for retrying one row without re-sweeping all of them. */
export async function probeCdnByName(name: unknown): Promise<CdnOutcome> {
  if (typeof name !== "string" || !name) throw new HttpError(400, "请指定厂商名称");
  const provider = CDN_PROVIDERS.find((entry) => entry.name === name);
  if (!provider) throw new HttpError(404, "未知的 CDN 厂商");
  return probeCdn(provider);
}
