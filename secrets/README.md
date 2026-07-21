# Runtime secrets

Run `scripts/init-secrets.ps1` on Windows or `scripts/init-secrets.sh` on Linux before the first Docker start.

The generated files in this directory are ignored by Git. Back up `encryption_key` offline. Do not email it, paste it into an issue, or store it beside a database backup. `remote_gateway_secret` authenticates private service-to-service calls and may be rotated by restarting the stack after replacing it in both consumers.
