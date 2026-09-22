/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { boundedJson, publicIp } from "./http.js";

/**
 * Hosting / mobile / proxy classification from ip-api.com.
 * Ported from one-ip (AGPL-3.0) `public/worker/ip-type.js` (AGPL-3.0). The Worker Cache API became an in-process
 * map, and the `Response` returns became plain data the route layer serialises.
 *
 * Every failure mode yields `{ available: false }` rather than throwing: this is a decoration on
 * top of an IP report, so an unavailable classifier must not fail the whole lookup. The upstream
 * `X-Ttl` backoff is preserved so a throttled quota is respected instead of hammered.
 */

export interface IpTypeResult {
  available: boolean;
  hosting?: boolean;
  mobile?: boolean;
  proxy?: boolean;
}

let retryAfter = 0;

const cache = new Map<string, { value: IpTypeResult; expiresAt: number }>();
const MAX_ENTRIES = 500;
const CACHE_TTL_MS = 3_600_000;

const UNAVAILABLE: IpTypeResult = { available: false };

export async function ipType(value: string): Promise<IpTypeResult> {
  const ip = publicIp(value);
  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (Date.now() < retryAfter) return UNAVAILABLE;

  try {
    const response = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,query,hosting,mobile,proxy`,
      { redirect: "manual", signal: AbortSignal.timeout(5000) },
    );
    if (response.status === 429 || response.headers.get("X-Rl") === "0") {
      const ttl = Number(response.headers.get("X-Ttl"));
      retryAfter = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 60) * 1000;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return UNAVAILABLE;
    }
    const data = (await boundedJson(response, 4096)) as Record<string, unknown>;
    // The reply must be about the address queried and must state all three flags as booleans.
    if (
      data.status !== "success" ||
      ![data.hosting, data.mobile, data.proxy].every((flag) => typeof flag === "boolean") ||
      publicIp(data.query) !== ip
    ) {
      return UNAVAILABLE;
    }
    const result: IpTypeResult = {
      available: true,
      hosting: data.hosting as boolean,
      mobile: data.mobile as boolean,
      proxy: data.proxy as boolean,
    };
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ip, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    return UNAVAILABLE;
  }
}
