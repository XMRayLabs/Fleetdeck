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

## IPv6

需要 IPv6 时：

```bash
docker compose -f docker-compose.yml -f docker-compose.ipv6.yml up -d
```

可通过 `FLEETDECK_IPV6_SUBNET` 修改 ULA 子网。Docker 宿主机本身也必须正确启用 IPv6。
