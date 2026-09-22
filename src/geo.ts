/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { publicIp, upstream } from "./http.js";

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
