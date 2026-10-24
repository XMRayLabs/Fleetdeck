# FleetDeck 部署与加固

## 1. 准备目录

```bash
cp .env.example .env
mkdir -p data
./scripts/init-secrets.sh
```

Linux 上确保 UID 1000 能写入数据目录：

```bash
sudo chown -R 1000:1000 data
chmod 700 data secrets
chmod 600 secrets/*
```

Windows 使用 `./scripts/init-secrets.ps1`。不要提交 `.env`、`data` 或 `secrets`。

## 2. 配置域名

编辑 `.env`：

```dotenv
DEPLOYMENT_MODE=docker
WEB_PORT=18111
COOKIE_SECURE=true
FLEETDECK_IMAGE_NAMESPACE=sakurame1
FLEETDECK_IMAGE_TAG=latest
RP_ID=fleet.example.com
RP_ORIGIN=https://fleet.example.com
APP_ORIGIN=https://fleet.example.com
```

`RP_ID` 只写主机名，`RP_ORIGIN` 与 `APP_ORIGIN` 必须包含 `https://` 且与浏览器最终地址一致，否则 Passkey 或写请求会失败。

## 3. 启动与检查

```bash
docker compose config
docker compose pull
docker compose up -d --no-build
docker compose ps
docker compose logs --tail=100 backend remote-gateway
```

Compose 只发布 `${WEB_PORT}`。不要额外发布 3001、8080、9090 或 4822。

## 4. HTTPS 反向代理

让 Caddy、Traefik 或 Nginx 把公网 HTTPS 请求代理到 `127.0.0.1:18111`，保留 `Host`、`X-Forwarded-For`、`X-Forwarded-Proto` 和 WebSocket Upgrade 头。建议在最外层 TLS 代理启用 HSTS。

最外层 TLS 代理必须覆盖客户端传入的协议头，不能直接信任或追加它。Nginx 的 HTTPS 站点示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:18111;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

容器内的 Nginx 会保留外层传来的 `https`，避免 HTTP 内部链路阻止后端下发 Secure 会话 Cookie。Web 端口应通过防火墙限制为仅可信反向代理可访问。若登录后立即返回登录页，检查协议头和浏览器是否收到会话 Cookie；不要通过关闭正式环境的 Secure Cookie 来绕过问题。

如果只在可信内网临时使用 HTTP，可设置 `COOKIE_SECURE=false`；不要把这种配置暴露到互联网。

## 5. 备份

在应用停止或 SQLite 一致性快照条件下备份：

- `data/`
- `secrets/encryption_key`
- 你的 `.env`（按密码材料保管）

`session_secret` 可轮换但会让所有会话退出；`remote_gateway_secret` 可轮换但需要重启 backend 和 remote-gateway。主加密密钥不可随意轮换。

## 6. 更新

```bash
docker compose pull
docker compose up -d --no-build
```

更新前先备份。正式版本发布时可将 `FLEETDECK_IMAGE_TAG` 固定为目标版本；回滚时恢复上一个版本号并重新启动。不要使用第三方 GitHub 代理、非官方 npm 镜像或未知 Docker 镜像加速地址。

## 自建 AI API / CPA

在「AI 助手 → AI API 设置」填写基础地址和 CPA 的 API Key。支持 HTTP/HTTPS、任意端口、域名、IPv4/IPv6 和 Docker 网络别名，无需地址白名单。示例端口 `8317` 仅为示例，按实际 CPA 配置替换。基础地址包含服务要求的 `/v1`，不要填写完整的 `/chat/completions`。

- 宿主机映射端口：`http://宿主机IP:映射端口/v1`。映射必须在 backend 可达的接口上监听；仅绑定宿主机 `127.0.0.1` 的端口不能用宿主机其他 IP 访问。
- Docker 服务名直连：`http://cpa:8317/v1`。使用 CPA 的**容器内部端口**，backend 和 CPA 必须加入同一个用户定义网络，`cpa` 必须是该网络可解析的服务名或别名。
- IPv6：`http://[IPv6地址]:8317/v1`。

已有 CPA 网络时，在 `.env` 设置 `AI_API_NETWORK=实际网络名`，使用附带覆盖配置启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.ai-network.yml up -d
```

此配置保留 FleetDeck 原网络，仅额外把 backend 接入 CPA 网络。该外部网络必须已存在，CPA 也必须在其中；之后更新时仍使用同样的 `-f` 参数。若没有共享网络，可先创建 `ai-api`，并在 CPA 的 Compose 配置中将该网络声明为 external、加入 CPA 服务，保证重建后仍保留连接。

`127.0.0.1` 在 backend 中指向 backend 容器自己。`host.docker.internal` 也可作为地址，但 Linux Docker 通常需在 backend 的 Compose 配置中添加 `extra_hosts: ["host.docker.internal:host-gateway"]`。不使用 Docker 主机网络模式也能连接。

HTTP 会明文传输 API Key、日志和对话，请只用于可信网络并限制 CPA 的端口暴露。HTTPS 仍验证证书，不跟随重定向。开放自定义地址意味着已认证用户能请求 backend 可达的内网服务，因此此管理平台只应提供给可信操作人员。更换 API 地址后需重新填写对应密钥，保存并测试连接；模型列表和聊天请求均使用该地址。

## IPv6 连接

需要 IPv6 时：

```bash
docker compose -f docker-compose.yml -f docker-compose.ipv6.yml up -d
```

可通过 `FLEETDECK_IPV6_SUBNET` 修改 ULA 子网。Docker 宿主机本身也必须正确启用 IPv6。
