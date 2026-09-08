# FleetDeck

FleetDeck is a secure, self-hosted operations console for SSH, RDP, VNC, proxies, bulk command execution, file distribution, and reusable automation playbooks.

> FleetDeck is a substantially modified derivative of [Heavrnl/nexus-terminal](https://github.com/Heavrnl/nexus-terminal). It is not an official upstream release. Attribution and the GPL-3.0 license are retained.

## Highlights

- Password, on-demand password, private key, and encrypted private-key authentication.
- Reusable proxy profiles and grouped server inventory.
- Commands and file uploads across selected hosts or groups with per-host output.
- Reusable playbooks containing ordered commands, attachments, variables, and failure policies.
- Passkeys, TOTP, encrypted credentials, audit logs, rate limiting, origin checks, and hardened containers.

## Deploy

```bash
cp .env.example .env
./scripts/init-secrets.sh
docker compose pull
docker compose up -d --no-build
```

Set `RP_ID`, `RP_ORIGIN`, and `APP_ORIGIN` to the final HTTPS hostname first. See [DEPLOYMENT.md](../DEPLOYMENT.md) for the complete production checklist.

## Development

Node.js 24 LTS is required. Dependencies use the official npm registry.

```bash
npm ci
npm run build
npm run audit:prod
```

## Repository

The official repository is [XMRayLabs/Fleetdeck](https://github.com/XMRayLabs/Fleetdeck). Issues, security advisories, and future releases are published there.

## License

GPL-3.0-only. See [LICENSE](../LICENSE).
