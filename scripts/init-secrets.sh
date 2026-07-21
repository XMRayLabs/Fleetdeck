#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(dirname -- "$script_dir")
secrets_dir="$project_root/secrets"
mkdir -p "$secrets_dir"
umask 077

if [ ! -s "$secrets_dir/encryption_key" ]; then
  openssl rand -hex 32 > "$secrets_dir/encryption_key"
  printf '%s\n' "Created $secrets_dir/encryption_key"
else
  printf '%s\n' "Keeping existing $secrets_dir/encryption_key"
fi

if [ ! -s "$secrets_dir/session_secret" ]; then
  openssl rand -hex 64 > "$secrets_dir/session_secret"
  printf '%s\n' "Created $secrets_dir/session_secret"
else
  printf '%s\n' "Keeping existing $secrets_dir/session_secret"
fi

if [ ! -s "$secrets_dir/remote_gateway_secret" ]; then
  openssl rand -hex 48 > "$secrets_dir/remote_gateway_secret"
  printf '%s\n' "Created $secrets_dir/remote_gateway_secret"
else
  printf '%s\n' "Keeping existing $secrets_dir/remote_gateway_secret"
fi

printf '%s\n' 'Secrets initialized. Back up encryption_key offline; stored credentials cannot be recovered without it.'
