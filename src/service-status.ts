/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
/**
 * Normalises vendor status payloads into one shape.
 * Ported from one-ip (AGPL-3.0) `public/worker/service-status.js` (AGPL-3.0).
 */
// @ts-nocheck -- Faithful port of upstream JS.
export function normalizeStatus(data) {
  if (data.status?.indicator) return data;
  const states = {
    UP: { indicator: "none", description: "正常运行" },
    HASISSUES: { indicator: "minor", description: "存在服务故障" },
    UNDERMAINTENANCE: { indicator: "maintenance", description: "维护中" },
  };
  const status = states[data.page?.status];
  if (!status) return data;
  const incidents = [
    ...(data.activeIncidents ?? []).filter((item) => item.status !== "RESOLVED"),
    ...(data.activeMaintenances ?? []).filter((item) => item.status === "INPROGRESS"),
  ];
  return {
    status,
    incidents: incidents.map((item) => ({
      id: item.id ?? item.url,
      name: item.name,
      status: item.status,
      updated_at: item.updatedAt ?? item.started ?? item.start,
      shortlink: item.url,
    })),
  };
}
