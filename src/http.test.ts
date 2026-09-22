/*
 * Copyright (C) 2026 IndieArk
 * Derived from zhihui-hu/one-ip <https://github.com/zhihui-hu/one-ip>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU Affero General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version. See LICENSE for the full text.
 */
import { describe, expect, it } from "vitest";
import { HttpError, publicIp, target } from "./http.js";

/**
 * These two functions are the security boundary for every route in this service: they are what
 * stops a caller from pointing the API at our own LAN or at cloud metadata. The cases below are
 * the reason this file exists — a regression here is an SSRF hole, not a cosmetic bug.
 */

describe("publicIp", () => {
  it("accepts routable IPv4 and IPv6", () => {
    expect(publicIp("1.1.1.1")).toBe("1.1.1.1");
    expect(publicIp("8.8.8.8")).toBe("8.8.8.8");
    expect(publicIp("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
  });

  it("rejects private, loopback, link-local, CGNAT and fake-ip ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.0.1",
      "192.88.99.1",
      "100.64.0.1", // CGNAT
      "198.18.0.1", // fake-ip (transparent proxy)
      "198.19.255.255",
      "198.51.100.1", // documentation
      "203.0.113.1",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ]) {
      expect(() => publicIp(address), address).toThrow(HttpError);
    }
  });

  it("rejects reserved IPv6 and unwraps IPv4-mapped addresses", () => {
    expect(() => publicIp("::1")).toThrow(HttpError);
    expect(() => publicIp("fe80::1")).toThrow(HttpError);
    expect(() => publicIp("2001:db8::1")).toThrow(HttpError);
    // ::ffff:10.0.0.1 must be recognised as the private IPv4 it really is.
    expect(() => publicIp("::ffff:a00:1")).toThrow(HttpError);
  });

  it("rejects non-IP input rather than coercing it", () => {
    for (const value of ["", "github.com", "1.1.1", "not-an-ip", null, undefined, 42, {}]) {
      expect(() => publicIp(value), JSON.stringify(value)).toThrow(HttpError);
    }
  });
});

describe("target", () => {
  it("accepts public hostnames and normalises them", () => {
    expect(target("GitHub.com")).toBe("github.com");
    expect(target("github.com.")).toBe("github.com");
    expect(target(" example.co.uk ")).toBe("example.co.uk");
  });

  it("passes IP literals through the publicIp guard", () => {
    expect(target("1.1.1.1")).toBe("1.1.1.1");
    expect(() => target("192.168.0.1")).toThrow(HttpError);
  });

  it("rejects URL syntax, ports and internal-only suffixes", () => {
    for (const value of [
      "https://github.com",
      "github.com/path",
      "github.com:443",
      "user@github.com",
      "printer.local",
      "db.internal",
      "site.test",
      "host.localhost",
      "thing.invalid",
      "demo.example",
      "no_underscores.com",
      "a".repeat(260),
      "",
    ]) {
      expect(() => target(value), JSON.stringify(value)).toThrow(HttpError);
    }
  });
});
