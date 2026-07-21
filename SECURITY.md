# Security Policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use the repository owner's GitHub Security Advisory “Report a vulnerability” form. If private reporting has not been enabled yet, contact the maintainer privately and share only the minimum reproduction needed.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real credentials, private keys, database backups, or secret files.

## Supported version

Security fixes target the latest release on the default branch. Operators should keep Docker base images and npm dependencies current and run `npm run audit:prod` before deployment.

## Deployment assumptions

FleetDeck is an administrative system. Deploy it behind HTTPS, restrict network access where possible, enable Passkey or TOTP, and never expose backend, remote-gateway, or guacd ports directly.
