/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { isIP } from "node:net";

/**
 * HTTP core for the public diagnostics API, ported from one-ip (AGPL-3.0) Cloudflare Worker
 * (`public/worker/http.js`, AGPL-3.0).
 *
 * The validation logic is kept byte-for-byte equivalent to upstream: it is the security boundary
 * for every route below, and "improving" it during a port is how SSRF holes get introduced. What
 * changed is only the transport layer — Worker `Response` objects and `cf: { cacheTtl }` hints have
 * no Node equivalent, so responses are returned as plain data and caching is done in-process.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Validates a public IP literal, rejecting private, loopback, link-local, CGNAT, documentation,
 * benchmark and multicast ranges. IPv4-mapped IPv6 is unwrapped and re-checked as IPv4.
 */
export function publicIp(value: unknown): string {
  if (typeof value !== "string" || !isIP(value)) {
    throw new HttpError(400, "请输入有效的公网 IPv4 或 IPv6 地址");
  }
  const ip = isIP(value) === 6 ? new URL(`https://[${value}]/`).hostname.slice(1, -1) : value;
  if (isIP(ip) === 6) {
    if (ip.startsWith("::ffff:")) {
      const [high, low] = ip
        .slice(7)
        .split(":")
        .map((v) => Number.parseInt(v, 16));
      if (high === undefined || low === undefined || Number.isNaN(high) || Number.isNaN(low)) {
        throw new HttpError(400, "请输入有效的公网 IPv4 或 IPv6 地址");
      }
      return publicIp(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    // Accept global unicast only; reject local, documentation and benchmark ranges.
    if (!/^[23]/.test(ip) || /^2001:(db8|2|10|20):/.test(ip) || /^2001::/.test(ip)) {
      throw new HttpError(400, "不支持私有、回环或保留地址");
    }
  } else {
    const [a, b, c] = ip.split(".").map(Number) as [number, number, number, number];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    ) {
      throw new HttpError(400, "不支持私有、回环或保留地址");
    }
  }
  return ip;
}

/** Validates a public hostname or IP literal, rejecting URL syntax and internal-only suffixes. */
export function target(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 253) {
    throw new HttpError(400, "请输入有效的域名或 IP");
  }
  const normalized = value.trim().replace(/\.$/, "").toLowerCase();
  if (isIP(normalized)) return publicIp(normalized);
  if (
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized) ||
    /\.(localhost|local|internal|test|invalid|example)$/.test(normalized)
  ) {
    throw new HttpError(400, "请输入公网域名，不包含协议、路径或端口");
  }
  return normalized;
}

/** Reads at most `maxBytes` of a response body and parses it as JSON. */
export async function boundedJson(
  response: Response,
  maxBytes = 2_000_000,
  errorStatus = 502,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(errorStatus, "JSON 内容为空");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        throw new HttpError(errorStatus === 400 ? 413 : errorStatus, "JSON 内容过大");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(errorStatus, "内容不是有效 JSON");
  }
}

/**
 * In-process replacement for the Worker's `cf: { cacheTtl }` fetch hint.
 *
 * Upstream leaned on Cloudflare's edge cache to keep third-party load down. On Node that has to be
 * explicit, otherwise every visitor request becomes an upstream request and we would be hammering
 * free public APIs (RIPEstat, crt.sh, statuspage) from one IP — the fastest way to get blocked.
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const responseCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();
const MAX_CACHE_ENTRIES = 500;

function cacheGet(key: string): CacheEntry | undefined {
  const entry = responseCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return undefined;
  }
  return entry;
}

function cacheSet(key: string, value: unknown, ttlSeconds: number): void {
  if (responseCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
  responseCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/** Test seam; also lets an operator reset state without restarting the process. */
export function clearPublicApiCache(): void {
  responseCache.clear();
  inFlight.clear();
}

export interface UpstreamOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Seconds to keep a successful response in process memory; 0 disables caching. */
  cacheTtl?: number;
  maxBytes?: number;
  timeoutMs?: number;
  redirect?: "follow" | "manual" | "error";
}

/**
 * Fetches JSON from an upstream source, mapping transport and status failures onto `HttpError`
 * exactly as upstream did (429 stays 429 so the rate-limit reason survives to the client).
 */
export async function upstream(url: string, options: UpstreamOptions = {}): Promise<unknown> {
  const cacheTtl = options.cacheTtl ?? 0;
  const method = options.method ?? "GET";
  const cacheKey = cacheTtl > 0 ? `${method} ${url} ${options.body ?? ""}` : "";

  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached.value;
    const pending = inFlight.get(cacheKey);
    // Collapse a thundering herd: many visitors asking at once make one upstream request.
    if (pending) return pending;
  }

  const run = async (): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.redirect ? { redirect: options.redirect } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new HttpError(502, "外部数据源连接失败或超时");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(
        response.status === 429 ? 429 : 502,
        response.status === 429
          ? "外部数据源限流，请稍后重试"
          : `外部数据源暂不可用 (${response.status})`,
      );
    }
    const value = await boundedJson(response, options.maxBytes ?? 2_000_000);
    if (cacheKey) cacheSet(cacheKey, value, cacheTtl);
    return value;
  };

  if (!cacheKey) return run();
  const request = run().finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request);
  return request;
}

/** Fetches an upstream body as text, for sources that publish RSS/HTML rather than JSON. */
export async function upstreamText(url: string, options: UpstreamOptions = {}): Promise<string> {
  const cacheTtl = options.cacheTtl ?? 0;
  const cacheKey = cacheTtl > 0 ? `TEXT ${url}` : "";
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached.value as string;
    const pending = inFlight.get(cacheKey);
    if (pending) return pending as Promise<string>;
  }

  const run = async (): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new HttpError(502, "外部数据源连接失败或超时");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(response.status === 429 ? 429 : 502, "官方状态数据暂不可用");
    }
    // Bound the read the same way JSON is bounded; an unbounded text read is the same hazard.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > (options.maxBytes ?? 2_000_000)) {
      throw new HttpError(502, "内容过大");
    }
    const text = new TextDecoder().decode(buffer);
    if (cacheKey) cacheSet(cacheKey, text, cacheTtl);
    return text;
  };

  if (!cacheKey) return run();
  const request = run().finally(() => inFlight.delete(cacheKey));
  inFlight.set(cacheKey, request as Promise<unknown>);
  return request;
}
