# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs AI coding tools (Amp, Claude Code, or Codex CLI) repeatedly until all PRD items are complete. Each iteration is a fresh instance with clean context.

When oh-my-claudecode (OMC) or oh-my-codex (OMX) is installed, agents gain parallel delegation, MCP code intelligence, and cross-iteration project memory automatically.

## Commands

```bash
# Run the flowchart dev server
cd flowchart && npm run dev

# Build the flowchart
cd flowchart && npm run build

# Run Ralph with Amp (default)
./ralph.sh [max_iterations]

# Run Ralph with Claude Code
./ralph.sh --tool claude [max_iterations]

# Run Ralph with Codex CLI
./ralph.sh --tool codex [max_iterations]

# Run with reference images for UI verification
./ralph.sh --analyze-image ./designs/mockup.png --tool claude 10
```

## Key Files

- `ralph.sh` - The bash loop that spawns fresh AI instances (supports `--tool amp`, `--tool claude`, `--tool codex`)
- `prompt.md` - Instructions given to each Amp instance (harness-aware for OMX)
- `CLAUDE.md` - Instructions given to each Claude Code instance (harness-aware for OMC)
- `prd.json.example` - Example PRD format
- `skills/prd/SKILL.md` - Skill for generating PRDs from feature descriptions
- `skills/ralph/SKILL.md` - Skill for converting PRDs to prd.json format
- `flowchart/` - Interactive React Flow diagram explaining how Ralph works

## Architecture

```
ralph.sh (bash loop)
  |
  |-- Detects harness (OMC/OMX) availability
  |-- Selects prompt file based on --tool flag
  |-- Injects image context (if --analyze-image/--images-dir)
  |-- Injects harness context (if OMC/OMX detected)
  |
  |-- Per iteration:
  |     |-- Spawns fresh agent (amp/claude/codex)
  |     |-- Agent reads prd.json, picks story, implements
  |     |-- Agent uses harness tools if available:
  |     |     |-- Task()/spawn_agent for parallel sub-tasks
  |     |     |-- lsp_diagnostics for typechecking
  |     |     |-- project_memory for cross-iteration learning
  |     |-- Agent commits, marks story passes: true
  |     |-- Checks for <promise>COMPLETE</promise>
  |
  |-- State persists via: git history, progress.txt, prd.json, project_memory
```

## Flowchart

The `flowchart/` directory contains an interactive visualization built with React Flow. It's designed for presentations - click through to reveal each step with animations.

To run locally:
```bash
cd flowchart
npm install
npm run dev
```

## Patterns

- Each iteration spawns a fresh AI instance with clean context
- Memory persists via git history, `progress.txt`, `prd.json`, and (with harness) `project_memory`
- Stories should be small enough to complete in one context window
- Always update AGENTS.md/CLAUDE.md with discovered patterns for future iterations
- Keep `prompt.md` and `CLAUDE.md` harness guidance in sync so both tools follow the same execution rules
- Use `--analyze-image` / `--images-dir` with `ralph.sh` to inject reference-image context for UI visual analysis
- When harness is available, agents should prefer MCP tools (`lsp_diagnostics`, `ast_grep_search`) over manual CLI commands
- Cross-iteration learning works best when agents use both `progress.txt` AND `project_memory_add_note`
