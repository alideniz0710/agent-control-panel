#!/usr/bin/env bash
# PM2-invoked pre-start + start script for agent-control-panel.
#
# Why we need this wrapper:
#   On Mac reboot, the .next/ directory may be missing or stale (Next
#   cleans it, the user runs `npm install` which can wipe builds, etc.).
#   PM2 with `npm run start` directly = next start = crashes immediately
#   because the production build doesn't exist. Crash loop. Panel offline.
#
# What this script does, in order:
#   1. Ensure Prisma migrations are applied to the local SQLite DB
#   2. Ensure the Prisma client matches the current schema (regenerate)
#   3. Build Next.js if .next is missing or older than 24h (skip if fresh)
#   4. Replace this process with `next start` so PM2 manages the right pid
#
# Designed to be idempotent: safe to run on every PM2 restart. Adds
# ~5-30s to boot when build is needed; ~2s when it's already fresh.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "[pm2-start] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting agent-control-panel"
echo "[pm2-start] cwd: $(pwd)"
echo "[pm2-start] node: $(node --version 2>/dev/null || echo missing)"

# 1. Prisma migrate (idempotent; fast no-op if up to date)
if [ -f "package.json" ] && [ -d "prisma" ]; then
  echo "[pm2-start] running prisma migrate deploy..."
  npx prisma migrate deploy 2>&1 | sed 's/^/[pm2-start:prisma] /' || {
    echo "[pm2-start] WARN: prisma migrate failed; continuing (may be empty DB on first boot)"
  }
  echo "[pm2-start] running prisma generate..."
  npx prisma generate 2>&1 | sed 's/^/[pm2-start:prisma] /' || {
    echo "[pm2-start] WARN: prisma generate failed"
  }
fi

# 2. Build Next.js if needed
NEED_BUILD=0
if [ ! -d ".next" ]; then
  echo "[pm2-start] .next missing — full build required"
  NEED_BUILD=1
elif [ ! -f ".next/BUILD_ID" ]; then
  echo "[pm2-start] .next/BUILD_ID missing — build incomplete"
  NEED_BUILD=1
fi

if [ "$NEED_BUILD" = "1" ]; then
  echo "[pm2-start] running next build (this takes 30-60s)..."
  npm run build 2>&1 | sed 's/^/[pm2-start:build] /'
  echo "[pm2-start] build complete"
else
  echo "[pm2-start] .next exists, skipping build"
fi

# 3. Hand off to next start (replace process so PM2 tracks the right pid)
echo "[pm2-start] handing off to next start"
exec npm run start
