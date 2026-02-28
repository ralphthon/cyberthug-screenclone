# Ralph (Image-Aware, Harness-Aware Autonomous Agent Loop)

![Ralph](ralph.webp)

Ralph is an autonomous AI agent loop that repeatedly runs a coding agent (Amp, Claude Code, or Codex CLI) until all stories in `prd.json` are complete.

This fork adds:

- **Image-aware execution** for UI work (`--analyze-image`, `--images-dir`)
- **Harness-aware prompting** for oh-my-claudecode (OMC) and oh-my-codex (OMX)
- **Codex CLI support** (`--tool codex`)

---

## What Changed in This Fork

### Runtime flags (`ralph.sh`)

- `--tool amp|claude|codex` -- select which coding CLI to use (default: `amp`)
- `--analyze-image PATH` -- add one reference image (repeatable)
- `--images-dir DIR` -- recursively collect supported image files from a directory
- `--help` -- show usage and options

### Harness-aware prompting

When oh-my-claudecode or oh-my-codex is installed, each iteration's agent automatically gains:

- **Parallel delegation** -- fire independent sub-tasks simultaneously via `Task()` or `spawn_agent`
- **MCP code intelligence** -- `lsp_diagnostics`, `ast_grep_search`, `lsp_find_references` replace manual CLI commands
- **Cross-iteration memory** -- `project_memory_read/add_note` persists structured learnings across ralph iterations
- **Specialist agent routing** -- delegate to `executor`, `test-engineer`, `designer`, `explore` agents at appropriate model tiers

Ralph auto-detects installed harnesses and injects context. No extra flags needed.

### Prompt/skill behavior updates

- `CLAUDE.md` and `prompt.md` now include:
  - Harness-aware execution guidance (parallel delegation, code intelligence, project memory)
  - Progressive enhancement (works without harnesses, better with them)
  - Browser and image verification instructions
- `skills/prd/SKILL.md` and `skills/ralph/SKILL.md` now include:
  - Parallelization hints in story notes
  - Harness-aware acceptance criteria options
  - Agent execution hints in Technical Considerations

---

## Important Scope Clarification

This feature is **prompt-driven visual validation**, not a built-in pixel-diff engine.

- Ralph provides reference image context to the agent.
- The agent performs visual analysis with available browser/screenshot tooling.
- Final output is pass/fail observations in `progress.txt`.

Harness integration is **prompt-driven capability detection**, not a hard dependency.

- Ralph detects if OMC/OMX is installed and injects context.
- Agents use harness tools when available, fall back to CLI commands when not.
- Everything works without any harness installed.

---

## Prerequisites

- Bash-compatible runtime (`bash`, Git Bash, WSL, Linux, macOS)
- `jq`
- One coding CLI:
  - [Amp CLI](https://ampcode.com) (default)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  - [Codex CLI](https://github.com/openai/codex) (`@openai/codex`)
- A git repository for your project

Optional (for enhanced capabilities):

- [oh-my-claudecode](https://github.com/nicobailon/oh-my-claudecode) -- for Claude Code harness features
- [oh-my-codex](https://github.com/nicobailon/oh-my-codex) -- for Codex/Amp harness features
- Browser automation/screenshot capability for UI verification

---

## Setup

### Option 1: Copy Ralph into your project

```bash
mkdir -p scripts/ralph
cp /path/to/ralph/ralph.sh scripts/ralph/
cp /path/to/ralph/prompt.md scripts/ralph/prompt.md
cp /path/to/ralph/CLAUDE.md scripts/ralph/CLAUDE.md
chmod +x scripts/ralph/ralph.sh
```

### Option 2: Install skills globally

For Amp:
```bash
cp -r /path/to/ralph/skills/prd ~/.config/amp/skills/
cp -r /path/to/ralph/skills/ralph ~/.config/amp/skills/
```

For Claude Code:
```bash
cp -r /path/to/ralph/skills/prd ~/.claude/skills/
cp -r /path/to/ralph/skills/ralph ~/.claude/skills/
```

### Option 3: Claude Code marketplace

```bash
/plugin marketplace add snarktank/ralph
/plugin install ralph-skills@ralph-marketplace
```

---

## Usage

```bash
# Default (Amp, 10 iterations)
./scripts/ralph/ralph.sh

# Claude Code with 20 iterations
./scripts/ralph/ralph.sh --tool claude 20

# Codex CLI with 15 iterations
./scripts/ralph/ralph.sh --tool codex 15

# One reference image
./scripts/ralph/ralph.sh --analyze-image ./designs/dashboard.png 10

# Multiple reference images
./scripts/ralph/ralph.sh \
  --analyze-image ./designs/desktop.png \
  --analyze-image ./designs/mobile.png \
  10

# All images in a directory (recursive)
./scripts/ralph/ralph.sh --images-dir ./designs 10

# Combine both sources
./scripts/ralph/ralph.sh --images-dir ./designs --analyze-image ./extra/header.png 10

# Help
./scripts/ralph/ralph.sh --help
```

Valid `--tool` values: `amp`, `claude`, `codex`

Supported extensions for `--images-dir`:
`png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`

---

## How It Works

### Core Ralph Loop

Each iteration:

1. Reads `prd.json`
2. Picks highest-priority story with `passes: false`
3. Implements one story
4. Runs quality checks
5. Commits if checks pass
6. Marks story as `passes: true`
7. Appends to `progress.txt`
8. Repeats until complete or max iterations reached

Completion signal:

```xml
<promise>COMPLETE</promise>
```

### Image Analysis

1. Ralph collects image paths from `--analyze-image` and/or `--images-dir`.
2. Missing files/folders produce warnings; run continues.
3. Duplicate image paths are removed.
4. Ralph builds a runtime prompt from the tool-specific prompt file.
5. If images exist, Ralph appends an **Image Analysis Context** section listing absolute image paths.
6. The agent uses that context for UI verification and logs visual pass/fail observations to `progress.txt`.

### Harness Detection

1. Ralph checks if oh-my-claudecode or oh-my-codex is installed.
2. For `--tool claude`: checks `~/.claude/plugins/` for OMC plugin.
3. For `--tool codex` or `--tool amp`: checks if `omx` command is available.
4. If detected, Ralph appends a **Harness Detected** section to the runtime prompt listing available capabilities.
5. The agent uses harness tools when available, falls back gracefully when not.

### Tool-Specific Prompt Files

| Tool | Prompt File | Knowledge Files | Harness |
|------|-------------|-----------------|---------|
| `amp` | `prompt.md` | `AGENTS.md` | OMX |
| `claude` | `CLAUDE.md` | `CLAUDE.md` | OMC |
| `codex` | `CODEX.md` (or `CLAUDE.md` fallback) | `AGENTS.md` | OMX |

---

## Recommended UI Acceptance Criteria

For UI stories in `prd.json`, include:

- `Verify in browser using dev-browser skill`
- `Analyze screenshots vs reference images (when provided) and note pass/fail`
- `Typecheck passes`

Keep stories small enough to finish in one iteration.

---

## Troubleshooting

### `Warning: image not found: ...`

- Check file path and filename
- Try absolute path
- Confirm file exists before running

### `Warning: images directory not found: ...`

- Verify directory exists
- Re-check relative path location

### Images supplied but no visual notes in `progress.txt`

- Ensure current story is UI-related
- Ensure browser verification tools are available
- Ensure acceptance criteria require image analysis

### `Error: Invalid tool`

Only `amp`, `claude`, and `codex` are supported.

### Harness not detected

- For OMC: ensure `oh-my-claudecode` is installed as a Claude Code plugin at `~/.claude/plugins/`
- For OMX: ensure `omx` command is in your PATH (`npm install -g oh-my-codex`)

### Max iterations reached

- Review blockers in `progress.txt`
- Split oversized stories in `prd.json`
- Re-run with higher iteration count

---

## Migration from original Ralph

1. Replace:
   - `ralph.sh`
   - `prompt.md`
   - `CLAUDE.md`
   - `skills/`
2. Keep existing `prd.json` and `progress.txt`
3. Add image-analysis criteria to UI stories
4. Run with `--analyze-image` and/or `--images-dir`
5. Install OMC/OMX for enhanced agent capabilities (optional)

Without image flags or harnesses, behavior remains compatible with original Ralph loop.

---

## Flowchart

Interactive flowchart is still available:

- Source: `flowchart/`
- Hosted: https://snarktank.github.io/ralph/

---

## References

- [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/)
- [Amp documentation](https://ampcode.com/manual)
- [Claude Code documentation](https://docs.anthropic.com/en/docs/claude-code)
- [Codex CLI](https://github.com/openai/codex)
- [oh-my-claudecode](https://github.com/nicobailon/oh-my-claudecode)
- [oh-my-codex](https://github.com/nicobailon/oh-my-codex)
