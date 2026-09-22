/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { isIP } from "node:net";
import { HttpError, publicIp, target, upstream } from "./http.js";

/**
 * RDAP registration lookup for domains, IPs and AS numbers.
 * Ported from one-ip (AGPL-3.0) `public/worker/whois.js` (AGPL-3.0); IANA bootstrap caching now happens in-process.
 */

type BootstrapServices = [string[], string[]][];

function ipNumber(ip: string): bigint {
  if (isIP(ip) === 4) {
    return ip.split(".").reduce((n, part) => (n << 8n) + BigInt(part), 0n);
  }
  const [left, right] = ip.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const parts =
    right === undefined
      ? head
      : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  return parts.reduce((n, part) => (n << 16n) + BigInt(`0x${part}`), 0n);
}

/** Longest-prefix match against the IANA RDAP bootstrap table. */
export function registrationServer(ip: string, services: BootstrapServices): string | undefined {
  const bits = isIP(ip) === 4 ? 32 : 128;
  const value = ipNumber(ip);
  const matches = services
    .flatMap(([prefixes, urls]) =>
      prefixes.flatMap((prefix) => {
        const [address, length] = prefix.split("/");
        if (!address || length === undefined) return [];
        if (isIP(address) !== isIP(ip)) return [];
        const shift = BigInt(bits - Number(length));
        return value >> shift === ipNumber(address) >> shift
          ? [{ length: Number(length), urls }]
          : [];
      }),
    )
    .sort((a, b) => b.length - a.length);
  return matches[0]?.urls.find((url) => url.startsWith("https://"));
}

export interface RegistrationResult {
  source: string;
  query: string;
  data: unknown;
}

export async function lookupRegistration(query: string): Promise<RegistrationResult> {
  const raw = query.trim();
  let path: string;
  let endpoint: string | undefined;

  if (/^AS\d+$/i.test(raw)) {
    const asn = Number(raw.slice(2));
    if (!Number.isSafeInteger(asn) || asn < 1 || asn > 4294967295) {
      throw new HttpError(400, "无效的 AS 号");
    }
    path = `autnum/${asn}`;
  } else if (isIP(raw)) {
    path = `ip/${encodeURIComponent(publicIp(raw))}`;
  } else {
    let ascii: string;
    try {
      ascii = new URL(`https://${raw}`).hostname;
    } catch {
      throw new HttpError(400, "请输入有效的域名、IP 或 AS 号");
    }
    // Reject paths/userinfo instead of silently querying a different resource.
    if (/[\s/@?#:]/.test(raw)) throw new HttpError(400, "仅输入域名，不包含路径或协议");
    const domain = target(ascii);
    path = `domain/${encodeURIComponent(domain)}`;
    const bootstrap = (await upstream("https://data.iana.org/rdap/dns.json", {
      cacheTtl: 86_400,
    })) as { services?: BootstrapServices };
    const suffix = domain.split(".").at(-1);
    const urls = bootstrap.services?.find(([suffixes]) =>
      suffix === undefined ? false : suffixes.includes(suffix),
    )?.[1];
    const base = urls?.find((url) => url.startsWith("https://"));
    if (!base) throw new HttpError(422, "该域名后缀暂无可用的 HTTPS RDAP 服务");
    endpoint = new URL(path, base.endsWith("/") ? base : `${base}/`).href;
  }

  const options = { headers: { Accept: "application/rdap+json, application/json" } };
  let data: unknown;
  try {
    data = await upstream(endpoint ?? `https://rdap.org/${path}`, options);
  } catch (error) {
    // For IPs, fall back to the per-family bootstrap table before giving up.
    if (!isIP(raw)) throw error;
    const ip = publicIp(raw);
    const bootstrap = (await upstream(`https://data.iana.org/rdap/ipv${isIP(ip)}.json`, {
      cacheTtl: 86_400,
    })) as { services?: BootstrapServices };
    const base = registrationServer(ip, bootstrap.services ?? []);
    if (!base) throw error;
    data = await upstream(new URL(path, base).href, options);
  }
  return { source: "RDAP · 注册局实时数据", query: raw, data };
}
