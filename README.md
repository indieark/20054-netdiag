<div align="center">

# 20054 · netdiag

**IP、DNS、WHOIS、延迟、厂商状态，一组 HTTP 接口全能查。**

`IP 归属与信誉` · `DNS / WHOIS` · `全球延迟` · `厂商状态` — 公开的网络诊断 API 服务，端口 `20054`。

[![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue?style=flat-square)](#license)
[![Stack](https://img.shields.io/badge/stack-Node.js%20%2B%20Express-339933?style=flat-square)](#开发栈)
[![Port](https://img.shields.io/badge/port-20054-orange?style=flat-square)](#启动)
[![Endpoints](https://img.shields.io/badge/endpoints-21-brightgreen?style=flat-square)](#api)
[![Rate limit](https://img.shields.io/badge/rate%20limit-120%20%2F%2020%20per%20min-yellow?style=flat-square)](#限流)
[![Upstream](https://img.shields.io/badge/upstream-one--ip-ff69b4?style=flat-square)](#和上游-one-ip-的差别)

[为什么单独一个服务](#为什么单独一个服务) · [核心能力](#核心能力) · [启动](#启动) · [API](#api) · [配置](#配置) · [协同关系](#协同关系)

</div>

> AI 接手前先读 [AGENTS.md](./AGENTS.md)，里面是协作约定和文档维护规则。

---

> 状态看板要查 IP 归属、DNS、子域名、全球延迟这些数据，以前得各自去连第三方源。现在由这个服务统一去查、做缓存和限流，看板只调它的 HTTP 接口。

**本仓库按 AGPL-3.0-only 授权，必须是公开仓库，这是有意的安排。** 原因见下一节。

---

## 为什么单独一个服务

本服务的代码衍生自 [zhihui-hu/one-ip](https://github.com/zhihui-hu/one-ip)，它用的是 **AGPL-3.0-only**。AGPL 第 13 条规定：修改后的程序如果让用户**通过网络**和它交互，就要向这些用户提供完整的对应源码。

调用它的状态看板是闭源的。直接把这套代码并进去，整个看板都得按 AGPL 开源。所以把它拆成独立服务：

```text
状态看板（闭源） ──HTTP──>  20054-netdiag（AGPL-3.0，公开）
```

调用方只通过 HTTP 使用本服务，不算本服务的衍生作品，copyleft 义务到这条服务边界为止。

**⚠ 不要把本仓库的代码复制到闭源项目里**，那样隔离就失效了，AGPL 义务会重新生效。

### 合规要点

| 要求 | 做法 |
|---|---|
| 许可证全文 | [LICENSE](./LICENSE) 是 AGPL-3.0 完整正文，每个源文件都有版权和许可声明头 |
| 能拿到源码 | `GET /source` 返回源码地址和许可证信息（[src/index.ts](./src/index.ts)） |
| 每个响应都提示 | 响应头带 `X-Source-Code` |
| 运行中的服务带源码 | [Dockerfile](./Dockerfile) 把未编译的 `src/` 一起放进镜像 |

---

## 核心能力

| 能力 | 实现 |
|---|---|
| **IP 归属与信誉** | 多源归属地对比、信誉分和风险标记、hosting / mobile / proxy 判断，见 [geo.ts](./src/geo.ts)、[ip-health.ts](./src/ip-health.ts)、[ip-type.ts](./src/ip-type.ts) |
| **网络和注册信息** | 前缀、ASN、BGP 拓扑、RPKI、PTR（[ip-network.ts](./src/ip-network.ts)）；域名 / IP / ASN 的 WHOIS（[whois.ts](./src/whois.ts)） |
| **DNS 和子域名** | Cloudflare DoH 查权威 A 记录；crt.sh 证书日志找子域名（[subdomains.ts](./src/subdomains.ts)） |
| **全球延迟** | 经 Globalping 发起和读取测量（[ping.ts](./src/ping.ts)，节点表 [nodes.json](./src/nodes.json)） |
| **厂商运行状态** | 读各厂商官方状态接口（[service-status.ts](./src/service-status.ts)、[cloud-status.ts](./src/cloud-status.ts)、[ai-status.ts](./src/ai-status.ts)，服务表 [services.json](./src/services.json)） |
| **CDN 节点** | 厂商清单只维护一份，服务器侧探测命中的边缘节点（[cdn.ts](./src/cdn.ts)） |
| **防止被当跳板** | `publicIp` / `target` 拒绝私网、回环、链路本地、云元数据（`169.254.169.254`）、CGNAT、fake-ip（`198.18/15`）、文档和保留段（[http.ts](./src/http.ts)） |
| **缓存和限流** | 上游请求进程内 TTL 缓存，同一个键的并发请求合并；按访客 IP 限流（[router.ts](./src/router.ts)） |

---

## 启动

### 端口约定

| 通道 | 端口 |
|---|---|
| 服务监听 | `20054` |
| Docker 服务名 / 容器名 | `netdiag` |
| 镜像 | `ghcr.io/indieark/netdiag` |

### 本地运行

需要 Node.js 22 或更高。

```bash
git clone https://github.com/indieark/20054-netdiag.git
cd 20054-netdiag
cp .env.example .env    # 按需填 ALLOWED_ORIGINS
npm install
npm run dev             # tsx watch，默认 20054
```

验证（lint + typecheck + test + build）：

```bash
npm run verify
```

### Docker

```bash
docker compose up -d
```

[docker-compose.yml](./docker-compose.yml) 拉取已发布的镜像，**故意不映射端口**。调用方加入同一个 Docker 网络 `netdiag`，按服务名 `netdiag:20054` 访问，所以 20054 不会暴露到宿主机或公网。这个网络由先启动的那个 Stack 创建，调用方声明为 `external`。

要自己构建镜像就用 [Dockerfile](./Dockerfile)：

```bash
docker build -t netdiag .
```

### 健康检查

本地 `npm run dev` 起来后：

```bash
curl -fsS http://127.0.0.1:20054/healthz
```

镜像里也自带同样的健康检查。

---

## API

公开接口挂在 `/api` 下，`/healthz` 和 `/source` 在根路径。

| 端点 | 说明 | 数据源 |
|---|---|---|
| `GET /healthz` | 健康检查 | 无 |
| `GET /source` | AGPL 源码声明 | 无 |
| `GET /api/me` | 访客出口地址 | 本服务器看到的地址 |
| `GET /api/ip/health?ip=&format=json\|text` | 信誉分 + 风险标记 | Net.Coffee |
| `GET /api/ip-type/:ip` | hosting / mobile / proxy | ip-api.com |
| `GET /api/geoip/:ip` | 归属地，多源依次回退，第一个能用的为准 | ipwho.is → ip.sb → Net.Coffee |
| `GET /api/ip/lookup/:ip` | 多源归属地对比 + RDAP | ipwho.is + ip.sb + Net.Coffee + RDAP |
| `GET /api/ip/network/:ip` | 前缀 / ASN / BGP 拓扑 / RPKI / PTR | RIPEstat |
| `GET /api/whois/lookup/:query` | 域名 / IP / ASN 注册信息 | IANA bootstrap + RDAP |
| `GET /api/subdomains/:domain` | 子域名发现 | crt.sh 证书日志 |
| `GET /api/dns/resolve/:name` | 权威 A 记录 | Cloudflare DoH |
| `GET /api/ping/nodes` · `POST /api/ping/start` · `GET /api/ping/result/:id` | 全球延迟测量 | Globalping |
| `GET /api/status/:id` · `GET /api/services` | 厂商运行状态 | 各厂商官方状态接口 |
| `GET /api/cdn/providers` | CDN 厂商清单（只此一份） | 无 |
| `GET /api/cdn/probe` · `GET /api/cdn/probe/:name` | 本服务器命中的 CDN 边缘节点 | 各厂商测试端点 |
| `GET /api/icons/:domain` | 站点图标 | DuckDuckGo |
| `GET /api/map/config` | 地图瓦片源 | 无 |

### 限流

进程内按访客 IP 计数：读接口每分钟 120 次，POST（发起测量）每分钟 20 次，超了返回 429。本服务会从同一个出口去打第三方，限流是为了不让这个出口 IP 进对方黑名单。

### 数据源靠不住的地方

- **crt.sh 不稳定**：连续请求实测可能返回 200 / 200 / 404 / 404。子域名查询失败按「源异常」上报，不当成「这个域名没有子域名」。
- **ipwho.is / ip.sb 在部分网络连不上**：实测部分出口直连就失败，所以 `/api/geoip/:ip` 改成三源依次回退（`geoIpAnySource`，在 [geo.ts](./src/geo.ts)）。全部失败才报 502；归属地拿不到时字段留空，不显示错误的值。
- **CDN 厂商不一定返回节点头**：实测 21 个厂商里服务器侧能读 18 个。Bunny Standard 和 Tencent EdgeOne 的测试端点本来就不返回节点头，这是端点的特点，不是厂商故障。接口返回 `ok: false` 加原因，不抛错，也不影响同一轮其他厂商。
- 解析器遇到认不出的格式一律报错，**不会退回成「正常运行」**。状态类接口宁可显示源异常，也不谎报健康。

### 和上游 one-ip 的差别

| 上游（Cloudflare Worker） | 本服务（Node / Express） | 原因 |
|---|---|---|
| `Response.json()` | 返回普通数据，路由层序列化 | Express 里没有 Worker Response |
| `cf: { cacheTtl }` 边缘缓存 | `upstream()` 进程内 TTL 缓存 + 同键请求合并 | Node 没有边缘缓存；不缓存就会用**同一个出口 IP** 反复打免费公共 API |
| `globalThis.caches.default` | 模块内 `Map` + TTL | 同上 |
| `request.cf`（国家 / ASN / TLS 指纹） | 删掉；访客地址改由 `/api/me` 读 `x-forwarded-for` | 这些字段是 Cloudflare 边缘加的，自建拿不到 |
| `env.*` 绑定 | `process.env` | 运行环境不同 |
| 同源守卫（跨域一律 403） | `ALLOWED_ORIGINS` 白名单 | 需要允许指定的看板来源调用 |
| `challenges.js`（Turnstile / reCAPTCHA） | **没移植** | 要站点密钥和后台配置，是另一项功能 |
| `tls-fingerprint.js` | **没移植** | 依赖 Cloudflare Bot Management 的 JA3/JA4 |

**`publicIp` 和 `target` 两个校验函数和上游逐字一致，一行没改。** 它们是所有路由的安全边界，移植时「顺手优化」这类函数最容易引入 SSRF。[http.test.ts](./src/http.test.ts) 用 7 组用例锁住了它们的行为。

---

## 配置

变量模板见 [.env.example](./.env.example)。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `20054` | 监听端口 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域调用的来源，逗号分隔；留空只允许同源。看板经自己的同源反代调用时可以留空，只有别的来源要直接跨域调用时才填 |
| `TIANDITU_TOKEN` | 空 | 配了以后地图优先用天地图，失败回落 OpenStreetMap |
| `SOURCE_CODE_URL` | `https://github.com/indieark/20054-netdiag` | AGPL §13 的源码地址，随 `X-Source-Code` 响应头下发 |

---

## 开发栈

| 用途 | 技术 |
|---|---|
| **运行时** | Node.js 22+、TypeScript |
| **HTTP** | Express 5、Helmet |
| **测试** | Vitest |
| **质量** | Biome |
| **容器** | Docker 多阶段构建，CI 在 [.github/workflows/](./.github/workflows/) |

---

## 目录结构

```text
20054-netdiag/
├─ src/
│  ├─ index.ts           # 入口、/healthz、/source、X-Source-Code
│  ├─ router.ts          # /api 路由和限流
│  ├─ http.ts            # publicIp / target 安全校验、上游请求和缓存
│  ├─ geo.ts             # 归属地多源回退
│  ├─ ip-health.ts       # 信誉分
│  ├─ ip-network.ts      # BGP / RPKI / PTR
│  ├─ whois.ts · subdomains.ts · ping.ts · cdn.ts · icons.ts · map.ts
│  ├─ service-status.ts · cloud-status.ts · ai-status.ts · telegram-status.ts
│  └─ nodes.json · services.json
├─ docs/                 # 文档索引（模板）
├─ plans/                # 改动计划
├─ references/           # 外部参考
├─ Dockerfile
├─ docker-compose.yml
├─ LICENSE               # AGPL-3.0 全文
└─ AGENTS.md
```

文档入口：[文档索引](./docs/README.md) · [计划索引](./plans/README.md) · [参考资料](./references/README.md)

---

## 协同关系

| 关联仓库 | 关系 |
|---|---|
| [`zhihui-hu/one-ip`](https://github.com/zhihui-hu/one-ip) | 上游项目，本服务的代码从它衍生，沿用 AGPL-3.0-only |
| `20053-status-center`（私有） | 主要调用方。它的诊断分区经同源反代调用本服务的 HTTP 接口，不引入本仓库代码 |

---

## License

[AGPL-3.0-only](./LICENSE)

本地工程完成不等于测试部署、上线或真实数据源长期可用性验证，这些需要单独授权和可用环境。
