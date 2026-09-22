/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import express from "express";
import helmet from "helmet";
import { createPublicApiRouter } from "./router.js";

/**
 * Standalone public network-diagnostics service.
 *
 * This code is derived from zhihui-hu/one-ip, which is AGPL-3.0-only. It lives in its own
 * repository and its own container precisely so that copyleft obligation stops at this service
 * boundary: consumers (e.g. the IndieArk status board) call it over HTTP and are not derivative
 * works of it. Keeping that separation intact is the whole point — do not vendor this code back
 * into a closed-source project.
 *
 * AGPL §13 requires that users interacting with this service over a network can obtain its source.
 * `GET /source` and the `X-Source-Code` header on every response satisfy that.
 */

const PORT = Number(process.env.PORT ?? 20054);
const SOURCE_URL = process.env.SOURCE_CODE_URL ?? "https://github.com/indieark/20054-netdiag";

/** Origins allowed to call this API from a browser; empty means same-origin only. */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);

export function createServer() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // AGPL §13: advertise where the running source can be obtained, on every response.
  app.use((_req, res, next) => {
    res.setHeader("X-Source-Code", SOURCE_URL);
    next();
  });

  /**
   * Explicit allowlist rather than `*`. Upstream one-ip refused all cross-origin reads; this
   * service exists to be consumed by our own board, so named origins are permitted and everything
   * else still gets nothing.
   */
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    } else if (origin) {
      res.status(403).json({ error: "该来源未被允许跨域调用本服务" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  /** Source-code pointer, kept as a real route so the obligation is discoverable, not buried. */
  app.get("/source", (_req, res) => {
    res.json({
      license: "AGPL-3.0-only",
      source: SOURCE_URL,
      upstream: "https://github.com/zhihui-hu/one-ip",
      notice:
        "本服务代码基于 AGPL-3.0 授权，衍生自 zhihui-hu/one-ip。你有权获取本服务运行中的完整对应源码。",
    });
  });

  app.use("/api", express.json({ limit: "16kb" }), createPublicApiRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "接口不存在" });
  });

  return app;
}

// Only listen when run directly, so tests can import `createServer` without binding a port.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  createServer().listen(PORT, () => {
    process.stdout.write(
      `${JSON.stringify({ event: "netdiag.listening", port: PORT, source: SOURCE_URL })}\n`,
    );
  });
}
