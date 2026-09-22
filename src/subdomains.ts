/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
/**
 * Subdomain discovery from crt.sh certificate transparency logs.
 * Ported from one-ip (AGPL-3.0) `public/worker/subdomains.js` (AGPL-3.0).
 */
// @ts-nocheck -- Faithful port of upstream JS.
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { HttpError, target, upstream } from "./http.js";

export function subdomainTarget(value) {
  // Reject URL syntax before IDN conversion, which can otherwise normalize it.
  if (typeof value !== "string" || /[\s/:@%*?#\\]/.test(value.trim()))
    throw new HttpError(400, "请输入公网域名，不包含协议、路径或端口");
  const domain = domainToASCII(value.trim().replace(/\.$/, ""));
  if (isIP(domain)) throw new HttpError(400, "请输入公网域名，不包含协议、路径或端口");
  return target(domain);
}

export function certificateNames(records, domain) {
  if (!Array.isArray(records) || records.some((r) => !r || typeof r.name_value !== "string"))
    throw new HttpError(502, "证书日志数据格式异常");
  const names = new Set();
  for (const record of records) {
    for (const raw of record.name_value.split(/\r?\n/)) {
      const wildcard = raw.trim().startsWith("*.");
      let host: string;
      try {
        host = subdomainTarget(wildcard ? raw.trim().slice(2) : raw.trim());
      } catch {
        continue;
      }
      if (host.endsWith(`.${domain}`) || (wildcard && host === domain))
        names.add(`${wildcard ? "*." : ""}${host}`);
    }
  }
  return [...names].sort();
}

export async function lookupSubdomains(value) {
  const domain = subdomainTarget(value);
  const url = new URL("https://crt.sh/");
  url.searchParams.set("q", `%.${domain}`);
  url.searchParams.set("output", "json");
  const records = await upstream(url.href, { cacheTtl: 300, maxBytes: 8_000_000 });
  return {
    domain,
    source: "crt.sh",
    sourceUrl: url.href,
    names: certificateNames(records, domain),
    checkedAt: new Date().toISOString(),
  };
}
