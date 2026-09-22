/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
/**
 * UptimeRobot pulse parser for Telegram.
 * Ported from one-ip (AGPL-3.0) `public/worker/telegram-status.js` (AGPL-3.0).
 */
// @ts-nocheck -- Faithful port of upstream JS.
import { HttpError } from "./http.js";

// UptimeRobot's public monitor checks telegram.org every 10 minutes.
// Its website probe must not be presented as Telegram messaging health.
export function parseTelegramStatus(data, now = Date.now()) {
  const checked = Date.parse(data?.lastCheck);
  if (
    data?.slug !== "telegram" ||
    data?.url !== "telegram.org" ||
    !["UP", "DOWN"].includes(data?.status) ||
    !Number.isFinite(checked) ||
    checked > now + 60_000 ||
    now - checked > 30 * 60_000
  )
    throw new HttpError(502, "第三方状态数据暂不可用");
  const up = data.status === "UP";
  return {
    status: {
      indicator: up ? "none" : "major",
      description: up ? "第三方网站监测正常" : "第三方网站监测异常",
    },
    checkedAt: new Date(checked).toISOString(),
    components: [
      {
        id: "telegram-website",
        name: "telegram.org (UptimeRobot)",
        status: up ? "operational" : "major_outage",
      },
    ],
  };
}
