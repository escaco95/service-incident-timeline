#!/usr/bin/env bash
# Linux runner + SSH + systemd example. No real deployment values are included.
set -euo pipefail

: "${DEPLOY_HOST:?Set DEPLOY_HOST}"
: "${DEPLOY_USER:?Set DEPLOY_USER}"
: "${DEPLOY_PATH:?Set DEPLOY_PATH}"
: "${DEPLOY_SERVICE:?Set DEPLOY_SERVICE}"
: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY}"
: "${DEPLOY_KNOWN_HOSTS:?Set DEPLOY_KNOWN_HOSTS}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
work=${1:?Pass the runner temporary directory}
port=${DEPLOY_PORT:-22}

# Values enter a remote shell command; restrict their character sets explicitly.
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]] || { echo 'Invalid DEPLOY_HOST'; exit 1; }
[[ "$DEPLOY_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || { echo 'Invalid DEPLOY_USER'; exit 1; }
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((10#$port >= 1 && 10#$port <= 65535)) || { echo 'Invalid DEPLOY_PORT'; exit 1; }
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ && "$DEPLOY_PATH" != / && "$DEPLOY_PATH" != */../* && "$DEPLOY_PATH" != */.. ]] || { echo 'Invalid DEPLOY_PATH'; exit 1; }
[[ "$DEPLOY_SERVICE" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]] || { echo 'Invalid DEPLOY_SERVICE'; exit 1; }
[[ "$GITHUB_SHA" =~ ^[a-fA-F0-9]{40,64}$ ]] || { echo 'Invalid commit'; exit 1; }

umask 077
printf '%s\n' "$DEPLOY_SSH_KEY" > "$work/deploy-key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known-hosts"
unset DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS
ssh_options=(-p "$port" -i "$work/deploy-key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$work/known-hosts" -o ConnectTimeout=15)
target="${DEPLOY_USER}@${DEPLOY_HOST}"
release="$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_SHA:0:12}"
destination="${DEPLOY_PATH%/}/releases/$release"

ssh "${ssh_options[@]}" "$target" "mkdir -p '$destination'"
git -C "$work/source" archive --format=tar HEAD | ssh "${ssh_options[@]}" "$target" "tar -xf - -C '$destination'"
ssh "${ssh_options[@]}" "$target" \
  "node --check '$destination/server.mjs' && ln -s '$destination' '${DEPLOY_PATH%/}/.current-$release' && mv -Tf '${DEPLOY_PATH%/}/.current-$release' '${DEPLOY_PATH%/}/current' && sudo -n systemctl restart '$DEPLOY_SERVICE' && sudo -n systemctl is-active --quiet '$DEPLOY_SERVICE'"
echo 'Source deployed. Open the app and enter its encryption password to unlock the data.'
