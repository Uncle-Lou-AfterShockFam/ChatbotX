#!/bin/bash
set -euo pipefail

cd "${REALTIME_APP_DIR:-/app/apps/realtime}"

# `partykit dev` hands the bundled party code its env from a literal .env
# FILE in this directory, never from the container's process environment
# (docs/realtime.md). The image ships no .env, so write it here: without
# the secret the parties fail `Invalid environment variables` at boot.
: "${REALTIME_BROADCAST_SECRET:?REALTIME_BROADCAST_SECRET is required}"
umask 077
printf 'REALTIME_BROADCAST_SECRET=%s\n' "$REALTIME_BROADCAST_SECRET" > .env

# The lockfile-pinned partykit (`pnpm exec`), never a registry download at
# boot. exec: partykit is PID 1 and receives stop signals.
# Any NODE_OPTIONS from the environment (the memory cap) are kept.
export NODE_OPTIONS="--no-node-snapshot ${NODE_OPTIONS:-}"
export HOSTNAME="${HOSTNAME:-0.0.0.0}"
export PORT="${PORT:-1999}"
exec pnpm exec partykit dev
