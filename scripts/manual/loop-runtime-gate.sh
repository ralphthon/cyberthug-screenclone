#!/usr/bin/env bash
# Runtime/dependency go-no-go gate for Ralph loop development.
#
# This script verifies the minimum environment required before proceeding with
# Step 2+ loop orchestration work.
#
# Usage:
#   bash scripts/manual/loop-runtime-gate.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

FAILURES=()
WARNINGS=()

pass() {
  printf '✅ %s\n' "$1"
}

warn() {
  WARNINGS+=("$1")
  printf '⚠️  %s\n' "$1"
}

fail() {
  FAILURES+=("$1")
  printf '❌ %s\n' "$1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

is_placeholder_value() {
  local value="${1:-}"
  [[ -z "$value" ]] && return 0
  [[ "$value" == *"your-"* ]] && return 0
  [[ "$value" == *"YOUR_"* ]] && return 0
  [[ "$value" == *"example"* ]] && return 0
  [[ "$value" == *"changeme"* ]] && return 0
  return 1
}

maybe_load_dotenv() {
  local dotenv_path="$ROOT_DIR/.env"
  if [[ ! -f "$dotenv_path" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "${line// }" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue

    local key="${line%%=*}"
    key="${key//[[:space:]]/}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ -n "${!key:-}" ]]; then
      continue
    fi

    local value="${line#*=}"
    value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "$value" =~ ^\".*\"$ || "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done <"$dotenv_path"
}

echo "🔎 Ralph Loop Runtime Gate"
echo "   root: $ROOT_DIR"
echo

maybe_load_dotenv

echo "== Toolchain =="
if command_exists node; then
  NODE_VERSION="$(node -p "process.versions.node" 2>/dev/null || true)"
  NODE_MAJOR="${NODE_VERSION%%.*}"
  if [[ -n "$NODE_VERSION" && "$NODE_MAJOR" -ge 20 ]]; then
    pass "Node.js $NODE_VERSION (>= 20)"
  else
    fail "Node.js >= 20 required (found: ${NODE_VERSION:-unknown})."
  fi
else
  fail "node command missing. Install Node.js 20+."
fi

if command_exists npm; then
  NPM_VERSION="$(npm -v 2>/dev/null || true)"
  NPM_MAJOR="${NPM_VERSION%%.*}"
  if [[ -n "$NPM_VERSION" && "$NPM_MAJOR" -ge 10 ]]; then
    pass "npm $NPM_VERSION (>= 10)"
  else
    fail "npm >= 10 required (found: ${NPM_VERSION:-unknown})."
  fi
else
  fail "npm command missing."
fi

if command_exists git; then
  pass "git available"
else
  fail "git command missing."
fi

if command_exists omx; then
  pass "omx CLI available"
else
  fail "omx CLI is required for orchestrated runs (--tool omx). Install: npm i -g oh-my-codex"
fi

echo
echo "== Runtime environment =="

if [[ -d /tmp && -w /tmp ]]; then
  PROBE_FILE="$(mktemp /tmp/ralph-gate.XXXXXX 2>/dev/null || true)"
  if [[ -n "${PROBE_FILE:-}" ]]; then
    if echo "ok" >"$PROBE_FILE"; then
      pass "/tmp is writable"
    else
      fail "/tmp exists but is not writable."
    fi
    rm -f "$PROBE_FILE"
  else
    fail "Could not create a temporary file in /tmp."
  fi
else
  fail "/tmp is missing or not writable."
fi

if [[ -d "$ROOT_DIR/node_modules" ]]; then
  pass "node_modules present"
else
  fail "node_modules not found. Run: npm install"
fi

REQUIRED_PATHS=(
  "scripts/ralph/ralph.sh"
  "scripts/ralph/prd.json"
  "src/server/index.ts"
  "src/client/src/App.tsx"
)

for rel_path in "${REQUIRED_PATHS[@]}"; do
  if [[ -e "$ROOT_DIR/$rel_path" ]]; then
    pass "Found $rel_path"
  else
    fail "Missing required path: $rel_path"
  fi
done

echo
echo "== Environment keys =="
if is_placeholder_value "${OPENAI_API_KEY:-}"; then
  fail "OPENAI_API_KEY is missing or placeholder. Configure a real key before Step 2+."
else
  pass "OPENAI_API_KEY configured"
fi

if is_placeholder_value "${ANTHROPIC_API_KEY:-}"; then
  warn "ANTHROPIC_API_KEY not configured. Anthropic fallback will be unavailable."
else
  pass "ANTHROPIC_API_KEY configured (fallback ready)"
fi

OPENAI_VISION_EFFECTIVE="${OPENAI_VISION_MODEL:-gpt-5.3-codex}"
pass "OpenAI vision model: ${OPENAI_VISION_EFFECTIVE}"

echo
echo "== Summary =="
if (( ${#FAILURES[@]} > 0 )); then
  echo "Gate FAILED with ${#FAILURES[@]} issue(s):"
  for item in "${FAILURES[@]}"; do
    echo "  - $item"
  done

  if (( ${#WARNINGS[@]} > 0 )); then
    echo
    echo "Warnings (${#WARNINGS[@]}):"
    for item in "${WARNINGS[@]}"; do
      echo "  - $item"
    done
  fi

  echo
  echo "Action required: resolve failures, then re-run:"
  echo "  bash scripts/manual/loop-runtime-gate.sh"
  exit 1
fi

echo "Gate PASSED. Step 2+ implementation can proceed."
if (( ${#WARNINGS[@]} > 0 )); then
  echo "Warnings (${#WARNINGS[@]}):"
  for item in "${WARNINGS[@]}"; do
    echo "  - $item"
  done
fi
