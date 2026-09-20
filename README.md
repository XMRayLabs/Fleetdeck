# FleetDeck

FleetDeck 是面向几十台乃至更多服务器的自托管运维控制台。它把 SSH、RDP、VNC、代理、批量命令、文件分发和可复用自动化剧本集中在一个 Web 界面中，并使用 Docker Compose 部署。

> FleetDeck 基于 [Heavrnl/nexus-terminal](https://github.com/Heavrnl/nexus-terminal) 进行大幅重构，保留原项目署名与 GPL-3.0 许可证。FleetDeck 不是原项目的官方发行版。

## 能做什么

- 统一管理 SSH、Windows RDP 和 Linux VNC 连接。
- 支持临时输入密码、保存的独立密码、私钥、私钥加口令，以及 SOCKS/SSH 代理。
- 按服务器、标签或任意选择集合批量执行命令，并实时查看每台主机的状态与输出。
- 向多台服务器分发文件；单台服务器也可连续执行多条命令。
- 将命令、文件、变量、执行策略组合为可重复使用的“自动化剧本”，选定目标后直接运行。
- 记录审计日志、连接历史、通知与失败状态。
- 接入自己的 AI API，分析选中的 SSH 日志；先预览脱敏内容，再确认目标与命令执行。
- 通过 WebAuthn Passkey、TOTP 两步验证、IP 策略和 CAPTCHA 加固登录。

## 安全设计

- 连接密码、私钥、代理凭据、剧本敏感变量及 TOTP 密钥使用 AES-256-GCM 加密后存储。
- 主加密密钥、会话密钥和远程网关服务密钥通过 Docker secrets 文件注入，不写入镜像或 Git。
- 登录后轮换会话 ID；Cookie 使用 `HttpOnly`、`SameSite=Strict`，HTTPS 部署默认启用 `Secure`。
- 登录与 API 均有限流，写操作校验 Origin，远程桌面内部 API 使用恒定时间密钥比较。
- 自定义终端 HTML 先经 DOMPurify 清理；脚本和事件处理器不会执行。
- 容器启用只读根文件系统、`no-new-privileges`、能力删除和非 root Node/Nginx 进程。
- Nginx 设置 CSP、点击劫持防护、MIME 嗅探防护和严格的权限策略。

安全问题请不要提交公开 Issue，处理方式见 [SECURITY.md](./SECURITY.md)。

## 快速部署

要求：Docker Engine 24+、Docker Compose v2，以及一个用于正式环境的 HTTPS 反向代理。

```bash
cp .env.example .env
./scripts/init-secrets.sh
docker compose pull
docker compose up -d --no-build
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
./scripts/init-secrets.ps1
docker compose pull
docker compose up -d --no-build
```

部署前必须修改 `.env` 中的 `RP_ID`、`RP_ORIGIN` 和 `APP_ORIGIN`。正式环境应保持 `COOKIE_SECURE=true`，并仅通过 HTTPS 暴露 Web 端口。完整说明见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

首次启动后访问 `https://你的域名`，创建至少 12 位的管理员密码，然后建议立即启用 Passkey 或 TOTP。

## AI 助手

在侧边栏打开 **AI 助手 → AI API 设置**，填写兼容 Chat Completions 的 API 基础地址、模型 ID 和 API Key。基础地址按服务商要求包含 `/v1`，不要填写完整的 `/chat/completions` 路径。设置按登录用户保存，API Key 使用现有主密钥加密，不需要新增 `.env` 变量。

SSH 终端右上角的“AI · 分析选中文本”会把当前选中文字带入助手，不会自动采集整段终端历史。也可以手动粘贴日志。使用流程：

1. 输入任务，选定 SSH 服务器（不选则仅分析）。
2. 点击“预览脱敏内容”，人工检查后确认发送给自己的 API 服务商。
3. 检查 AI 分析及每条建议命令，再确认目标服务器并执行。临时 SSH 密码只用于连接，不发送给模型。
4. 查看逐服务器结果、请求停止，或将脱敏结果带入下一轮分析。不会自动执行后续命令。

自动遮盖常见密码/Token/API Key 字段、Authorization/Cookie、URL 凭据、私钥/证书块及已保存连接/代理凭据的已知值。**无法保证识别任意业务秘密**，发送前必须人工检查。任务和日志预览只在内存保留最多 10 分钟；AI 操作历史仅记录元数据。确认后执行的命令与脱敏输出按现有任务机制加密保存。

安全限制：仅支持公网 HTTPS 443 API，拒绝内网/回环地址、重定向和不可信 TLS 证书；不是任意私有 HTTP 模型网关。所有 AI 建议均作为不可信文本展示。命令在新的 SSH 执行通道运行，不继承交互终端状态。最多选 50 台、8 条命令，并发 2，每条命令超时 120 秒；停止不会撤销已发生的远端修改。请优先使用最小权限服务器账号。详细边界见 [SECURITY.md](./SECURITY.md)。

## 自动化剧本（执行包）

剧本是预先保存的执行包。一个剧本可以包含多条顺序命令、文件附件、变量和失败策略，并可应用于单台、分组或任意选择的服务器。运行时会生成独立任务，记录逐主机日志与最终状态，适合安装软件、基线配置、巡检和批量更新。

## 架构

```text
Browser
  └─ Frontend (Vue 3 + Vite + Nginx)
       ├─ Backend API/WebSocket (Express 5 + SQLite)
       │    ├─ SSH/SFTP/批量任务/剧本
       │    └─ 加密凭据与审计数据
       └─ Remote Gateway (private service auth)
            └─ guacd ── RDP/VNC
```

只有前端端口发布到宿主机。Backend、Remote Gateway 和 guacd 只在 Compose 网络内通信。

## 本地开发

项目要求 Node.js 24 LTS，依赖只从 npm 官方注册表安装。

```bash
npm ci
npm run build
npm run audit:prod
```

## 项目仓库

FleetDeck 的官方代码仓库是 [XMRayLabs/Fleetdeck](https://github.com/XMRayLabs/Fleetdeck)。问题反馈、安全公告和后续版本均以该仓库为准。

About 页面仅通过 GitHub 官方 API 检查该仓库的 Release。自定义构建可以通过 `VITE_PROJECT_REPOSITORY_URL` 覆盖仓库地址；后端仍会将其严格限制为 `github.com` 官方地址。

## 数据与升级

- 持久数据位于 `./data`，运行密钥位于 `./secrets`；两者均被 Git 忽略。
- 从旧版本启动时，`nexus-terminal.db` 会自动迁移为 `fleetdeck.db`，数据库内容不会重建。
- 必须同时备份 `data` 和 `secrets/encryption_key`。丢失主加密密钥后，保存的凭据无法恢复。

## 许可证

[GPL-3.0-only](./LICENSE)。分发修改版本时必须继续遵守该许可证并保留版权与来源说明。
