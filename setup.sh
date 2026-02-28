#!/usr/bin/env bash
# setup.sh — ScreenClone (RalphTon) environment setup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SETUP_STAGE="${SETUP_STAGE:-${1:-full}}"

RALPH_DIR="deps/ralph-image-analysis"
RALPH_SCRIPT_PATH="$RALPH_DIR/ralph.sh"
RALPH_VISUAL_VERDICT_SOURCE="$RALPH_DIR/skills/visual-verdict"
RALPH_VISUAL_VERDICT_TARGET="scripts/ralph/skills/visual-verdict"

OPENWAIFU_DIR="deps/OpenWaifu"
OPENWAIFU_REPO_URL="${OPENWAIFU_REPO_URL:-https://github.com/HaD0Yun/OpenWaifu.git}"
OPENWAIFU_INSTALL_SCRIPT="$OPENWAIFU_DIR/install.sh"

OLV_REPO_URL="${OLV_REPO_URL:-https://github.com/Open-LLM-VTuber/Open-LLM-VTuber.git}"
OLV_PATH_INPUT="${OLV_PATH:-./deps/Open-LLM-VTuber}"
if [[ "$OLV_PATH_INPUT" = /* ]]; then
  OLV_DIR="$OLV_PATH_INPUT"
else
  OLV_DIR="$SCRIPT_DIR/${OLV_PATH_INPUT#./}"
fi

OPENWAIFU_WS_URL_DEFAULT="ws://localhost:12393/ws"
OPENWAIFU_WS_URL_VALUE="${OPENWAIFU_WS_URL:-$OPENWAIFU_WS_URL_DEFAULT}"

usage() {
  echo "Usage: $0 [full|waifu]"
  echo ""
  echo "Stages:"
  echo "  full  - run full environment checks + ralph + waifu setup (default)"
  echo "  waifu - run only OpenWaifu/Open-LLM-VTuber setup"
}

clone_repo_if_missing() {
  local repo_url="$1"
  local target_dir="$2"
  local label="$3"

  if [[ -d "$target_dir" ]]; then
    echo "  ✅ $label found: $target_dir"
    return 0
  fi

  if ! command -v git &>/dev/null; then
    echo "  ❌ git not found. Cannot clone $label."
    echo "     Install git first, then re-run setup."
    return 1
  fi

  mkdir -p "$(dirname "$target_dir")"
  echo "  ⬇️  Cloning $label..."
  if GIT_TERMINAL_PROMPT=0 git clone --depth 1 "$repo_url" "$target_dir"; then
    echo "  ✅ Cloned $label to $target_dir"
    return 0
  fi

  echo "  ❌ Failed to clone $label from $repo_url"
  echo "     This setup runs non-interactively (GIT_TERMINAL_PROMPT=0)."
  echo "     Check network access or clone manually, then re-run."
  return 1
}

setup_ralph_image_analysis() {
  echo ""
  echo "📦 Setting up ralph-image-analysis..."
  if [[ ! -d "$RALPH_DIR" ]]; then
    echo "  ❌ $RALPH_DIR not found"
    echo "     This project expects the dependency at $RALPH_DIR."
    return 1
  fi

  if [[ ! -f "$RALPH_SCRIPT_PATH" ]]; then
    echo "  ❌ $RALPH_SCRIPT_PATH not found"
    return 1
  fi

  chmod +x "$RALPH_SCRIPT_PATH"
  if [[ ! -x "$RALPH_SCRIPT_PATH" ]]; then
    echo "  ❌ Failed to make $RALPH_SCRIPT_PATH executable"
    return 1
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
}

setup_waifu_stack() {
  local cloned_olv=0
  local missing=()

  echo ""
  echo "📦 Setting up OpenWaifu + Open-LLM-VTuber..."
  echo "  OLV path: $OLV_DIR"

  clone_repo_if_missing "$OPENWAIFU_REPO_URL" "$OPENWAIFU_DIR" "OpenWaifu"

  if [[ ! -f "$OPENWAIFU_INSTALL_SCRIPT" ]]; then
    echo "  ❌ Missing $OPENWAIFU_INSTALL_SCRIPT"
    return 1
  fi

  if [[ ! -x "$OPENWAIFU_INSTALL_SCRIPT" ]]; then
    chmod +x "$OPENWAIFU_INSTALL_SCRIPT"
  fi

  if [[ ! -x "$OPENWAIFU_INSTALL_SCRIPT" ]]; then
    echo "  ❌ $OPENWAIFU_INSTALL_SCRIPT is not executable"
    return 1
  fi
  echo "  ✅ OpenWaifu installer ready: $OPENWAIFU_INSTALL_SCRIPT"

  if [[ ! -d "$OLV_DIR" ]]; then
    clone_repo_if_missing "$OLV_REPO_URL" "$OLV_DIR" "Open-LLM-VTuber"
    cloned_olv=1
  else
    echo "  ✅ Open-LLM-VTuber found: $OLV_DIR"
  fi

  if [[ ! -f "$OLV_DIR/run_server.py" ]]; then
    echo "  ❌ $OLV_DIR does not look like an Open-LLM-VTuber install (missing run_server.py)"
    return 1
  fi

  if command -v uv &>/dev/null; then
    if [[ $cloned_olv -eq 1 ]]; then
      echo "  ⏳ Running uv sync in $OLV_DIR..."
      if (cd "$OLV_DIR" && uv sync); then
        echo "  ✅ uv sync completed"
      else
        echo "  ⚠️  uv sync failed in $OLV_DIR"
        echo "     Fix and retry: cd \"$OLV_DIR\" && uv sync"
      fi
    else
      echo "  ℹ️  Skipping uv sync (Open-LLM-VTuber already exists)"
    fi
  else
    echo "  ⚠️  uv not found; skipped dependency sync for Open-LLM-VTuber."
    echo "     Install uv: pip install uv"
    echo "     Then run: cd \"$OLV_DIR\" && uv sync"
  fi

  echo "  ⏳ Running OpenWaifu installer..."
  (
    cd "$OPENWAIFU_DIR"
    ./install.sh "$OLV_DIR"
  )
  echo "  ✅ OpenWaifu install.sh completed"

  [[ -f "$OLV_DIR/conf.yaml" ]] || missing+=("$OLV_DIR/conf.yaml")
  [[ -f "$OLV_DIR/model_dict.json" ]] || missing+=("$OLV_DIR/model_dict.json")
  [[ -d "$OLV_DIR/live2d-models/WaifuClaw" ]] || missing+=("$OLV_DIR/live2d-models/WaifuClaw/")
  [[ -f "$OLV_DIR/src/open_llm_vtuber/tts/qwen3_tts.py" ]] || missing+=("$OLV_DIR/src/open_llm_vtuber/tts/qwen3_tts.py")

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "  ❌ Post-install verification failed. Missing artifacts:"
    for path in "${missing[@]}"; do
      echo "     - $path"
    done
    return 1
  fi

  echo "  ✅ Verified OpenWaifu artifacts in Open-LLM-VTuber:"
  echo "     - conf.yaml"
  echo "     - model_dict.json"
  echo "     - live2d-models/WaifuClaw/"
  echo "     - src/open_llm_vtuber/tts/qwen3_tts.py"
  echo "  ✅ OpenWaifu + Open-LLM-VTuber ready"
}

case "$SETUP_STAGE" in
  full | waifu) ;;
  -h | --help | help)
    usage
    exit 0
    ;;
  *)
    echo "❌ Unknown setup stage: $SETUP_STAGE"
    usage
    exit 1
    ;;
esac

echo "🦞 ScreenClone Setup"
echo "  Stage: $SETUP_STAGE"
echo ""

if [[ ! -t 0 ]]; then
  echo "ℹ️  Non-interactive shell detected (container/CI friendly mode)."
fi

if [[ "$SETUP_STAGE" == "full" ]]; then
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
  setup_ralph_image_analysis

  # 7) Puppeteer system deps check (Linux only)
  echo ""
  echo "📦 Checking Puppeteer system dependencies..."
  if [[ "$(uname)" == "Linux" ]]; then
    if ! command -v dpkg &>/dev/null; then
      echo "  ⚠️  dpkg not found; skipping apt package checks (common in minimal containers)."
    else
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
  fi
fi

# 8) OpenWaifu + Open-LLM-VTuber setup
setup_waifu_stack

# 9) Environment variables
echo ""
echo "📋 Environment variables:"
[[ -n "${OPENAI_API_KEY:-}" ]] && echo "  ✅ OPENAI_API_KEY set" || echo "  ⚠️  OPENAI_API_KEY not set (required for vision + codex)"
[[ -n "${DASHSCOPE_API_KEY:-}" ]] && echo "  ✅ DASHSCOPE_API_KEY set" || echo "  ⚠️  DASHSCOPE_API_KEY not set (required for Qwen3 TTS; default: unset)"
if [[ -n "${OPENWAIFU_WS_URL:-}" ]]; then
  echo "  ✅ OPENWAIFU_WS_URL set ($OPENWAIFU_WS_URL)"
else
  echo "  ℹ️  OPENWAIFU_WS_URL not set (default: $OPENWAIFU_WS_URL_DEFAULT)"
fi
echo "  ℹ️  OLV_PATH resolved to: $OLV_DIR"

echo ""
echo "🎉 Setup complete!"
echo ""
if [[ "$SETUP_STAGE" == "waifu" ]]; then
  echo "Quick start (waifu-only):"
  echo "  1. export DASHSCOPE_API_KEY='your-key'"
  echo "  2. cd \"$OLV_DIR\" && uv run run_server.py"
  echo "  3. Use OPENWAIFU_WS_URL=${OPENWAIFU_WS_URL_VALUE}"
else
  echo "Quick start:"
  echo "  1. export OPENAI_API_KEY='your-key'"
  echo "  2. Run ralph:  cd scripts/ralph && ./ralph.sh --tool omx 1000"
  echo "  3. Or run dev:  npm install && npm run dev:all"
  echo "  4. Waifu-only setup: npm run setup:waifu"
fi
