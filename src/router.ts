/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { Router } from "express";
import { getAiStatus } from "./ai-status.js";
import { getCloudStatus } from "./cloud-status.js";
import { geoIp, geoIpAnySource, secondaryGeo, tertiaryGeo } from "./geo.js";
import { HttpError, publicIp, target } from "./http.js";
import { siteIcon } from "./icons.js";
import { formatIpHealthText, ipHealth } from "./ip-health.js";
import { ipNetwork } from "./ip-network.js";
import { ipType } from "./ip-type.js";
import { mapConfig } from "./map.js";
import { pingNodes, pingResult, startPing } from "./ping.js";
import { normalizeStatus } from "./service-status.js";
import servicesCatalog from "./services.json" with { type: "json" };
import { lookupSubdomains } from "./subdomains.js";
import { lookupRegistration } from "./whois.js";

/**
 * Public diagnostics API, mirroring one-ip's Worker routes (AGPL-3.0) on Express.
 *
 * Mounted unauthenticated at `/api/public` alongside the existing board snapshot: these are
 * read-only lookups against public data sources, the same surface one-ip exposes to anonymous
 * visitors. Each handler validates its own input through `publicIp` / `target`, which reject
 * private, loopback, reserved and fake-ip ranges so the endpoints cannot be used to probe our
 * internal network.
 */

interface ServiceEntry {
  id: string;
  name: string;
  group: string;
  url?: string;
  page?: string;
  statusSource?: string;
  icon?: string;
  officialStatus?: boolean;
  note?: string;
}

const SERVICES = servicesCatalog as ServiceEntry[];

/** Vendors whose payloads need the cloud adapters rather than the AI/statuspage path. */
const CLOUD_SERVICE_IDS = new Set([
  "aws",
  "google-cloud",
  "oracle-cloud",
  "34",
  "aliyun",
  "tencent-cloud",
  "azure",
]);

/** Simple per-IP token bucket; these routes fan out to free third-party APIs on our egress. */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const ACTION_RATE_LIMIT_MAX = 20;
const buckets = new Map<string, { count: number; resetAt: number }>();

function consumeRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

export function createPublicApiRouter(): Router {
  const router = Router();

  router.use((req, res, next) => {
    if (buckets.size > 10_000) buckets.clear();
    const key = req.ip ?? "unknown";
    const isAction = req.method === "POST";
    if (
      !consumeRateLimit(
        `${key}:${isAction ? "action" : "read"}`,
        isAction ? ACTION_RATE_LIMIT_MAX : RATE_LIMIT_MAX,
      )
    ) {
      res.status(429).json({ error: "请求过于频繁，请稍后重试" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  /** The visitor's own address, as seen by this server. Replaces the Worker's `request.cf` view. */
  router.get("/me", (req, res) => {
    const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    const address = forwarded || req.ip || "";
    const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
    try {
      res.json({ ip: publicIp(normalized), source: "IndieArk status server" });
    } catch {
      // Behind a proxy that hides the client, or a private-range client: say so rather than guess.
      res.status(503).json({ error: "无法确定访客公网地址，请改用带 ip 参数的接口" });
    }
  });

  router.get("/map/config", (_req, res) => {
    res.json(mapConfig());
  });

  router.get("/services", (_req, res) => {
    res.json(SERVICES);
  });

  router.get("/ip/health", async (req, res, next) => {
    try {
      const format = (req.query.format as string | undefined) ?? "json";
      if (!["json", "text"].includes(format)) {
        throw new HttpError(400, "format 仅支持 json 或 text");
      }
      const queryIp = req.query.ip as string | undefined;
      const forwarded = (req.headers["x-forwarded-for"] as string | undefined)
        ?.split(",")[0]
        ?.trim();
      const candidate = queryIp ?? forwarded ?? req.ip ?? "";
      const result = await ipHealth(
        candidate.startsWith("::ffff:") ? candidate.slice(7) : candidate,
      );
      if (format === "text") {
        res.type("text/plain; charset=utf-8").send(formatIpHealthText(result));
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/ip-type/:ip", async (req, res, next) => {
    try {
      res.json(await ipType(req.params.ip));
    } catch (error) {
      next(error);
    }
  });

  router.get("/geoip/:ip", async (req, res, next) => {
    try {
      res.json(await geoIpAnySource(publicIp(req.params.ip)));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ip/network/:ip", async (req, res, next) => {
    try {
      res.json(await ipNetwork(publicIp(req.params.ip)));
    } catch (error) {
      next(error);
    }
  });

  /** Multi-source IP report: two geo providers plus RDAP registration, failures isolated. */
  router.get("/ip/lookup/:ip", async (req, res, next) => {
    try {
      const ip = publicIp(req.params.ip);
      const [primary, secondary, tertiary, registration] = await Promise.allSettled([
        geoIp(ip),
        secondaryGeo(ip),
        tertiaryGeo(ip),
        lookupRegistration(ip),
      ]);
      const sources = [primary, secondary, tertiary].flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      res.json({
        geo: sources[0] ?? { ip },
        sources,
        rdap: registration.status === "fulfilled" ? registration.value.data : undefined,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/subdomains/:domain", async (req, res, next) => {
    try {
      res.json(await lookupSubdomains(req.params.domain));
    } catch (error) {
      next(error);
    }
  });

  router.get("/whois/lookup/:query", async (req, res, next) => {
    try {
      res.json(await lookupRegistration(req.params.query));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ping/nodes", async (_req, res, next) => {
    try {
      res.json(await pingNodes());
    } catch (error) {
      next(error);
    }
  });

  router.post("/ping/start", async (req, res, next) => {
    try {
      res.json(await startPing(req.body));
    } catch (error) {
      next(error);
    }
  });

  router.get("/ping/result/:id", async (req, res, next) => {
    try {
      res.json(await pingResult(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  router.get("/status/:id", async (req, res, next) => {
    try {
      const service = SERVICES.find((entry) => entry.id === req.params.id);
      if (!service) throw new HttpError(404, "未知服务");
      if (!service.url) {
        throw new HttpError(503, "该服务未提供已接入的公开状态接口，请查看官方状态页");
      }
      const data =
        service.group === "VPS" || CLOUD_SERVICE_IDS.has(service.id)
          ? await getCloudStatus(service)
          : await getAiStatus(service);
      res.json({
        ...normalizeStatus(data),
        fetchedAt: new Date().toISOString(),
        source: service.url,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/icons/:domain", async (req, res, next) => {
    try {
      const icon = await siteIcon(req.params.domain);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.type(icon.contentType).send(Buffer.from(icon.body));
    } catch (error) {
      next(error);
    }
  });

  /** Resolve a hostname's authoritative address over DoH, for the connectivity and DNS pages. */
  router.get("/dns/resolve/:name", async (req, res, next) => {
    try {
      const host = target(req.params.name);
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
        { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw new HttpError(502, "DoH 数据源不可用");
      res.json(await response.json());
    } catch (error) {
      next(error);
    }
  });

  // Errors carry the upstream's own status and message; anything else is reported generically so
  // internal details never reach the client.
  router.use(
    (
      error: unknown,
      _req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      if (error instanceof HttpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (error instanceof Error && error.name === "URIError") {
        res.status(400).json({ error: "URL 编码无效" });
        return;
      }
      res.status(502).json({ error: "查询暂时失败，请稍后重试" });
    },
  );

  return router;
}
