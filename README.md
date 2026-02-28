# RalphTon (ScreenClone)

Clone any website from a screenshot using AI-powered iterative refinement with a Live2D conversational interface.

---

## ⚡ TL;DR — Copy-Paste This to Set Up on a New Machine

> **For LLM agents / quick setup:** Copy the entire block below and run it. That's it.

```bash
# 1. Clone and enter the repo
git clone https://github.com/Yeachan-Heo/screenclone-clean.git
cd screenclone-clean
git checkout feature/screenclone   # ← active development branch

# 2. Install system deps (Ubuntu/Debian — run once, needs sudo)
sudo apt-get update && sudo apt-get install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2 \
  libxcomposite1 libxdamage1 libxrandr2 libxss1 \
  fonts-noto-cjk curl git

# 3. Install Node.js 20+ (skip if already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
# Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 24

# 4. Install project dependencies
npm install

# 5. Set API keys (REQUIRED — app won't work without OPENAI_API_KEY)
export OPENAI_API_KEY="sk-your-openai-key"          # Required
export DASHSCOPE_API_KEY="your-dashscope-key"        # Optional (for Live2D TTS voice)

# 6. Verify everything
./setup.sh

# 7. Run the app
npm run dev:all
# Frontend → http://localhost:5173
# Backend  → http://localhost:3001
```

**That's the complete setup.** If `./setup.sh` shows all ✅, you're good to go.

---

## 🚀 Detailed Setup Guide (Ubuntu 24.04 / Zenbook)

### Step 1: Clone the repo

```bash
git clone https://github.com/Yeachan-Heo/screenclone-clean.git
cd screenclone-clean
git checkout feature/screenclone   # active development branch with latest features
```

> **Important:** The `main` branch has the PRD and docs. The `feature/screenclone` branch has the actual working app code. Always checkout `feature/screenclone`.

### Step 2: Install system dependencies

Puppeteer needs Chromium libraries. Run this once:

```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libatk-bridge2.0-0 libdrm2 libgbm1 libasound2 \
  libxcomposite1 libxdamage1 libxrandr2 libxss1 \
  fonts-noto-cjk
```

### Step 3: Install Node.js (if not already installed)

Requires Node.js 20+. Check with `node -v`.

```bash
# Option A: NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Option B: nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
```

### Step 4: Install Node.js dependencies

```bash
npm install
```

This installs all packages including Puppeteer (which auto-downloads Chromium), React, Express, TailwindCSS, etc.

### Step 5: Set environment variables

Create a `.env` file in the project root or export directly:

```bash
# Required — OpenAI API key (for Vision verdict + Codex agent)
export OPENAI_API_KEY="sk-your-openai-key"

# Optional — for OpenWaifu Qwen3 TTS voice
export DASHSCOPE_API_KEY="your-dashscope-key"
```

> **Tip:** Add these to your `~/.bashrc` or `~/.zshrc` so they persist across sessions:
> ```bash
> echo 'export OPENAI_API_KEY="sk-your-key"' >> ~/.bashrc
> source ~/.bashrc
> ```

### Step 6: Verify setup

```bash
./setup.sh
```

This checks:
- ✅ Node.js version
- ✅ npm version
- ✅ Python3 (for OpenWaifu/OLV)
- ✅ uv (for Open-LLM-VTuber)
- ✅ omx/codex CLI
- ✅ ralph-image-analysis ready
- ✅ OpenWaifu ready
- ✅ Puppeteer system deps
- ✅ Environment variables

### Step 7: Run the app (development mode)

```bash
npm run dev:all
```

This starts:
- **Frontend** at `http://localhost:5173` (Vite + React)
- **Backend** at `http://localhost:3001` (Express)

Open `http://localhost:5173` in your browser to use the app.

### Step 8 (Optional): Run ralph loop (AI code generation)

```bash
cd scripts/ralph
./ralph.sh --tool omx --images-dir ../../designs/mockups 1000
```

This starts the ralph iterative loop:
1. Reads `prd.json` for user stories
2. Spawns OMX (Codex) coding agent
3. Generates code → renders → compares with vision AI → repeats
4. Each improving iteration auto-commits

---

## 📋 Prerequisites Checklist

| Tool | Version | Check | Install |
|------|---------|-------|---------|
| Node.js | 20+ | `node -v` | [nodejs.org](https://nodejs.org) or `nvm install 24` |
| npm | 10+ | `npm -v` | Comes with Node.js |
| Python3 | 3.10+ | `python3 --version` | `sudo apt install python3` |
| uv | any | `uv --version` | `pip install uv` |
| omx/codex | any | `omx --version` or `codex --version` | `npm install -g @openai/codex` |
| Git | 2.30+ | `git --version` | `sudo apt install git` |

---

## 🔑 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | **Yes** | OpenAI API key for Vision verdict (GPT-5.3 Codex) + coding agent |
| `DASHSCOPE_API_KEY` | Optional | Alibaba Cloud key for Qwen3 TTS (OpenWaifu voice) |
| `RALPH_MAX_SESSIONS` | Optional | Max concurrent ralph sessions (default: 3) |
| `OPENWAIFU_WS_URL` | Optional | OpenWaifu WebSocket URL (default: `ws://localhost:12393/ws`) |

---

## 📁 Project Structure

```
screenclone-clean/
├── deps/
│   ├── OpenWaifu/              # Live2D + Qwen3 TTS + persona (included)
│   │   ├── install.sh          # Install into Open-LLM-VTuber
│   │   ├── config/conf.yaml    # Character persona config
│   │   ├── src/                # TTS, agent, server modifications
│   │   └── live2d-models/      # WaifuClaw model (16 expressions)
│   └── ralph-image-analysis/   # AI iterative code generation (included)
│       ├── ralph.sh            # Main loop runner
│       ├── skills/             # prd, ralph, visual-verdict skills
│       └── prompt.md           # System prompt
├── scripts/ralph/
│   ├── prd.json                # PRD (21 user stories) — ralph reads this
│   ├── ralph.sh                # Ralph loop runner (copy of deps)
│   ├── prompt.md               # System prompt
│   └── skills/                 # Skills for ralph agent
├── designs/
│   ├── mockup-v3-collapsed.png # UI mockup (OLV settings collapsed)
│   ├── mockup-v3-expanded.png  # UI mockup (OLV settings expanded)
│   └── mockups/                # Per-US mockup images
├── src/                        # Generated by ralph (React + Express)
│   ├── client/                 # React frontend
│   └── server/                 # Express backend
├── setup.sh                    # Environment check script
├── hackathon-init.sh           # Push to hackathon repo
├── PRD.md                      # Product requirements (with images)
├── watchdog-config.json        # Cron watchdog config
└── README.md                   # This file
```

---

## 🔧 OpenWaifu Setup (Optional — for Live2D character)

If you want Cloney (Live2D character with voice) running locally:

### 1. Install Open-LLM-VTuber

```bash
git clone https://github.com/Open-LLM-VTuber/Open-LLM-VTuber.git deps/Open-LLM-VTuber
cd deps/Open-LLM-VTuber
uv sync
cd ../..
```

### 2. Install OpenWaifu pack

```bash
cd deps/OpenWaifu
chmod +x install.sh
./install.sh ../Open-LLM-VTuber
cd ../..
```

### 3. Configure LLM in conf.yaml

Edit `deps/Open-LLM-VTuber/conf.yaml`:

```yaml
openai_compatible_llm:
  base_url: 'https://api.openai.com/v1'    # Your LLM API URL
  llm_api_key: 'sk-your-key'               # Your API key
  model: 'gpt-4o'                           # Model to use
```

### 4. Set TTS API key and start

```bash
export DASHSCOPE_API_KEY="your-dashscope-key"
cd deps/Open-LLM-VTuber
uv run run_server.py
```

OLV server starts at `http://localhost:12393`. The frontend connects via WebSocket at `ws://localhost:12393/ws`.

---

## 🏁 Hackathon Mode

When you get a hackathon repo URL:

```bash
./hackathon-init.sh https://github.com/hackathon-org/team-repo.git
```

This pushes the entire project as an initial commit to the hackathon repo.

---

## 💡 Troubleshooting

### "Cannot find Chrome" when running server
```bash
npx puppeteer browsers install chrome
```

### "EACCES permission denied" on npm install
```bash
sudo chown -R $(whoami) ~/.npm ~/.cache
npm install
```

### ralph.sh permission denied
```bash
chmod +x scripts/ralph/ralph.sh
chmod +x deps/ralph-image-analysis/ralph.sh
```

### OpenWaifu WebSocket connection failed
- Make sure OLV server is running (`uv run run_server.py`)
- Check URL in OLV Settings panel matches server address
- Default: `ws://localhost:12393/ws`

### TTS not working (no voice)
- Set `DASHSCOPE_API_KEY` environment variable
- Get key from [Alibaba Cloud Model Studio](https://www.alibabacloud.com/product/model-studio)

### Low memory (Zenbook 16GB)
- Close unnecessary browser tabs and apps before running
- ralph.sh + Puppeteer + OLV can use ~8GB combined
- Monitor with: `htop` or `free -h`

---

## 📊 How It Works

```
User drops screenshot
        ↓
Vision API analyzes UI structure
        ↓
Ralph loop starts (OMX/Codex agent)
        ↓
┌─────────────────────────────┐
│  Generate HTML/CSS/JS       │
│         ↓                   │
│  Puppeteer renders page     │
│         ↓                   │
│  Vision AI compares images  │
│         ↓                   │
│  Score + feedback → agent   │
│         ↓                   │
│  Score < 90%? → repeat      │
└─────────────────────────────┘
        ↓
Clone complete! Download ZIP or auto-committed to GitHub.
Cloney (Live2D) reports progress with voice + emotions.
```
