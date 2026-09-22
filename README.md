# 20054 · netdiag — 公开网络诊断 API 服务

IP 归属地与信誉、DNS、WHOIS、子域名发现、BGP / RPKI、全球延迟、厂商运行状态的聚合查询服务。
固定对外端口 `20054`。

按工作区端口约定（`PROJECTS.md` 的「端口(前/后)」列），`20054` 是 **`20053-status-center` 的后端端口**。
本服务正是从 20053 拆出去的那一层后端：20053 的前端诊断分区调用它，而不是自己直连第三方数据源。
拆分的原因不是架构偏好，而是许可证 —— 见下节。

> **本仓库以 AGPL-3.0-only 授权，且必须是公开仓库。** 这是刻意设计，不是疏忽。

## 为什么必须是独立服务

本服务的代码衍生自 [zhihui-hu/one-ip](https://github.com/zhihui-hu/one-ip)，该项目采用
**AGPL-3.0-only**。AGPL 第 13 条规定：修改后的程序若让用户**通过网络**与之交互，就必须向这些用户
提供完整对应源码。

`20053-status-center` 是闭源私有仓库。如果把这套代码直接并进去，整个 20053 都会被 AGPL 传染、必须
开源。因此采用**服务隔离**：

```
20053-status-center (闭源, 私有)  ──HTTP──>  20054-netdiag (AGPL-3.0, 公开)
```

调用方通过 HTTP 使用本服务，不构成本服务的衍生作品，copyleft 义务止于这条服务边界。

**⚠️ 不要把本仓库的代码复制回 20053 或任何闭源项目。** 那会让隔离失效，也就重新触发 AGPL 义务。

### 合规要点

- `LICENSE` 为 AGPL-3.0 完整正文；每个源文件带版权与许可声明头
- `GET /source` 返回源码地址与许可证信息
- 每个响应都带 `X-Source-Code` 响应头
- 容器镜像内保留 `src/`（未编译源码），确保运行中的服务可提供对应源码

## 与 one-ip 上游的差异

| 上游（Cloudflare Worker） | 本服务（Node / Express） | 原因 |
|---|---|---|
| `Response.json()` | 返回普通数据，路由层序列化 | Worker Response 无 Express 对应物 |
| `cf: { cacheTtl }` 边缘缓存 | `upstream()` 进程内 TTL 缓存 + 同键请求合并 | Node 无边缘缓存；不做缓存会用**一个出口 IP** 反复打免费公共 API |
| `globalThis.caches.default` | 模块内 `Map` + TTL | 同上 |
| `request.cf`（国家 / ASN / TLS 指纹） | 删除；访客地址改由 `/api/me` 读 `x-forwarded-for` | 这些字段由 Cloudflare 边缘注入，自建拿不到 |
| `env.*` 绑定 | `process.env` | — |
| 同源守卫（跨域一律 403） | `ALLOWED_ORIGINS` 白名单 | 本服务的存在目的就是被我们的看板跨域调用 |
| `challenges.js`（Turnstile / reCAPTCHA） | **未移植** | 需站点密钥与后台配置，属独立特性 |
| `tls-fingerprint.js` | **未移植** | 依赖 Cloudflare Bot Management 的 JA3/JA4 |

**`publicIp` / `target` 两个校验函数刻意与上游逐字等价，一行未改。** 它们是所有路由的安全边界：
拒绝私网、回环、链路本地、云元数据（`169.254.169.254`）、CGNAT、fake-ip（`198.18/15`）、文档与保留段，
防止本接口被当成探测内网的跳板。移植时「顺手优化」这类函数是引入 SSRF 的典型路径。
`src/http.test.ts` 用 7 组用例钉住这一行为。

## 接口

| 路径 | 说明 | 数据源 |
|---|---|---|
| `GET /healthz` | 健康检查 | — |
| `GET /source` | AGPL 源码声明 | — |
| `GET /api/me` | 访客出口地址 | 本服务器所见 |
| `GET /api/ip/health?ip=&format=json\|text` | 信誉分 + 风险标记 | Net.Coffee |
| `GET /api/ip-type/:ip` | hosting / mobile / proxy | ip-api.com |
| `GET /api/geoip/:ip` | 归属地（多源回退，首个可用者胜） | ipwho.is → ip.sb → Net.Coffee |
| `GET /api/ip/lookup/:ip` | 多源归属地对比 + RDAP | ipwho.is + ip.sb + Net.Coffee + RDAP |
| `GET /api/ip/network/:ip` | 前缀 / ASN / BGP 拓扑 / RPKI / PTR | RIPEstat |
| `GET /api/whois/lookup/:query` | 域名 / IP / ASN 注册信息 | IANA bootstrap + RDAP |
| `GET /api/subdomains/:domain` | 子域名发现 | crt.sh 证书日志 |
| `GET /api/dns/resolve/:name` | 权威 A 记录 | Cloudflare DoH |
| `GET /api/ping/nodes` · `POST /api/ping/start` · `GET /api/ping/result/:id` | 全球延迟测量 | Globalping |
| `GET /api/status/:id` · `GET /api/services` | 厂商运行状态 | 各厂商官方状态接口 |
| `GET /api/cdn/providers` | CDN 厂商清单（单一信息源） | — |
| `GET /api/cdn/probe` · `GET /api/cdn/probe/:name` | 本服务器命中的 CDN 边缘节点 | 各厂商测试端点 |
| `GET /api/icons/:domain` | 站点图标 | DuckDuckGo |
| `GET /api/map/config` | 地图瓦片源 | — |

### 限流

进程内按访客 IP 计：读接口 120 次/分，POST（发起测量）20 次/分，超限 429。
本服务会从生产出口打第三方，限流是为了不把出口 IP 打进对方黑名单。

## 快速开始

```bash
cp .env.example .env    # 填 ALLOWED_ORIGINS
npm install
npm run dev             # tsx watch，默认 20054
```

门禁：

```bash
npm run verify          # lint + typecheck + test + build
```

容器：

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:20054/healthz
```

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `20054` | 监听端口 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域调用的来源，逗号分隔；空=仅同源。**20053 的对外域名必须在此** |
| `TIANDITU_TOKEN` | 空 | 配置后地图优先天地图，失败回落 OpenStreetMap |
| `SOURCE_CODE_URL` | GitHub 仓库地址 | AGPL §13 源码地址，随 `X-Source-Code` 响应头下发 |

## 已知的源可靠性

- **crt.sh 会抽**：实测连续请求可能返回 200 / 200 / 404 / 404。子域名查询失败按「源异常」上报，
  不当作「该域名没有子域名」。
- **ipwho.is / ip.sb 在部分网络不可达**：办公网实测 curl 直连即 `000`，生产出口同样连不上，
  因此 `/api/geoip/:ip` 改为三源顺序回退（见 `geoIpAnySource`）。全部源都失败才报 502，
  归属地失败时字段留空，不显示错误值。
- **CDN 厂商的节点标识头不保证存在**：实测 21 个厂商中服务器侧可读 18 个，Bunny Standard 与
  Tencent EdgeOne 的测试端点本身就不返回节点头 —— 这是端点特性，不是厂商故障，接口按
  `ok: false` + 原因返回，不当作错误抛出，也不影响同一轮其他厂商的结果。
- 解析器对未知形状一律报错，**绝不回落成「正常运行」**：状态类接口宁可显示源异常，也不能谎报健康。

## 明确边界

本地工程完成不等于测试部署、生产上线或真实源长期可用性验证。这些操作需要独立授权和可用环境。
