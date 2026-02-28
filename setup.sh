#!/usr/bin/env bash
# setup.sh — ScreenClone (RalphTon) environment setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RALPH_DIR="deps/ralph-image-analysis"
RALPH_SCRIPT_PATH="$RALPH_DIR/ralph.sh"
RALPH_VISUAL_VERDICT_SOURCE="$RALPH_DIR/skills/visual-verdict"
RALPH_VISUAL_VERDICT_TARGET="scripts/ralph/skills/visual-verdict"

echo "🦞 ScreenClone Setup"
echo ""

# 1) Check Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  echo "✅ Node.js: $NODE_VER"
else
  echo "❌ Node.js not found. Install Node.js 20+ first."
  exit 1
fi

# 2) Check npm
if command -v npm &>/dev/null; then
  echo "✅ npm: $(npm -v)"
else
  echo "❌ npm not found."
  exit 1
fi

# 3) Check Python (for OLV)
if command -v python3 &>/dev/null; then
  echo "✅ Python: $(python3 --version)"
else
  echo "⚠️  Python3 not found (needed for OpenWaifu/OLV)"
fi

# 4) Check uv (for OLV)
if command -v uv &>/dev/null; then
  echo "✅ uv: $(uv --version)"
else
  echo "⚠️  uv not found (needed for Open-LLM-VTuber: pip install uv)"
fi

# 5) Check omx/codex CLI
if command -v omx &>/dev/null; then
  echo "✅ omx CLI found"
elif command -v codex &>/dev/null; then
  echo "✅ codex CLI found (alias to omx)"
else
  echo "⚠️  omx/codex CLI not found (needed for ralph --tool omx)"
fi

# 6) ralph-image-analysis setup
echo ""
echo "📦 Setting up ralph-image-analysis..."
if [[ ! -d "$RALPH_DIR" ]]; then
  echo "  ❌ $RALPH_DIR not found"
  echo "     This project expects the dependency at $RALPH_DIR."
  exit 1
fi

if [[ ! -f "$RALPH_SCRIPT_PATH" ]]; then
  echo "  ❌ $RALPH_SCRIPT_PATH not found"
  exit 1
fi

chmod +x "$RALPH_SCRIPT_PATH"
if [[ ! -x "$RALPH_SCRIPT_PATH" ]]; then
  echo "  ❌ Failed to make $RALPH_SCRIPT_PATH executable"
  exit 1
fi

if [[ -f "$RALPH_DIR/package.json" ]]; then
  (
    cd "$RALPH_DIR"
    npm install
  )
  echo "  ✅ Installed ralph-image-analysis npm dependencies"
else
  echo "  ℹ️  No package.json in $RALPH_DIR (skipping npm install)"
fi

if [[ -d "$RALPH_VISUAL_VERDICT_SOURCE" ]]; then
  mkdir -p "$(dirname "$RALPH_VISUAL_VERDICT_TARGET")"
  if [[ ! -f "$RALPH_VISUAL_VERDICT_TARGET/SKILL.md" ]] || [[ "$RALPH_VISUAL_VERDICT_SOURCE/SKILL.md" -nt "$RALPH_VISUAL_VERDICT_TARGET/SKILL.md" ]]; then
    rm -rf "$RALPH_VISUAL_VERDICT_TARGET"
    cp -R "$RALPH_VISUAL_VERDICT_SOURCE" "$RALPH_VISUAL_VERDICT_TARGET"
    echo "  ✅ Synced visual-verdict skill to scripts/ralph/skills"
  else
    echo "  ✅ visual-verdict skill already up to date"
  fi
else
  echo "  ⚠️  visual-verdict skill source missing at $RALPH_VISUAL_VERDICT_SOURCE"
fi
echo "  ✅ ralph-image-analysis ready"

# 7) Puppeteer system deps check (Linux only)
echo ""
echo "📦 Checking Puppeteer system dependencies..."
if [[ "$(uname)" == "Linux" ]]; then
  MISSING_DEPS=""
  for lib in libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2; do
    if ! dpkg -l "$lib" &>/dev/null 2>&1; then
      MISSING_DEPS="$MISSING_DEPS $lib"
    fi
  done
  if [[ -n "$MISSING_DEPS" ]]; then
    echo "  ⚠️  Missing Puppeteer deps:$MISSING_DEPS"
    echo "  Fix: sudo apt-get install -y$MISSING_DEPS"
  else
    echo "  ✅ Puppeteer system deps OK"
  fi
fi

# 8) OpenWaifu check
echo ""
if [[ -d deps/OpenWaifu ]]; then
  echo "✅ OpenWaifu found"
  echo "  To install into Open-LLM-VTuber:"
  echo "    cd deps/OpenWaifu && ./install.sh /path/to/Open-LLM-VTuber"
else
  echo "⚠️  deps/OpenWaifu not found"
fi

# 9) Environment variables
echo ""
echo "📋 Environment variables:"
[[ -n "${OPENAI_API_KEY:-}" ]] && echo "  ✅ OPENAI_API_KEY set" || echo "  ⚠️  OPENAI_API_KEY not set (required for vision + codex)"
[[ -n "${DASHSCOPE_API_KEY:-}" ]] && echo "  ✅ DASHSCOPE_API_KEY set" || echo "  ⚠️  DASHSCOPE_API_KEY not set (needed for Qwen3 TTS)"

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Quick start:"
echo "  1. export OPENAI_API_KEY='your-key'"
echo "  2. Run ralph:  cd scripts/ralph && ./ralph.sh --tool omx 1000"
echo "  3. Or run dev:  npm install && npm run dev:all"
