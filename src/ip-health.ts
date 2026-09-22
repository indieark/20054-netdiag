/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { HttpError, publicIp, upstream } from "./http.js";

/**
 * IP reputation score and risk flags from Net.Coffee.
 * Ported from one-ip (AGPL-3.0) `public/worker/ip-health.js` (AGPL-3.0). Returns data instead of a `Response`;
 * the route layer handles JSON vs text formatting.
 *
 * Strictness is deliberate and preserved from upstream: an out-of-range score becomes `null` with
 * status `unknown` rather than a fabricated number, a missing flag stays `null` (never `false`),
 * and a reply describing a different address is rejected outright.
 */

export interface IpHealthFlags {
  residential: boolean | null;
  datacenter: boolean | null;
  mobile: boolean | null;
  vpn: boolean | null;
  proxy: boolean | null;
  tor: boolean | null;
  crawler: boolean | null;
  abuser: boolean | null;
}

export interface IpHealthResult {
  ip: string;
  checked_at: string;
  score: number | null;
  status: "good" | "moderate" | "poor" | "unknown";
  country: string | null;
  region: string | null;
  city: string | null;
  isp: string | null;
  asn: number | null;
  flags: IpHealthFlags;
}

export async function ipHealth(targetIp: string): Promise<IpHealthResult> {
  const ip = publicIp(targetIp);
  const data = (await upstream(`https://ip.net.coffee/api/ip/lookup/${encodeURIComponent(ip)}`, {
    redirect: "manual",
    cacheTtl: 600,
  })) as Record<string, unknown>;

  let returnedIp: string;
  try {
    returnedIp = publicIp(data?.ip);
  } catch {
    throw new HttpError(502, "IP 数据源返回的地址无效");
  }
  if (returnedIp !== ip) throw new HttpError(502, "IP 数据源返回的地址不匹配");

  const score =
    typeof data.trust_score === "number" &&
    Number.isFinite(data.trust_score) &&
    data.trust_score >= 0 &&
    data.trust_score <= 100
      ? data.trust_score
      : null;
  const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  const string = (value: unknown): string | null => (typeof value === "string" ? value : null);

  return {
    ip,
    checked_at: new Date().toISOString(),
    score,
    status: score === null ? "unknown" : score >= 75 ? "good" : score >= 45 ? "moderate" : "poor",
    country: string(data.country),
    region: string(data.region),
    city: string(data.city),
    isp: string(data.isp) ?? string(data.asOrganization),
    asn: Number.isInteger(data.asn) ? (data.asn as number) : null,
    flags: {
      residential: flag(data.isResidential),
      datacenter: flag(data.is_datacenter),
      mobile: flag(data.is_mobile),
      vpn: flag(data.is_vpn),
      proxy: flag(data.is_proxy),
      tor: flag(data.is_tor),
      crawler: flag(data.is_crawler),
      abuser: flag(data.is_abuser),
    },
  };
}

/** Terminal-friendly rendering used by `?format=text`. */
export function formatIpHealthText(result: IpHealthResult): string {
  // Strip control characters so upstream values cannot inject terminal escape sequences.
  const display = (value: unknown): string =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is precisely the point here.
    String(value ?? "unknown").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const rows: [string, unknown][] = [
    ...(Object.entries(result).filter(([key]) => key !== "flags") as [string, unknown][]),
    ...(Object.entries(result.flags) as [string, unknown][]),
  ];
  const lines = ["IndieArk — IP health", ...rows.map(([k, v]) => `${k}: ${display(v)}`)];
  return `${lines.join("\n")}\n`;
}
