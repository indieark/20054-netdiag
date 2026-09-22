/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
/**
 * Map tile provider selection, ported from one-ip (AGPL-3.0) `public/worker/map.js` (AGPL-3.0).
 * Reads `process.env` instead of the Worker `env` binding.
 */
export interface MapConfig {
  provider: "tianditu" | "osm";
  token?: string;
}

export function mapConfig(): MapConfig {
  const token = (process.env.TIANDITU_TOKEN ?? "").trim();
  return token ? { provider: "tianditu", token } : { provider: "osm" };
}
