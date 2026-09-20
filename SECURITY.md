# Security Policy

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use the repository owner's GitHub Security Advisory “Report a vulnerability” form. If private reporting has not been enabled yet, contact the maintainer privately and share only the minimum reproduction needed.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real credentials, private keys, database backups, or secret files.

## Supported version

Security fixes target the latest release on the default branch. Operators should keep Docker base images and npm dependencies current and run `npm run audit:prod` before deployment.

## AI assistance boundary

- AI is optional and disabled until a user saves their own API configuration. This version supports public HTTPS port 443 Chat Completions-compatible endpoints only. DNS results are checked and pinned; private/reserved addresses, redirects and TLS verification bypasses are not allowed.
- API keys are encrypted with the deployment encryption key, never returned by the config API, and cleared from the input after saving. Preserve the deployment encryption key securely; database encryption does not defend against a compromised application host.
- Only explicitly supplied task/log text and target count are sent with fixed safety/format instructions. Passwords used for SSH are not model inputs. Redaction runs on the backend before a separate send confirmation. Heuristics and known-secret matching cannot guarantee removal of unknown, encoded, split or business-specific secrets. Human preview and the chosen provider's data retention policy remain important.
- Logs/model output are untrusted. Output is rendered as text, not HTML. The model has no direct SSH tool. Every execution requires a short-lived, single-use, user-bound approval for server-held commands and target IDs. Connection/key/proxy configuration changes invalidate pending execution approvals. Root credentials still grant root effects; this is not a command sandbox or an infallible harmful-command detector.
- AI-generated task output is redacted before encrypted persistence, including supplied temporary credentials. Existing non-AI jobs keep their previous output policy. Commands/results are stored through orchestration; AI prompts/replies are not persisted in AI activity history. In-memory pending previews expire after ten minutes; restarting the backend invalidates them. Cancellation cannot undo changes already applied remotely.
- There are no unapproved autonomous repair loops. Sending execution output for another analysis requires a fresh preview and confirmation. SSH commands execute in new execution channels, not the interactive shell's state.

## Deployment assumptions

FleetDeck is an administrative system. Deploy it behind HTTPS, restrict network access where possible, enable Passkey or TOTP, and never expose backend, remote-gateway, or guacd ports directly.
