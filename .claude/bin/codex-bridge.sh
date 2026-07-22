#!/usr/bin/env bash
# codex-bridge.sh — Claude Code → Codex CLI bridge
#
# Usage:
#   codex-bridge.sh think "Your prompt here"
#   codex-bridge.sh build "Your prompt here"
#   codex-bridge.sh build "Implement this spec" .collab/specs/task.md
#
# Modes:
#   think — Read-only. Codex reads files but changes nothing.
#           For debate, review, architecture, debugging hypotheses.
#   build — Workspace-write. Codex creates/modifies files.
#           For implementation tasks delegated by Claude.
#
# Security:
#   Unsets OPENAI_API_KEY to force subscription auth (chatgpt mode).
#   Your project's API key for embeddings/moderation is NOT used by Codex.
#
# Logging & audit (build mode):
#   Appends one JSONL record per call to .collab/collab.log — mode, prompt
#   SHA-256 (raw prompt NEVER logged, may contain secrets), exit code,
#   duration, codex version, and the files Codex actually changed (via
#   git status --porcelain before/after). If a changed file matches the
#   denylist (secrets/, web/.env*, web/src/lib/security/, config/) a loud
#   warning is printed to stderr. This is transparency/audit, NOT hard
#   enforcement — Codex still has write access to the whole workspace.

set -euo pipefail

MODE="${1:?Usage: codex-bridge.sh <think|build> \"prompt\" [spec-file]}"
PROMPT="${2:?Usage: codex-bridge.sh <think|build> \"prompt\" [spec-file]}"
SPEC_FILE="${3:-}"

# Resolve repo root so logging works regardless of caller CWD.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LOG_FILE="$REPO_ROOT/.collab/collab.log"

# Paths Codex should not be writing to. Matched as path prefixes against
# git-reported changed files (repo-relative, forward slashes).
DENYLIST=(
  "secrets/"
  "web/.env"
  "web/src/lib/security/"
  "config/"
)

# ── Model / reasoning configuration ───────────────────────
# Intelligence is tuned per mode, not left to config.toml defaults.
#   think  → deepest single-shot reasoning (advisory: review/debate/arch)
#   build  → strong, focused reasoning for scoped implementation (≤3 files)
# Escalate to "max"/"ultra" for hard tasks WITHOUT editing this script:
#   CODEX_MODEL=gpt-5.6-sol CODEX_EFFORT=ultra codex-bridge.sh build "..."
# Effort ladder: low < medium < high < xhigh < max < ultra
#   (ultra = maximum reasoning + automatic task delegation)
CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
THINK_EFFORT="${CODEX_EFFORT:-max}"
BUILD_EFFORT="${CODEX_EFFORT:-xhigh}"

# If a spec file is provided, prepend its contents to the prompt
if [[ -n "$SPEC_FILE" && -f "$SPEC_FILE" ]]; then
  PROMPT="## Build Spec
$(cat "$SPEC_FILE")

## Instructions
${PROMPT}"
fi

# ── Security ──────────────────────────────────────────────
# CRITICAL: Many projects have OPENAI_API_KEY in the environment for
# embeddings and moderation. We MUST unset it so Codex CLI
# falls back to ~/.codex/auth.json (chatgpt subscription).
# This prevents accidental API billing.
unset OPENAI_API_KEY

# Suppress OpenTelemetry crash (known Codex CLI bug)
export OTEL_SDK_DISABLED=true

# ── Helpers ───────────────────────────────────────────────
prompt_hash() {
  # SHA-256 of the prompt; try common tools, fall back to "unavailable".
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$PROMPT" | sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    printf '%s' "$PROMPT" | shasum -a 256 | cut -d' ' -f1
  else
    printf 'unavailable'
  fi
}

json_escape() {
  # Minimal JSON string escaper for values we control (paths, versions).
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

# git status --porcelain snapshot (repo-relative paths, one per line).
snapshot() {
  git -C "$REPO_ROOT" status --porcelain 2>/dev/null | sed 's/^...//' || true
}

# ── Execute ───────────────────────────────────────────────
case "$MODE" in
  think)
    exec codex exec -s read-only \
      -m "$CODEX_MODEL" \
      -c model_reasoning_effort="$THINK_EFFORT" \
      "$PROMPT" < /dev/null
    ;;
  build)
    mkdir -p "$REPO_ROOT/.collab"
    CODEX_VERSION="$(codex --version 2>/dev/null | head -1 || echo unknown)"
    HASH="$(prompt_hash)"
    START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)"
    START_EPOCH="$(date +%s 2>/dev/null || echo 0)"

    # Baseline of dirty files before Codex runs.
    BEFORE="$(snapshot)"

    set +e
    codex exec -s workspace-write \
      -m "$CODEX_MODEL" \
      -c model_reasoning_effort="$BUILD_EFFORT" \
      "$PROMPT" < /dev/null
    EXIT_CODE=$?
    set -e

    END_EPOCH="$(date +%s 2>/dev/null || echo 0)"
    DURATION=$(( END_EPOCH - START_EPOCH ))

    # Files dirty after the run that were not already dirty before.
    AFTER="$(snapshot)"
    CHANGED="$(comm -13 <(printf '%s\n' "$BEFORE" | sort -u) \
                        <(printf '%s\n' "$AFTER" | sort -u) 2>/dev/null || printf '%s' "$AFTER")"
    CHANGED="$(printf '%s\n' "$CHANGED" | grep -v '^$' || true)"

    # Denylist audit + JSON array of changed files.
    VIOLATIONS=()
    CHANGED_JSON=""
    while IFS= read -r f; do
      [[ -z "$f" ]] && continue
      [[ -n "$CHANGED_JSON" ]] && CHANGED_JSON+=","
      CHANGED_JSON+="\"$(json_escape "$f")\""
      for deny in "${DENYLIST[@]}"; do
        if [[ "$f" == "$deny"* ]]; then
          VIOLATIONS+=("$f")
          break
        fi
      done
    done <<< "$CHANGED"

    if [[ ${#VIOLATIONS[@]} -gt 0 ]]; then
      {
        echo ""
        echo "============================================================"
        echo "  ⚠  COLLAB AUDIT WARNING: Codex touched protected paths"
        echo "============================================================"
        for v in "${VIOLATIONS[@]}"; do echo "    - $v"; done
        echo "  Review these changes carefully before committing."
        echo "  (This is an audit, not a block — writes already happened.)"
        echo "============================================================"
        echo ""
      } >&2
    fi

    # Append JSONL audit record.
    printf '{"ts":"%s","mode":"build","model":"%s","effort":"%s","prompt_sha256":"%s","codex_version":"%s","exit_code":%d,"duration_s":%d,"changed_files":[%s],"denylist_hits":%d}\n' \
      "$START_TS" "$(json_escape "$CODEX_MODEL")" "$(json_escape "$BUILD_EFFORT")" "$HASH" "$(json_escape "$CODEX_VERSION")" "$EXIT_CODE" "$DURATION" "$CHANGED_JSON" "${#VIOLATIONS[@]}" \
      >> "$LOG_FILE"

    exit $EXIT_CODE
    ;;
  *)
    echo "Error: Mode must be 'think' or 'build'. Got: $MODE" >&2
    exit 1
    ;;
esac
