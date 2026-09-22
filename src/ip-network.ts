/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
/**
 * BGP topology, prefix and RPKI validation via RIPEstat.
 * Ported from one-ip (AGPL-3.0) `public/worker/ip-network.js` (AGPL-3.0). Worker cache hints became in-process TTLs.
 */
// @ts-nocheck -- Faithful port of upstream JS; typing the RIPEstat shapes is tracked separately.
import { boundedJson } from "./http.js";

const TIER_1_ASNS = new Set([
  "174",
  "1299",
  "2914",
  "3257",
  "3356",
  "5511",
  "6453",
  "6461",
  "6762",
  "6939",
  "7018",
]);
const MAX_ORIGINS = 4;
const MAX_DIRECT = 6;
const MAX_SECONDARY = 8;
const MAX_HOLDER_LOOKUPS = 20;

async function ripe(name, params) {
  const response = await fetch(
    `https://stat.ripe.net/data/${name}/data.json?${new URLSearchParams(params)}`,
    {
      signal: AbortSignal.timeout(4000),
      cacheTtl: 300,
    },
  );
  if (!response.ok) throw new Error("RIPE unavailable");
  const result = await boundedJson(response);
  if (result.status !== "ok" || !result.data) throw new Error("RIPE unavailable");
  return result.data;
}

function normalizeAsn(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(?:AS)?(\d+)$/i);
  return match?.[1];
}

function parsePath(path) {
  if (!Array.isArray(path)) return [];
  const normalized = path.map(normalizeAsn).filter(Boolean);
  return normalized.filter((asn, index) => index === 0 || asn !== normalized[index - 1]);
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function compareCounts([leftAsn, leftCount], [rightAsn, rightCount]) {
  return rightCount - leftCount || leftAsn.localeCompare(rightAsn, undefined, { numeric: true });
}

function percent(count, total) {
  return Math.round((count / total) * 1000) / 10;
}

function countItems(counts, total, limit) {
  return [...counts.entries()]
    .sort(compareCounts)
    .slice(0, limit)
    .map(([asn, count]) => ({
      asn,
      count,
      share: percent(count, total),
      tier1: TIER_1_ASNS.has(asn),
    }));
}

function buildTopology(state, prefix, announcingAsns) {
  const records = Array.isArray(state?.bgp_state) ? state.bgp_state : [];
  const exact = records.filter((record) => record?.target_prefix === prefix);
  const candidates = exact.length ? exact : records;
  const paths = candidates
    .map((record) => parsePath(record?.path))
    .filter((path) => path.length > 0);
  if (!paths.length) return undefined;

  const knownOrigins = new Set(announcingAsns);
  const matching = knownOrigins.size
    ? paths.filter((path) => knownOrigins.has(path[path.length - 1]))
    : [];
  const usablePaths = matching.length ? matching : paths;
  const origins = new Map();
  const direct = new Map();
  const directEdges = new Map();
  const secondary = new Map();
  const secondaryEdges = new Map();
  const secondaryVia = new Map();

  for (const path of usablePaths) {
    const origin = path[path.length - 1];
    increment(origins, origin);
    if (path.length < 2) continue;
    const directAsn = path[path.length - 2];
    if (directAsn === origin) continue;
    increment(direct, directAsn);
    increment(directEdges, `${origin}|${directAsn}`);
    if (path.length < 3) continue;
    const secondaryAsn = path[path.length - 3];
    if (secondaryAsn === directAsn || secondaryAsn === origin) continue;
    increment(secondary, secondaryAsn);
    increment(secondaryEdges, `${directAsn}|${secondaryAsn}`);
    if (!secondaryVia.has(secondaryAsn)) secondaryVia.set(secondaryAsn, new Map());
    increment(secondaryVia.get(secondaryAsn), directAsn);
  }

  if (!direct.size) return undefined;
  const total = usablePaths.length;
  const originItems = countItems(origins, total, MAX_ORIGINS);
  const directItems = countItems(direct, total, MAX_DIRECT);
  const originSet = new Set(originItems.map((item) => item.asn));
  const directSet = new Set(directItems.map((item) => item.asn));
  const secondaryVisible = new Map();
  for (const [key, count] of secondaryEdges) {
    const [directAsn, secondaryAsn] = key.split("|");
    if (!directSet.has(directAsn)) continue;
    increment(secondaryVisible, secondaryAsn, count);
  }
  const secondaryItems = countItems(secondaryVisible, total, MAX_SECONDARY).map((item) => ({
    ...item,
    via: [...(secondaryVia.get(item.asn)?.entries() ?? [])]
      .filter(([directAsn]) => directSet.has(directAsn))
      .sort(compareCounts)
      .map(([directAsn]) => directAsn)
      .slice(0, 3),
  }));
  const secondarySet = new Set(secondaryItems.map((item) => item.asn));

  const edges = [...directEdges.entries()]
    .map(([key, count]) => {
      const [origin, directAsn] = key.split("|");
      return {
        origin,
        direct: directAsn,
        count,
        share: percent(count, total),
      };
    })
    .filter((edge) => originSet.has(edge.origin) && directSet.has(edge.direct));
  const secondaryEdgeItems = [...secondaryEdges.entries()]
    .map(([key, count]) => {
      const [directAsn, secondaryAsn] = key.split("|");
      return {
        direct: directAsn,
        secondary: secondaryAsn,
        count,
        share: percent(count, total),
      };
    })
    .filter((edge) => directSet.has(edge.direct) && secondarySet.has(edge.secondary));

  return {
    observedPaths: total,
    queryTime: state.query_time,
    origins: originItems,
    direct: directItems,
    secondary: secondaryItems,
    edges,
    secondaryEdges: secondaryEdgeItems,
    lookupAsns: [
      ...new Set([
        ...originItems.map((item) => item.asn),
        ...directItems.map((item) => item.asn),
        ...secondaryItems.map((item) => item.asn),
      ]),
    ].slice(0, MAX_HOLDER_LOOKUPS),
  };
}

async function holderFor(asn) {
  try {
    const data = await ripe("as-overview", { resource: `AS${asn}` });
    const holder = typeof data?.holder === "string" ? data.holder.trim() : "";
    return holder || undefined;
  } catch {
    return undefined;
  }
}

async function addHolders(topology) {
  const holders = await Promise.all(
    topology.lookupAsns.map(async (asn) => [asn, await holderFor(asn)]),
  );
  const names = new Map(holders);
  const decorate = (item) => (names.get(item.asn) ? { ...item, name: names.get(item.asn) } : item);
  const publicTopology = { ...topology };
  delete publicTopology.lookupAsns;
  return {
    ...publicTopology,
    origins: topology.origins.map(decorate),
    direct: topology.direct.map(decorate),
    secondary: topology.secondary.map(decorate),
  };
}

export async function ipNetwork(ip) {
  const [network, reverse, state] = await Promise.allSettled([
    ripe("network-info", { resource: ip }),
    ripe("reverse-dns-ip", { resource: ip }),
    ripe("bgp-state", { resource: ip }),
  ]);
  const route = network.status === "fulfilled" ? network.value : undefined;
  const dns = reverse.status === "fulfilled" ? reverse.value : undefined;
  const asns = Array.isArray(route?.asns) ? route.asns.map(normalizeAsn).filter(Boolean) : [];
  const rawTopology =
    route?.prefix && state.status === "fulfilled"
      ? buildTopology(state.value, route.prefix, asns)
      : undefined;
  const validationsPromise = route?.prefix
    ? Promise.all(
        asns.map(async (asn) => {
          try {
            const data = await ripe("rpki-validation", {
              resource: asn,
              prefix: route.prefix,
            });
            return { asn, status: data.status, description: data.description };
          } catch {
            return { asn, status: "unavailable" };
          }
        }),
      )
    : Promise.resolve([]);
  const topologyPromise = rawTopology ? addHolders(rawTopology) : Promise.resolve(undefined);
  const [validations, topology] = await Promise.all([validationsPromise, topologyPromise]);
  return {
    prefix: route?.prefix,
    asns,
    ptr: Array.isArray(dns?.result) ? dns.result.join(" / ") : dns?.result || undefined,
    routeAvailable: Boolean(route),
    ptrAvailable: Boolean(dns && !dns.error),
    validations,
    topology,
    source: "RIPE RIS / RIPEstat",
    checkedAt: new Date().toISOString(),
  };
}
