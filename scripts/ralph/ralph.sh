#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude|codex|omx] [--analyze-image PATH] [--images-dir DIR] [max_iterations]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

show_help() {
  cat <<EOF
Usage: ./ralph.sh [--tool amp|claude|codex|omx] [--analyze-image PATH] [--images-dir DIR] [max_iterations]

Options:
  --tool amp|claude|codex|omx  Select coding tool (default: amp)
  --analyze-image PATH         Add a reference image for visual analysis (repeatable)
  --images-dir DIR             Add all image files in a directory for visual analysis
  -h, --help                   Show this help message

Tools:
  amp      Amp CLI (default)   - uses prompt.md
  claude   Claude Code CLI     - uses CLAUDE.md
  codex    Codex CLI (bare)    - uses CODEX.md (falls back to CLAUDE.md)
  omx      oh-my-codex (OMX)   - codex + MCP tools, hooks, project memory

When oh-my-claudecode (OMC) or oh-my-codex (OMX) are installed, agents
automatically gain access to parallel delegation, MCP code intelligence,
and cross-iteration project memory. No extra flags needed.
EOF
}

# Parse arguments
TOOL="amp"  # Default to amp for backwards compatibility
MAX_ITERATIONS=10
IMAGE_PATHS=()
IMAGES_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    --analyze-image)
      IMAGE_PATHS+=("$2")
      shift 2
      ;;
    --analyze-image=*)
      IMAGE_PATHS+=("${1#*=}")
      shift
      ;;
    --images-dir)
      IMAGES_DIR="$2"
      shift 2
      ;;
    --images-dir=*)
      IMAGES_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      else
        echo "Error: Unknown argument '$1'"
        show_help
        exit 1
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" && "$TOOL" != "codex" && "$TOOL" != "omx" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp', 'claude', 'codex', or 'omx'."
  exit 1
fi

# omx requires the omx CLI to be installed
if [[ "$TOOL" == "omx" ]] && ! command -v omx &>/dev/null; then
  echo "Error: 'omx' command not found. Install oh-my-codex: npm install -g oh-my-codex"
  exit 1
fi
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"

COLLECTED_IMAGES=()

add_image_if_exists() {
  local image_path="$1"
  if [ -z "$image_path" ]; then
    return
  fi

  local candidate_path="$image_path"
  if [ ! -f "$candidate_path" ] && [ -f "$SCRIPT_DIR/$image_path" ]; then
    candidate_path="$SCRIPT_DIR/$image_path"
  fi

  if [ ! -f "$candidate_path" ]; then
    echo "Warning: image not found: $image_path"
    return
  fi

  local abs_path
  abs_path="$(cd "$(dirname "$candidate_path")" && pwd)/$(basename "$candidate_path")"

  for existing in "${COLLECTED_IMAGES[@]}"; do
    if [ "$existing" = "$abs_path" ]; then
      return
    fi
  done

  COLLECTED_IMAGES+=("$abs_path")
}

for image_path in "${IMAGE_PATHS[@]}"; do
  add_image_if_exists "$image_path"
done

if [ -n "$IMAGES_DIR" ]; then
  SEARCH_DIR="$IMAGES_DIR"
  if [ ! -d "$SEARCH_DIR" ] && [ -d "$SCRIPT_DIR/$IMAGES_DIR" ]; then
    SEARCH_DIR="$SCRIPT_DIR/$IMAGES_DIR"
  fi

  if [ ! -d "$SEARCH_DIR" ]; then
    echo "Warning: images directory not found: $IMAGES_DIR"
  else
    while IFS= read -r -d '' image_file; do
      add_image_if_exists "$image_file"
    done < <(find "$SEARCH_DIR" -type f \( -iname "*.png" -o -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.webp" -o -iname "*.gif" -o -iname "*.bmp" \) -print0)
  fi
fi

# Select base prompt file based on tool
BASE_PROMPT_FILE="$SCRIPT_DIR/prompt.md"
if [[ "$TOOL" == "claude" ]]; then
  BASE_PROMPT_FILE="$SCRIPT_DIR/CLAUDE.md"
elif [[ "$TOOL" == "codex" || "$TOOL" == "omx" ]]; then
  # Prefer CODEX.md if it exists, fall back to CLAUDE.md
  if [ -f "$SCRIPT_DIR/CODEX.md" ]; then
    BASE_PROMPT_FILE="$SCRIPT_DIR/CODEX.md"
  else
    BASE_PROMPT_FILE="$SCRIPT_DIR/CLAUDE.md"
  fi
fi

RUNTIME_PROMPT_FILE="$(mktemp)"
trap 'rm -f "$RUNTIME_PROMPT_FILE"' EXIT
cp "$BASE_PROMPT_FILE" "$RUNTIME_PROMPT_FILE"

# Inject image analysis context if images were collected
if [ ${#COLLECTED_IMAGES[@]} -gt 0 ]; then
  {
    echo ""
    echo "## Image Analysis Context (Injected by ralph.sh)"
    echo "Reference images were supplied for this run. Use them when relevant to evaluate visual changes."
    echo ""
    echo "Reference image files:"
    for i in "${!COLLECTED_IMAGES[@]}"; do
      echo "$((i + 1)). ${COLLECTED_IMAGES[$i]}"
    done
    echo ""
    echo "When working on UI/visual stories:"
    echo "- Compare screenshots or rendered UI against relevant reference images."
    echo "- Note visual regressions/mismatches explicitly."
    echo "- Add pass/fail observations from this analysis to progress.txt."
  } >> "$RUNTIME_PROMPT_FILE"
fi

# Detect harness availability and inject context
# Override with RALPH_HARNESS=omc|omx|none to force-enable or disable detection
HARNESS_DETECTED=""
if [ -n "${RALPH_HARNESS:-}" ]; then
  if [[ "$RALPH_HARNESS" == "none" ]]; then
    HARNESS_DETECTED=""
  else
    HARNESS_DETECTED="$RALPH_HARNESS"
  fi
elif [[ "$TOOL" == "claude" ]]; then
  # Check if oh-my-claudecode is installed as a Claude Code plugin
  if [ -d "$HOME/.claude/plugins" ] && find "$HOME/.claude/plugins" -path "*/oh-my-claudecode/*" -name "plugin.json" -print -quit 2>/dev/null | grep -q .; then
    HARNESS_DETECTED="omc"
  fi
elif [[ "$TOOL" == "omx" ]]; then
  # omx is always harness-detected by definition
  HARNESS_DETECTED="omx"
elif [[ "$TOOL" == "codex" ]] && command -v omx &>/dev/null; then
  HARNESS_DETECTED="omx"
elif [[ "$TOOL" == "amp" ]] && command -v omx &>/dev/null; then
  # Amp can also benefit from OMX if installed
  HARNESS_DETECTED="omx"
fi

if [ -n "$HARNESS_DETECTED" ]; then
  {
    echo ""
    echo "## Harness Detected: $HARNESS_DETECTED (Injected by ralph.sh)"
    echo "The $HARNESS_DETECTED orchestration harness is installed. You have access to:"
    echo "- **Parallel delegation**: Use Task/spawn_agent to run independent sub-tasks simultaneously"
    echo "- **MCP code intelligence**: lsp_diagnostics, ast_grep_search, lsp_find_references"
    echo "- **Project memory**: project_memory_read/add_note for cross-iteration learning"
    echo "- **Notepad**: notepad_write_working for transient iteration state"
    echo ""
    echo "Prioritize these tools over manual CLI commands for faster, more precise results."
  } >> "$RUNTIME_PROMPT_FILE"
fi

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")

  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"
if [ -n "$HARNESS_DETECTED" ]; then
  echo "Harness detected: $HARNESS_DETECTED (enhanced agent capabilities enabled)"
fi
if [ ${#COLLECTED_IMAGES[@]} -gt 0 ]; then
  echo "Image analysis enabled with ${#COLLECTED_IMAGES[@]} reference image(s)."
fi

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  echo "==============================================================="

  # Build image flags — claude uses --image, codex uses -i
  IMAGE_FLAGS=()
  for img in "${COLLECTED_IMAGES[@]}"; do
    if [[ "$TOOL" == "codex" || "$TOOL" == "omx" ]]; then
      IMAGE_FLAGS+=(-i "$img")
    else
      IMAGE_FLAGS+=(--image "$img")
    fi
  done

  ITERATION_PROMPT_FILE="$(mktemp)"
  cp "$RUNTIME_PROMPT_FILE" "$ITERATION_PROMPT_FILE"

  if [ -n "${RALPH_FEEDBACK_FILE:-}" ] && [ -f "$RALPH_FEEDBACK_FILE" ]; then
    {
      echo ""
      echo "## Iteration Feedback (Injected by ralph.sh)"
      echo "Apply the following structured feedback before generating this iteration:"
      cat "$RALPH_FEEDBACK_FILE"
    } >> "$ITERATION_PROMPT_FILE"
  fi

  # Run the selected tool with the ralph prompt
  if [[ "$TOOL" == "amp" ]]; then
    OUTPUT=$(cat "$ITERATION_PROMPT_FILE" | amp --dangerously-allow-all 2>&1 | tee /dev/stderr) || true
  elif [[ "$TOOL" == "claude" ]]; then
    # Claude Code: attach images as multimodal content via --image flags
    OUTPUT=$(claude --dangerously-skip-permissions --print "${IMAGE_FLAGS[@]}" < "$ITERATION_PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  elif [[ "$TOOL" == "codex" ]]; then
    # Codex CLI: pipe prompt via stdin (-) so -i flags don't consume it
    OUTPUT=$(codex exec --dangerously-bypass-approvals-and-sandbox "${IMAGE_FLAGS[@]}" - < "$ITERATION_PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  elif [[ "$TOOL" == "omx" ]]; then
    # oh-my-codex: codex with OMX hooks + image attachments, prompt via stdin
    OUTPUT=$(codex exec --dangerously-bypass-approvals-and-sandbox "${IMAGE_FLAGS[@]}" - < "$ITERATION_PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  fi

  rm -f "$ITERATION_PROMPT_FILE"

  # Check for completion signal — validate against prd.json before trusting
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    REMAINING=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE" 2>/dev/null || echo "1")
    if [ "$REMAINING" -eq 0 ]; then
      echo ""
      echo "Ralph completed all tasks!"
      echo "Completed at iteration $i of $MAX_ITERATIONS"
      exit 0
    else
      echo ""
      echo "WARNING: Agent emitted COMPLETE but $REMAINING stories still have passes:false."
      echo "Ignoring premature signal. Continuing..."
    fi
  fi

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
