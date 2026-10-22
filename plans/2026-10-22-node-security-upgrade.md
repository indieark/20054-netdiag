# Node.js 2026-10 安全升级

状态：`[done]`；安全版本已提交、推送，CI 成功并在原 Stack 发布；运行版本、健康和数据不变量已核验。

依据：[Node.js 24.22.1 安全发布](https://nodejs.org/en/blog/release/v24.22.1)。
本次安全基线为 22.23.4 / 24.22.1 / 26.12.1，旧的停止维护版本需要迁移。

## 目标与范围

原 Node 20 构建/运行阶段改用 Node 24.22.1；其他受影响阶段保留原主版本并更新安全补丁。
构建阶段与运行阶段一起检查；不改业务逻辑、锁文件、数据卷、端口或浏览器协议。
本项目目标文件：

- `Dockerfile`
- `.github/workflows/docker-image.yml`

## 验证与发布

1. 核对官方镜像标签存在；在目标 Node 版本运行项目现有的相关构建/检查。
2. 核对 `git diff --check`，保留无关改动。
3. 提交、推送和原 Portainer Stack 发布已获用户授权；发布前保存镜像/配置与数据备份，等待 CI 成功。
4. 发布后逐个应用/Worker 运行 `node --version`，确认健康及原数据；失败回滚原镜像和编排，不删除卷。

跨项目运行快照及详细验证：`../_work/office_runs/2026-10-22-node-security/report.md`（工作区相对路径）。

## 实施结果

本次只更新上述运行/构建版本及对应版本合同。目标 Node 二进制已按官方 SHA-256 验证。
相关验证、首次失败与恢复、未覆盖的 Linux 原生模块/容器检查，见工作区完整报告。

## 发布证据

- 安全提交：`61d6d96d130ae37ec624f714ae99ddfb897fdcbb`。
- [CI 39709819293](https://github.com/indieark/20054-netdiag/actions/runs/39709819293) 成功。
- 原 GitOps 自动发布 Stack 320；容器运行目标 revision、Node 22.23.4，healthz 200，健康正常。
- Stack 环境、GitOps 及挂载保持一致。旧镜像身份和完整配置已 DPAPI 加密保存；未清理数据卷、未重放业务或发送测试通知。
