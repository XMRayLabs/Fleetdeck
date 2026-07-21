# Contributing

FleetDeck is licensed under GPL-3.0-only. By contributing, you agree that your changes are distributed under that license.

1. Create a focused branch.
2. Install with Node.js 24 LTS using `npm ci`.
3. Run `npm run build` and `npm run audit:prod`.
4. Never commit `.env`, `data/`, `secrets/`, credentials, private infrastructure addresses, or production logs.
5. Explain security-sensitive behavior and migration impact in the pull request.

Use only official project registries and upstream download locations. Do not add transparent GitHub proxies, regional package mirrors, or installer scripts fetched from untrusted domains.
