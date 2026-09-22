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
 * IP geolocation from two independent providers, ported from one-ip (AGPL-3.0) `public/worker/geo.js` (AGPL-3.0).
 * Upstream's `cfGeo()` read Cloudflare's `request.cf` and has no Node equivalent, so it is dropped;
 * the visitor's own address is resolved by `/api/public/me` instead.
 */

export interface GeoResult {
  ip: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  isp?: string;
  asn?: number | string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  source: string;
}

export async function geoIp(ip: string): Promise<GeoResult> {
  publicIp(ip);
  const data = (await upstream(`https://ipwho.is/${encodeURIComponent(ip)}`, {
    cacheTtl: 600,
  })) as Record<string, any>;
  if (!data.success) throw new Error("IP 归属地数据源未返回有效结果");
  return {
    ip: data.ip,
    country: data.country,
    country_code: data.country_code,
    region: data.region,
    city: data.city,
    isp: data.connection?.isp,
    asn: data.connection?.asn,
    latitude: data.latitude,
    longitude: data.longitude,
    timezone: data.timezone?.id,
    source: "ipwho.is",
  };
}

export async function secondaryGeo(ip: string): Promise<GeoResult> {
  publicIp(ip);
  const data = (await upstream(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {
    cacheTtl: 600,
  })) as Record<string, any>;
  if (!data.ip) throw new Error("第二归属地数据源未返回结果");
  return {
    ip: data.ip,
    country: data.country,
    country_code: data.country_code,
    city: data.city,
    isp: data.isp,
    asn: data.asn,
    latitude: data.latitude,
    longitude: data.longitude,
    source: "ip.sb",
  };
}

/**
 * Third provider, sharing the source `/ip/health` uses.
 *
 * Added because the two providers above are both unreachable from some networks (our production
 * host among them), which made `/geoip/:ip` fail outright even though a working source was already
 * wired up elsewhere in this service. Geo lookups must not hinge on a single reachable host.
 */
export async function tertiaryGeo(ip: string): Promise<GeoResult> {
  publicIp(ip);
  const data = (await upstream(`https://ip.net.coffee/api/ip/lookup/${encodeURIComponent(ip)}`, {
    redirect: "manual",
    cacheTtl: 600,
  })) as Record<string, any>;
  // Same anti-forgery check as the other providers: a source that echoes back a different address
  // than the one asked about cannot be trusted to describe it.
  if (typeof data.ip !== "string" || data.ip.trim() !== ip) {
    throw new Error("第三归属地数据源返回的地址不匹配");
  }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  // Assembled by assignment rather than one literal: `exactOptionalPropertyTypes` rejects an
  // explicit `undefined` for an optional property, so absent fields must simply be omitted.
  const result: GeoResult = { ip, source: "ip.net.coffee" };
  const country = text(data.country);
  if (country) result.country = country;
  const countryCode = text(data.country_code) ?? text(data.countryCode);
  if (countryCode) result.country_code = countryCode;
  const region = text(data.region);
  if (region) result.region = region;
  const city = text(data.city);
  if (city) result.city = city;
  const isp = text(data.isp) ?? text(data.asOrganization);
  if (isp) result.isp = isp;
  if (Number.isInteger(data.asn)) result.asn = data.asn as number;
  const latitude = num(data.latitude);
  if (latitude !== undefined) result.latitude = latitude;
  const longitude = num(data.longitude);
  if (longitude !== undefined) result.longitude = longitude;
  const timezone = text(data.timezone);
  if (timezone) result.timezone = timezone;
  return result;
}

/**
 * Geo lookup across all providers, first usable answer wins.
 *
 * Providers are tried in order and every failure is isolated, so one unreachable host no longer
 * turns the whole lookup into a 502.
 */
export async function geoIpAnySource(ip: string): Promise<GeoResult> {
  const target = publicIp(ip);
  const providers = [geoIp, secondaryGeo, tertiaryGeo];
  const failures: string[] = [];
  for (const provider of providers) {
    try {
      return await provider(target);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  // Every provider failed: say so rather than inventing a location.
  throw new HttpError(502, `所有归属地数据源均不可用（${failures.length} 个已尝试）`);
}
