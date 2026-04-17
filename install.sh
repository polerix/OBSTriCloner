#!/usr/bin/env bash
# install.sh — OBSTriCloner installer for macOS/Linux
# Idempotent: safe to re-run at any time.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "══════════════════════════════════════════════"
echo "  OBSTriCloner Installer (macOS / Linux)"
echo "══════════════════════════════════════════════"
echo ""

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "❌  Node.js not found."
  echo "    Download from https://nodejs.org/ (v18 or later required)"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌  Node.js $(node --version) is too old — need v18+."
  echo "    Download from https://nodejs.org/"
  exit 1
fi
echo "✅  Node.js $(node --version)"

# ── npm install ───────────────────────────────────────────────────────────────
echo ""
echo "📦  Running npm install..."
npm install
echo "✅  Node dependencies installed"

# ── Python deps (optional) ────────────────────────────────────────────────────
if command -v pip3 &>/dev/null && [ -f "python/requirements.txt" ]; then
  echo ""
  echo "🐍  Installing Python dependencies..."
  pip3 install -r python/requirements.txt --quiet || true
  echo "✅  Python dependencies installed (or already present)"
fi

# ── Run setup wizard ──────────────────────────────────────────────────────────
echo ""
echo "🔧  Starting OBSTriCloner setup wizard..."
echo ""
node setup.js
