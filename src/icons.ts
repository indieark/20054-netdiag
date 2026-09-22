/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { HttpError, target } from "./http.js";

/**
 * Site favicon proxy, ported from one-ip (AGPL-3.0) `public/worker/icons.js` (AGPL-3.0).
 * Returns the raw bytes plus content type so the route layer can stream them with caching headers.
 */

export interface SiteIconResult {
  body: ArrayBuffer;
  contentType: string;
}

export async function siteIcon(domain: string): Promise<SiteIconResult> {
  const host = target(domain);
  let response: Response;
  try {
    response = await fetch(`https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`, {
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new HttpError(502, "图标源连接失败");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new HttpError(404, "未找到图标");
  }
  const body = await response.arrayBuffer();
  // A favicon is small; a large body means we are being handed something else.
  if (body.byteLength > 512_000) throw new HttpError(502, "图标过大");
  return {
    body,
    contentType: response.headers.get("content-type") ?? "image/x-icon",
  };
}
