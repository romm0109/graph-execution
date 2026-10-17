#!/usr/bin/env bash
set -euo pipefail

# Usage: ./ralph-loop.sh <folder> <iterations> [start_file]
FOLDER="${1:-}"
ITERATIONS="${2:-}"
START_FILE="${3:-}"

if [[ -z "$FOLDER" || -z "$ITERATIONS" ]]; then
  echo "Usage: $0 <folder> <iterations> [start_file]"
  exit 1
fi

if [[ ! -d "$FOLDER" ]]; then
  echo "Error: '$FOLDER' is not a directory"
  exit 1
fi

if ! [[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: iterations must be a positive integer"
  exit 1
fi

LOG_DIR="$(pwd)/ralph-logs"
mkdir -p "$LOG_DIR"

is_rate_limit_error() {
  local output="$1"
  echo "$output" | grep -qiE "rate.?limit|too many requests|quota|429|limit exceeded|session limit|usage limit"
}

# Fallback chain, in order. Any failure advances to the next agent.
AGENTS=(codex claude gemini copilot)

run_with_codex() {
  local prompt="$1"
  printf "%s\n" "$prompt" | codex exec --dangerously-bypass-approvals-and-sandbox --color never - 2>&1
}

run_with_claude() {
  local prompt="$1"
  printf "%s\n" "$prompt" | claude --dangerously-skip-permissions --print 2>&1
}

run_with_gemini() {
  local prompt="$1"
  # Gemini CLI operates as an agent. This command runs the Gemini agent
  # in headless mode, interpreting the prompt as instructions for the agent
  # to execute. Its output will include agent activity and tool calls,
  # not just raw text completion.
  printf "%s\n" "$prompt" | gemini --yolo -p "$prompt" 2>&1
}

run_with_copilot() {
  local prompt="$1"
  printf "%s\n" "$prompt" | copilot --allow-all-tools -i "$prompt" 2>&1
}

run_agent() {
  local agent="$1" prompt="$2"
  case "$agent" in
    codex)   run_with_codex   "$prompt" ;;
    claude)  run_with_claude  "$prompt" ;;
    gemini)  run_with_gemini  "$prompt" ;;
    copilot) run_with_copilot "$prompt" ;;
    *)       echo "unknown agent: $agent" >&2; return 127 ;;
  esac
}

# Tasks that exhausted the whole chain. Reported at the end; never fatal.
FAILED_FILES=()

process_file() {
  local file="$1"
  local iter="$2"
  local name
  name="$(basename "$file" .md)"
  local logfile="$LOG_DIR/iter-${iter}-${name}.log"

  echo "  -> $(basename "$file")"

  local content
  content="$(cat "$file")"

  local total_files="${#MD_FILES[@]}"
  local file_index
  for i in "${!MD_FILES[@]}"; do
    [[ "${MD_FILES[$i]}" == "$file" ]] && file_index=$((i + 1))
  done

  # Static block — identical every call, cache-friendly
  local static_context
  static_context="$(cat <<'STATIC'
=== RALPH LOOP CONTEXT ===
You are an agent running inside a Ralph Loop — an automated multi-iteration pipeline where
a set of task files (.md) is executed sequentially, in order, across one or more iterations.

How the loop works:
  - Each .md file represents one bounded task. Files are processed one at a time, in order.
  - By the time you receive a task, all earlier files in this iteration have already run
    and their changes are live in the codebase. This is expected — not a conflict or error.
  - Files that come after yours in this iteration have not yet run. Do not solve their
    problems, but do not break them either.
  - The loop may run for multiple iterations. A prior iteration may have made partial or
    complete progress on this same task. Check before redoing work.

Your approach:
  - Focus exclusively on the task described in the TASK section below.
  - If the task is already done, confirm it briefly and stop — do not redo work.
  - Leave the codebase in a clean, working state after your changes.
  - Do not modify files unrelated to your task.
=== END RALPH LOOP CONTEXT ===
STATIC
)"

  # Dynamic block — only the volatile per-call metadata, kept small and at the end
  local dynamic_metadata="=== CURRENT TASK METADATA ===
Iteration : $iter of $ITERATIONS
File      : $file_index of $total_files — $(basename "$file")
=== END METADATA ==="

  local prompt="$static_context

$dynamic_metadata

TASK:
$content"

  # Walk the fallback chain. Any failure — missing binary, nonzero exit, or a
  # rate-limit message (which some CLIs emit while still exiting 0) — advances
  # to the next agent. If every agent fails, the task is recorded and the loop
  # moves on to the next file; a single bad task never halts the run.
  local agent result status used=""

  for agent in "${AGENTS[@]}"; do
    if ! command -v "$agent" >/dev/null 2>&1; then
      echo "     [$agent not installed — skipping]" >&2
      continue
    fi

    result="$(run_agent "$agent" "$prompt")" && status=0 || status=$?

    if [[ $status -eq 0 ]] && ! is_rate_limit_error "$result"; then
      used="$agent"
      break
    fi

    if is_rate_limit_error "$result"; then
      echo "     [$agent limit hit — trying next agent]" >&2
    else
      echo "     [$agent error (exit $status) — trying next agent]" >&2
    fi

    {
      echo "[$agent] FAILED (exit $status) $file"
      echo "$result"
      echo
    } >> "$logfile"
  done

  if [[ -z "$used" ]]; then
    echo "     [all agents failed — continuing to next task]" >&2
    echo "[none] all agents failed for $file" >> "$logfile"
    FAILED_FILES+=("$(basename "$file") (iter $iter)")
    return 0
  fi

  echo "[$used] $file" >> "$logfile"
  echo "$result" >> "$logfile"
  echo "$result"
  return 0
}

MD_FILES=()
while IFS= read -r f; do
  MD_FILES+=("$f")
done < <(find "$FOLDER" -maxdepth 1 -name "*.md" | sort -V)

if [[ ${#MD_FILES[@]} -eq 0 ]]; then
  echo "No .md files found in '$FOLDER'"
  exit 1
fi

# Validate START_FILE if provided
if [[ -n "$START_FILE" ]]; then
  START_FILE_FULL_PATH=$(find "$FOLDER" -maxdepth 1 -name "$START_FILE" | head -n 1)
  if [[ -z "$START_FILE_FULL_PATH" ]]; then
    echo "Error: Starting file '$START_FILE' not found in '$FOLDER'"
    exit 1
  fi
  # Ensure the START_FILE_FULL_PATH is one of the MD_FILES
  start_file_exists=false
  for f in "${MD_FILES[@]}"; do
    if [[ "$f" == "$START_FILE_FULL_PATH" ]]; then
      start_file_exists=true
      break
    fi
  done
  if ! "$start_file_exists"; then
    echo "Error: Starting file '$START_FILE' is not a valid markdown file in '$FOLDER'"
    exit 1
  fi
fi

echo "Ralph Loop"
echo "  Folder:     $FOLDER"
echo "  Files:      ${#MD_FILES[@]}"
echo "  Iterations: $ITERATIONS"
if [[ -n "$START_FILE" ]]; then
  echo "  Start File: $START_FILE"
fi
echo "  Logs:       $LOG_DIR"
echo ""

for ((iter = 1; iter <= ITERATIONS; iter++)); do
  echo "=== Iteration $iter / $ITERATIONS ==="
  start_processing=false
  if [[ -z "$START_FILE" ]]; then
    start_processing=true # If no start file is specified, process all files
  fi

  for file in "${MD_FILES[@]}"; do
    if ! "$start_processing" && [[ "$(basename "$file")" == "$START_FILE" ]]; then
      start_processing=true
    fi

    if "$start_processing"; then
      # Never let one task abort the run, even on an unexpected error.
      process_file "$file" "$iter" || \
        echo "     [unexpected error in $(basename "$file") — continuing]" >&2
    fi
  done
  echo ""
done

echo "Done. Logs saved to $LOG_DIR"

if [[ ${#FAILED_FILES[@]} -gt 0 ]]; then
  echo ""
  echo "Failed tasks (all agents exhausted): ${#FAILED_FILES[@]}"
  for f in "${FAILED_FILES[@]}"; do
    echo "  - $f"
  done
fi
