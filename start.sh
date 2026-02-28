#!/usr/bin/env bash
# start.sh — One-command setup and launch for ScreenClone (RalphTon)
# Usage: ./start.sh [--skip-tests] [--test-only]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✅ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $*${RESET}"; }
fail() { echo -e "${RED}❌ $*${RESET}"; }
info() { echo -e "${CYAN}$*${RESET}"; }
step() { echo -e "\n${BOLD}[$1/$TOTAL_STEPS] $2${RESET}"; }

# ── Parse flags ───────────────────────────────────────────────────────────────
SKIP_TESTS=false
TEST_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --test-only)  TEST_ONLY=true ;;
    --help|-h)
      echo "Usage: ./start.sh [--skip-tests] [--test-only]"
      echo ""
      echo "  --skip-tests  Skip smoke tests, launch app directly"
      echo "  --test-only   Run smoke tests only, do not launch app"
      echo ""
      exit 0
      ;;
    *)
      fail "Unknown flag: $arg"
      echo "Run ./start.sh --help for usage."
      exit 1
      ;;
  esac
done

if [[ "$SKIP_TESTS" == true && "$TEST_ONLY" == true ]]; then
  fail "Cannot use --skip-tests and --test-only together."
  exit 1
fi

TOTAL_STEPS=8
if [[ "$TEST_ONLY" == true ]]; then
  TOTAL_STEPS=7
fi
if [[ "$SKIP_TESTS" == true ]]; then
  TOTAL_STEPS=7
fi

echo -e "${BOLD}🦞 ScreenClone — One-Command Setup${RESET}"
echo ""

# ── Step 1: Check Node.js 20+ ────────────────────────────────────────────────
step 1 "Checking Node.js..."

if ! command -v node &>/dev/null; then
  fail "Node.js is not installed."
  echo ""
  echo "  Install Node.js 20+ using one of these methods:"
  echo ""
  echo "  Ubuntu/Debian:"
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "    sudo apt-get install -y nodejs"
  echo ""
  echo "  macOS (Homebrew):"
  echo "    brew install node@20"
  echo ""
  echo "  Any OS (nvm):"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "    nvm install 20"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)

if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js $NODE_VERSION is too old. Version 20+ is required."
  echo "  Current: v$NODE_VERSION"
  echo "  Required: v20.0.0 or higher"
  echo ""
  echo "  Upgrade with: nvm install 20 && nvm use 20"
  exit 1
fi

ok "Node.js v$NODE_VERSION"

if ! command -v npm &>/dev/null; then
  fail "npm is not installed (should come with Node.js)."
  exit 1
fi

ok "npm $(npm -v)"

# ── Step 2: Install system dependencies ──────────────────────────────────────
step 2 "Checking system dependencies..."

OS="$(uname -s)"
case "$OS" in
  Linux)
    MISSING_PKGS=()
    for pkg in libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2 libxshmfence1; do
      if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
        MISSING_PKGS+=("$pkg")
      fi
    done

    if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
      warn "Missing Puppeteer/Chromium system libraries: ${MISSING_PKGS[*]}"
      echo "  Installing with apt-get (may prompt for sudo password)..."
      if sudo apt-get install -y "${MISSING_PKGS[@]}"; then
        ok "System dependencies installed"
      else
        warn "Could not install system deps. Chromium may not launch."
        echo "  Fix manually: sudo apt-get install -y ${MISSING_PKGS[*]}"
      fi
    else
      ok "System dependencies present"
    fi
    ;;
  Darwin)
    ok "macOS detected — no system deps needed (Chromium bundles its own)"
    ;;
  *)
    warn "Unknown OS: $OS — skipping system dependency check"
    ;;
esac

# ── Step 3: npm install ──────────────────────────────────────────────────────
step 3 "Installing npm dependencies..."

NEEDS_INSTALL=false

if [[ ! -d node_modules ]]; then
  NEEDS_INSTALL=true
elif [[ ! -f node_modules/.package-lock.json ]]; then
  NEEDS_INSTALL=true
elif [[ package-lock.json -nt node_modules/.package-lock.json ]]; then
  NEEDS_INSTALL=true
fi

if [[ "$NEEDS_INSTALL" == true ]]; then
  info "  Running npm install..."
  if npm install; then
    ok "npm dependencies installed"
  else
    fail "npm install failed."
    echo "  Try deleting node_modules and running again:"
    echo "    rm -rf node_modules && ./start.sh"
    exit 1
  fi
else
  ok "npm dependencies up to date (skipped)"
fi

# ── Step 4: Install Playwright + Chromium ────────────────────────────────────
step 4 "Checking Playwright + Chromium..."

PLAYWRIGHT_BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

if [[ -d "$PLAYWRIGHT_BROWSERS_DIR" ]] && ls "$PLAYWRIGHT_BROWSERS_DIR"/chromium-* &>/dev/null 2>&1; then
  ok "Playwright Chromium already installed"
else
  info "  Installing Playwright Chromium browser..."
  if npx playwright install chromium; then
    ok "Playwright Chromium installed"
  else
    warn "Playwright install failed (chromium). Tests may not run."
    echo "  Try manually: npx playwright install --with-deps chromium"
  fi
fi

# ── Step 5: Run setup.sh ─────────────────────────────────────────────────────
step 5 "Running environment checks (setup.sh)..."

if [[ -x setup.sh ]]; then
  if ./setup.sh; then
    ok "Environment checks passed"
  else
    warn "setup.sh reported issues (see above). Continuing anyway..."
  fi
else
  if [[ -f setup.sh ]]; then
    chmod +x setup.sh
    if ./setup.sh; then
      ok "Environment checks passed"
    else
      warn "setup.sh reported issues (see above). Continuing anyway..."
    fi
  else
    warn "setup.sh not found — skipping environment checks"
  fi
fi

# ── Step 6: Check / prompt for env vars ──────────────────────────────────────
step 6 "Checking environment variables..."

ENV_FILE=".env"

# Load existing .env if present
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
  info "  Loaded existing .env file"
fi

ENV_CHANGED=false

# OPENAI_API_KEY
if [[ -z "${OPENAI_API_KEY:-}" || "${OPENAI_API_KEY:-}" == "your-layofflabs-api-key" ]]; then
  if [[ -t 0 ]]; then
    # Interactive terminal — prompt user
    echo ""
    warn "OPENAI_API_KEY is not set (required for vision analysis + codex)"
    echo -n "  Enter your OpenAI/LayoffLabs API key (or press Enter to skip): "
    read -r USER_API_KEY
    if [[ -n "$USER_API_KEY" ]]; then
      export OPENAI_API_KEY="$USER_API_KEY"
      ENV_CHANGED=true
      ok "OPENAI_API_KEY set"
    else
      warn "OPENAI_API_KEY skipped — vision/codex features will not work"
    fi
  else
    # Non-interactive — just warn
    warn "OPENAI_API_KEY is not set (set it in .env or export before running)"
  fi
else
  ok "OPENAI_API_KEY is set"
fi

# OPENAI_BASE_URL
if [[ -z "${OPENAI_BASE_URL:-}" ]]; then
  export OPENAI_BASE_URL="https://api.layofflabs.com/v1"
  ENV_CHANGED=true
  ok "OPENAI_BASE_URL defaulted to https://api.layofflabs.com/v1"
else
  ok "OPENAI_BASE_URL is set (${OPENAI_BASE_URL})"
fi

# Write/update .env file
if [[ "$ENV_CHANGED" == true ]]; then
  # Build new .env content preserving existing vars not managed by us
  TEMP_ENV=$(mktemp)

  # Write managed vars
  echo "# LayoffLabs API proxy (OpenAI-compatible)" > "$TEMP_ENV"
  echo "OPENAI_API_KEY=${OPENAI_API_KEY:-}" >> "$TEMP_ENV"
  echo "OPENAI_BASE_URL=${OPENAI_BASE_URL:-https://api.layofflabs.com/v1}" >> "$TEMP_ENV"

  # Preserve any other vars from existing .env
  if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line; do
      # Skip empty lines, comments, and our managed vars
      [[ -z "$line" || "$line" == \#* ]] && continue
      VAR_NAME="${line%%=*}"
      case "$VAR_NAME" in
        OPENAI_API_KEY|OPENAI_BASE_URL) continue ;;
        *)
          echo "" >> "$TEMP_ENV"
          echo "$line" >> "$TEMP_ENV"
          ;;
      esac
    done < "$ENV_FILE"
  fi

  mv "$TEMP_ENV" "$ENV_FILE"
  info "  Updated .env file"
fi

# ── Step 7: Run smoke tests ──────────────────────────────────────────────────
if [[ "$SKIP_TESTS" == false ]]; then
  step 7 "Running smoke tests..."

  # Kill any stale dev servers to avoid port conflicts
  fuser -k 3001/tcp 5173/tcp 2>/dev/null || true
  sleep 1

  if npx playwright test tests/smoke/; then
    ok "All smoke tests passed"
  else
    echo ""
    fail "Smoke tests failed! Fix the issues above before launching."
    echo "  Re-run tests:  npx playwright test tests/smoke/"
    echo "  Skip tests:    ./start.sh --skip-tests"

    # Kill any servers Playwright started
    fuser -k 3001/tcp 5173/tcp 2>/dev/null || true
    exit 1
  fi

  # Clean up servers from test run
  fuser -k 3001/tcp 5173/tcp 2>/dev/null || true
  sleep 1
else
  info "  Smoke tests skipped (--skip-tests)"
fi

# ── Step 8: Launch the app ───────────────────────────────────────────────────
if [[ "$TEST_ONLY" == true ]]; then
  echo ""
  ok "Test-only mode — not launching app"
  echo ""
  echo "  To start the app:  npm run dev:all"
  echo "  To re-run tests:   npx playwright test tests/smoke/"
  exit 0
fi

LAUNCH_STEP=$((TOTAL_STEPS))
step "$LAUNCH_STEP" "Launching ScreenClone..."

echo ""
echo -e "${GREEN}${BOLD}✅ Ready! Opening ScreenClone...${RESET}"
echo ""
echo "  Frontend:  http://localhost:5173"
echo "  Backend:   http://localhost:3001"
echo "  Health:    http://localhost:3001/api/health"
echo ""
echo "  Press Ctrl+C to stop."
echo ""

# Source .env so the app has access to env vars
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

exec npm run dev:all
