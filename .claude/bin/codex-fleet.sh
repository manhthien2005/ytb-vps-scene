#!/usr/bin/env bash
# codex-fleet.sh — Claude-as-Tech-Lead → fleet of parallel Codex workers (v3).
#
# Each worker runs in its own git worktree (.worktrees/<name>) on branch
# codex/<name>, isolated from the main tree and siblings. All durable state
# lives under .collab/fleet/<name>/ so a BRAND-NEW Claude session can resume:
# it reads the manifest + per-worker phase + PID liveness and knows exactly
# what is done / running / orphaned.
#
# QUALITY CONTRACTS (v3) — good input in, complete report out:
#   * INPUT: every spec is linted for required sections + a machine-readable
#     ```files allowlist before dispatch (soft gate: FLEET_SKIP_SPEC_LINT=1
#     overrides). The worker may create/modify ONLY allowlisted files; touching
#     anything else auto-FAILS the worker (merge blocked). This guarantees the
#     worker always gets a correct, sufficient brief and cannot silently break scope.
#   * OUTPUT: the worker writes a structured report; the engine then APPENDS an
#     "ACTUAL CHANGES (git ground truth)" section it computes itself, so the Tech
#     Lead always sees every changed file even if the worker under-reports.
#
# State machine (phase file), advanced atomically:
#   created -> running -> codex-exited -> committed -> complete
#                                                    \-> failed
#   complete -> merged
# phase=running with a dead PID = ORPHANED. `run <name>` recovers it idempotently
# (immutable base, so the cumulative QC diff stays correct across re-runs).
#
# Subcommands:
#   run <name> <spec>   Worker. Lints spec, enforces allowlist, idempotent+resumable.
#                       Launch via the Bash tool's run_in_background:true (NOT shell &).
#   lint <spec>         Validate a spec (required sections + non-empty allowlist).
#   collect <name>      Compact QC view: report (+ ground truth) + diffstat + phase.
#   status              Manifest + per-worker phase/liveness (DONE/RUNNING/ORPHANED/…).
#   check [spec-dir]    Partition (file overlap across specs) + lint every spec.
#   merge <name>        Merge codex/<name> — only if phase=complete, tip matches, tree clean.
#   clean <name>        Remove worktree+branch+state — refuses a live worker.
#
# Security: unsets OPENAI_API_KEY (chatgpt auth). codex runs `-s workspace-write`
# scoped to the worktree with stdin from /dev/null (else a background codex hangs
# forever on "Reading additional input from stdin..."). Denylist writes (secrets/,
# web/.env*, web/src/lib/security/, config/) auto-fail the worker closed.
#
# Env: CODEX_MODEL (default gpt-5.6-sol), WORKER_EFFORT (default xhigh),
#      FLEET_MAX_FILES (soft warn, default 3), FLEET_SKIP_SPEC_LINT (1 = override lint).

set -euo pipefail

SUB="${1:-help}"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
COLLAB="$REPO_ROOT/.collab"
FLEET="$COLLAB/fleet"
SPECS="$COLLAB/specs"
WT_DIR="$REPO_ROOT/.worktrees"
MANIFEST="$FLEET/manifest.tsv"

CODEX_MODEL="${CODEX_MODEL:-gpt-5.6-sol}"
WORKER_EFFORT="${WORKER_EFFORT:-xhigh}"
FLEET_MAX_FILES="${FLEET_MAX_FILES:-3}"

DENYLIST=("secrets/" "web/.env" "web/src/lib/security/" "config/")

unset OPENAI_API_KEY || true
export OTEL_SDK_DISABLED=true

die() { echo "codex-fleet: $*" >&2; exit 1; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "unknown"; }

# ── name / path safety ────────────────────────────────────────────────────
validate_name() {
  local n="$1"
  [[ "$n" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "invalid worker name '$n' (allowed: [a-z0-9][a-z0-9-]*, no slashes/dots)"
  [ "${#n}" -le 64 ] || die "worker name too long (max 64): $n"
}

# ── spec input contract ───────────────────────────────────────────────────
# Print the normalized allowlist paths from the ```files fenced block of a spec.
spec_allowlist() {
  awk '/^```files[[:space:]]*$/{f=1;next} /^```/{if(f){f=0}} f' "$1" 2>/dev/null \
    | sed 's/#.*//; s/^[[:space:]]*//; s/[[:space:]]*$//; s#^\./##' \
    | grep -v '^$' | sort -u
}
# Validate a spec has the required sections + a non-empty allowlist. 0=ok, 1=incomplete.
lint_spec() {
  local spec="$1" missing=""
  [ -f "$spec" ] || { echo "spec not found: $spec" >&2; return 1; }
  grep -qE '^##[[:space:]]+Objective'    "$spec" || missing="${missing}Objective "
  grep -qE '^##[[:space:]]+Verification' "$spec" || missing="${missing}Verification "
  [ -n "$(spec_allowlist "$spec")" ]              || missing="${missing}files-allowlist-block "
  if [ -n "$missing" ]; then
    echo "spec lint FAIL ($(basename "$spec")): missing → ${missing}" >&2
    return 1
  fi
  return 0
}
# Is $1 permitted by the newline-list in global $ALLOW? (dir entries end in /)
path_allowed() {
  local f="$1" a
  while IFS= read -r a; do
    [ -z "$a" ] && continue
    case "$a" in
      */) case "$f" in "$a"*) return 0;; esac ;;
      *)  [ "$f" = "$a" ] && return 0 ;;
    esac
  done <<< "$ALLOW"
  return 1
}

# ── state helpers ─────────────────────────────────────────────────────────
sd_of()    { printf '%s' "$FLEET/$1"; }
phase_of() { cat "$FLEET/$1/phase" 2>/dev/null || echo "absent"; }
set_phase() {
  local n="$1" p="$2" sd; sd="$(sd_of "$n")"; mkdir -p "$sd"
  printf '%s' "$p" > "$sd/phase.tmp" && mv -f "$sd/phase.tmp" "$sd/phase"
  printf '%s\t%s\t%s\n' "$(now)" "$n" "$p" >> "$MANIFEST"
}
alive_of() {
  local pid; pid="$(cat "$FLEET/$1/pid" 2>/dev/null || echo)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
classify() {
  local n="$1" p; p="$(phase_of "$n")"
  case "$p" in
    running)                 if alive_of "$n"; then echo "RUNNING"; else echo "ORPHANED"; fi ;;
    committed|codex-exited)  if alive_of "$n"; then echo "FINALIZING"; else echo "ORPHANED"; fi ;;
    created)                 if alive_of "$n"; then echo "STARTING"; else echo "ORPHANED"; fi ;;
    complete)                echo "DONE" ;;
    merged)                  echo "MERGED" ;;
    failed)                  echo "FAILED" ;;
    absent)                  echo "NO-STATE" ;;
    *)                       echo "$p" ;;
  esac
}

# ── worktree helpers ──────────────────────────────────────────────────────
is_registered_worktree() {
  git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep -qF "worktree $1"
}
add_worktree() {
  local attempt=1
  while true; do
    if git -C "$REPO_ROOT" worktree add "$@" >>"$LOG" 2>&1; then return 0; fi
    attempt=$((attempt + 1)); [ "$attempt" -gt 4 ] && return 1; sleep 2
  done
}
ensure_worktree() {
  local wt="$1" branch="$2"
  if [ -d "$wt" ]; then
    is_registered_worktree "$wt" || die "stale dir '$wt' is not a registered worktree — refusing to reuse. Remove it or pick a new name."
    return 0
  fi
  if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    add_worktree "$wt" "$branch" || die "could not attach worktree to existing branch $branch"
  else
    add_worktree -b "$branch" "$wt" HEAD || die "could not create worktree/branch $branch"
  fi
}

# ── lock ──────────────────────────────────────────────────────────────────
RUN_NAME=""
release_lock() { [ -n "$RUN_NAME" ] && rmdir "$FLEET/$RUN_NAME/lock" 2>/dev/null; true; }
trap release_lock EXIT
acquire_lock() {
  local n="$1" sd; sd="$(sd_of "$n")"; mkdir -p "$sd"
  if mkdir "$sd/lock" 2>/dev/null; then return 0; fi
  if alive_of "$n"; then die "worker '$n' is already running (pid $(cat "$sd/pid" 2>/dev/null)) — refusing double-dispatch"; fi
  echo "codex-fleet: stealing stale lock from dead worker '$n'" >&2
}

case "$SUB" in
  # ─────────────────────────────────────────────────────────────────────────
  lint)
    SPEC="${2:?Usage: codex-fleet.sh lint <spec-file>}"
    if lint_spec "$SPEC"; then
      echo "spec OK: $(basename "$SPEC")"
      echo "allowlist:"; spec_allowlist "$SPEC" | sed 's/^/  - /'
    else
      exit 1
    fi
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  run)
    NAME="${2:?Usage: codex-fleet.sh run <name> <spec-file>}"
    SPEC="${3:?Usage: codex-fleet.sh run <name> <spec-file>}"
    validate_name "$NAME"
    [ -f "$SPEC" ] || die "spec file not found: $SPEC"

    # INPUT CONTRACT: refuse an incomplete brief (override with FLEET_SKIP_SPEC_LINT=1).
    if ! lint_spec "$SPEC"; then
      if [ "${FLEET_SKIP_SPEC_LINT:-0}" = "1" ]; then
        echo "codex-fleet: dispatching despite incomplete spec (FLEET_SKIP_SPEC_LINT=1)" >&2
      else
        die "incomplete spec for '$NAME' — fill the missing sections (see .collab/specs/_TEMPLATE.md) or set FLEET_SKIP_SPEC_LINT=1"
      fi
    fi

    SD="$(sd_of "$NAME")"; mkdir -p "$SD"
    WT="$WT_DIR/$NAME"; BRANCH="codex/$NAME"
    LOG="$SD/log"; REPORT="$SD/report.md"; DIFF="$SD/diff"
    WT_REPORT="$WT/WORKER_REPORT.md"
    ALLOW="$(spec_allowlist "$SPEC")"

    acquire_lock "$NAME"; RUN_NAME="$NAME"
    P="$(phase_of "$NAME")"
    if [ "$P" = "running" ] && alive_of "$NAME"; then die "worker '$NAME' already active"; fi

    set_phase "$NAME" created
    printf '%s' "$$" > "$SD/pid"
    : > "$LOG"

    ensure_worktree "$WT" "$BRANCH"
    if [ ! -f "$SD/base" ]; then git -C "$WT" rev-parse HEAD > "$SD/base"; fi
    BASE="$(cat "$SD/base")"
    printf '%s' "$SPEC" > "$SD/spec_path"

    SPEC_CONTENT="$(cat "$SPEC")"
    PROMPT="You are one worker in a fleet led by a Tech Lead (Claude). Implement the spec below EXACTLY and nothing more. You are in an isolated git worktree.

## Spec
${SPEC_CONTENT}

## Hard rules (the engine enforces these — breaking them FAILS your work)
- Create/modify ONLY the files in the spec's \`\`\`files allowlist. Touching any other file fails the worker.
- Never touch: secrets/, web/.env*, web/src/lib/security/, config/.
- STATUS is PASS only if the spec's Verification actually passed (run it).

## Report protocol (MANDATORY — do this last)
Write a report file named WORKER_REPORT.md in your current working directory, EXACTLY this shape:

# Worker Report: ${NAME}
STATUS: PASS | FAIL | BLOCKED
## Summary
<1-2 lines: what you did>
## Files changed
- <path> — <what changed and why>   (list EVERY file you touched)
## Tests
<command you ran> -> PASS/FAIL (counts)
## Key decisions
- <non-obvious choice + reason>
## Assumptions
- <assumptions the Tech Lead must confirm, or 'none'>
## Out of scope / not done
- <in-scope work you deliberately skipped, or 'none'>
## Open questions / risks for Tech Lead
- <or 'none'>"

    set_phase "$NAME" running

    # < /dev/null: a background codex otherwise hangs forever waiting for stdin EOF.
    # Transcript -> LOG only, never stdout (keeps raw reasoning out of Claude's context).
    cd "$WT"
    set +e
    codex exec -s workspace-write \
      -m "$CODEX_MODEL" \
      -c model_reasoning_effort="$WORKER_EFFORT" \
      "$PROMPT" < /dev/null >> "$LOG" 2>&1
    EXIT=$?
    set -e
    set_phase "$NAME" codex-exited

    # Relocate the report OUT of the worktree so it isn't committed/diffed.
    if [ -f "$WT_REPORT" ]; then mv -f "$WT_REPORT" "$REPORT"; fi

    # Compute changed files (report already moved out) for denylist + allowlist gates.
    CHANGED="$(git -C "$WT" status --porcelain | sed 's/^...//' | sed 's/^"//; s/"$//')"
    NFILES="$(printf '%s\n' "$CHANGED" | grep -c . || true)"
    DENY_HITS=""; OUTSIDE=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      for d in "${DENYLIST[@]}"; do case "$f" in "$d"*) DENY_HITS="${DENY_HITS}${f} ";; esac; done
      if [ -n "$ALLOW" ]; then path_allowed "$f" || OUTSIDE="${OUTSIDE}${f} "; fi
    done <<< "$CHANGED"

    # Commit worker output so codex/<name> is self-contained & mergeable.
    # A commit FAILURE is terminal — never hidden (else QC sees an empty diff).
    COMMIT_OK=1
    if [ -n "$(git -C "$WT" status --porcelain)" ]; then
      if ! git -C "$WT" add -A || ! git -C "$WT" commit -q -m "codex($NAME): worker output"; then COMMIT_OK=0; fi
    fi

    git -C "$WT" diff "$BASE..HEAD" > "$DIFF.tmp" 2>/dev/null || true
    mv -f "$DIFF.tmp" "$DIFF"
    git -C "$WT" rev-parse HEAD > "$SD/tip"

    # Synthesize a report if the worker didn't write one (atomic).
    if [ ! -f "$REPORT" ]; then
      {
        echo "# Worker Report: $NAME"
        if [ "$EXIT" -eq 0 ] && [ "$COMMIT_OK" -eq 1 ]; then echo "STATUS: PASS  (auto-synthesized — worker wrote no report)";
        else echo "STATUS: FAIL  (auto-synthesized — codex exit=$EXIT commit_ok=$COMMIT_OK)"; fi
        echo "## Summary"; echo "(worker wrote no report — see ground truth below)"
        echo "## Tests"; echo "(worker reported none)"
      } > "$REPORT.tmp"
      mv -f "$REPORT.tmp" "$REPORT"
    fi

    # OUTPUT CONTRACT: append git ground truth so the Tech Lead sees EVERY change,
    # regardless of how well the worker self-reported. Warn if report sections are thin.
    RLINT=""
    grep -qE '^## Files changed'  "$REPORT" || RLINT="${RLINT}Files-changed "
    grep -qE '^## Tests'          "$REPORT" || RLINT="${RLINT}Tests "
    {
      echo ""
      echo "## ACTUAL CHANGES (git ground truth — engine-generated, cannot be faked)"
      git -C "$WT" diff --stat "$BASE..HEAD" 2>/dev/null || echo "(none)"
      echo ""
      git -C "$WT" diff --name-status "$BASE..HEAD" 2>/dev/null || true
      [ -n "$RLINT" ] && echo "" && echo "> ⚠ worker report was missing sections: $RLINT"
    } >> "$REPORT"

    # Terminal phase.
    FINAL_PHASE=complete; FAIL_REASON=""
    [ "$EXIT" -ne 0 ]      && { FINAL_PHASE=failed; FAIL_REASON="codex exit=$EXIT"; }
    [ "$COMMIT_OK" -ne 1 ] && { FINAL_PHASE=failed; FAIL_REASON="git commit failed"; }
    [ -n "$DENY_HITS" ]    && { FINAL_PHASE=failed; FAIL_REASON="denylist: $DENY_HITS"; }
    [ -n "$OUTSIDE" ]      && { FINAL_PHASE=failed; FAIL_REASON="out-of-allowlist: $OUTSIDE"; }
    [ -n "$FAIL_REASON" ] && printf '%s\n' "$FAIL_REASON" > "$SD/error"
    set_phase "$NAME" "$FINAL_PHASE"

    # Short completion summary — the ONLY thing on stdout (the background output).
    echo "=== fleet:run $NAME — phase=$FINAL_PHASE (codex exit=$EXIT) ==="
    grep -m1 '^STATUS:' "$REPORT" 2>/dev/null || echo "STATUS: (unknown)"
    [ -n "$DENY_HITS" ] && echo "⚠ DENYLIST: $DENY_HITS"
    [ -n "$OUTSIDE" ]   && echo "⚠ OUT-OF-ALLOWLIST: $OUTSIDE"
    [ "$NFILES" -gt "$FLEET_MAX_FILES" ] 2>/dev/null && echo "⚠ touched $NFILES files (soft cap $FLEET_MAX_FILES)"
    echo "changed:"; git -C "$WT" diff --stat "$BASE..HEAD" 2>/dev/null | tail -1 || echo "  (none)"
    echo "state: .collab/fleet/$NAME/ | report+diff there | branch: $BRANCH"
    [ "$FINAL_PHASE" = complete ] && exit 0 || exit 1
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  collect)
    NAME="${2:?Usage: codex-fleet.sh collect <name>}"
    validate_name "$NAME"
    SD="$(sd_of "$NAME")"; CLS="$(classify "$NAME")"
    echo "========== WORKER: $NAME  [$CLS] =========="
    case "$CLS" in RUNNING|STARTING|FINALIZING) echo "(worker still $CLS — artifacts not final yet)";; esac
    echo "---------- report (worker self-report + engine ground truth) ----------"
    cat "$SD/report.md" 2>/dev/null || echo "(no report yet)"
    [ -f "$SD/error" ] && { echo ""; echo "ERROR: $(cat "$SD/error")"; }
    echo ""
    echo "Full diff for QC: .collab/fleet/$NAME/diff | raw transcript: .collab/fleet/$NAME/log"
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  status)
    if [ ! -d "$FLEET" ]; then echo "No fleet state — nothing dispatched."; exit 0; fi
    echo "Fleet status  (resume-safe: derived from durable phase + PID liveness)"
    printf '  %-24s | %-11s | %-14s | %s\n' "WORKER" "CLASS" "PHASE" "STATUS-LINE"
    found=0
    for d in "$FLEET"/*/; do
      [ -d "$d" ] || continue
      n="$(basename "$d")"; found=1
      sl="$(grep -m1 '^STATUS:' "$d/report.md" 2>/dev/null | sed 's/^STATUS:[[:space:]]*//' | cut -c1-38 || true)"
      [ -n "$sl" ] || sl="-"
      printf '  %-24s | %-11s | %-14s | %s\n' "$n" "$(classify "$n")" "$(phase_of "$n")" "$sl"
    done
    [ "$found" -eq 0 ] && echo "  (no workers)"
    echo ""
    echo "ORPHANED = phase running but process dead → recover: codex-fleet.sh run <name> <spec>"
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  check)
    SDIR="${2:-$SPECS}"
    [ -d "$SDIR" ] || die "spec dir not found: $SDIR"
    echo "== Spec lint (input contract) =="
    any=0; bad=0
    for s in "$SDIR"/*.md; do
      [ -f "$s" ] || continue
      [ "$(basename "$s")" = "_TEMPLATE.md" ] && continue
      any=1
      if lint_spec "$s" 2>/tmp/fleetlint.$$; then echo "  OK   $(basename "$s")"; else echo "  FAIL $(cat /tmp/fleetlint.$$)"; bad=1; fi
    done
    rm -f /tmp/fleetlint.$$
    [ "$any" -eq 0 ] && echo "  (no specs)"
    echo ""
    echo "== Partition (file overlap across specs) =="
    tmp="$FLEET/.partition.$$"; mkdir -p "$FLEET"; : > "$tmp"
    for s in "$SDIR"/*.md; do
      [ -f "$s" ] || continue
      [ "$(basename "$s")" = "_TEMPLATE.md" ] && continue
      spec_allowlist "$s" | while IFS= read -r p; do printf '%s\t%s\n' "$p" "$(basename "$s")"; done >> "$tmp" || true
    done
    dup="$(cut -f1 "$tmp" 2>/dev/null | sort | uniq -d || true)"
    if [ -z "$dup" ]; then
      echo "  OK — no file is in two allowlists."
    else
      echo "  ⚠ OVERLAP (parallel merge WILL conflict):"
      while IFS= read -r p; do
        [ -z "$p" ] && continue
        printf '    %s  <-  %s\n' "$p" "$(awk -F'\t' -v pp="$p" '$1==pp{print $2}' "$tmp" | sort -u | paste -sd, -)"
      done <<< "$dup"
    fi
    rm -f "$tmp"
    echo ""
    echo "NOTE: overlap check is on declared files only. You must still confirm the workers"
    echo "share no interface/schema/config/generated-output (contract-disjointness)."
    [ "$bad" -eq 1 ] && exit 1 || true
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  merge)
    NAME="${2:?Usage: codex-fleet.sh merge <name>}"
    validate_name "$NAME"
    SD="$(sd_of "$NAME")"; BRANCH="codex/$NAME"
    git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH" || die "no branch $BRANCH"
    [ "$(phase_of "$NAME")" = "complete" ] || die "worker '$NAME' phase is '$(phase_of "$NAME")', not 'complete' — QC + finish (or fix a FAILED worker) before merge"
    if alive_of "$NAME"; then die "worker '$NAME' still active — cannot merge"; fi
    REVIEWED="$(cat "$SD/tip" 2>/dev/null || echo)"
    ACTUAL="$(git -C "$REPO_ROOT" rev-parse "$BRANCH")"
    [ -n "$REVIEWED" ] && [ "$REVIEWED" = "$ACTUAL" ] || die "branch tip ($ACTUAL) != reviewed tip (${REVIEWED:-none}) — re-QC before merge"
    git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet || die "main tree is dirty — commit/stash before merging"
    echo "Merging $BRANCH (reviewed $REVIEWED) into $(git -C "$REPO_ROOT" branch --show-current) ..."
    git -C "$REPO_ROOT" merge --no-ff "$BRANCH" -m "merge $BRANCH (fleet worker $NAME)"
    set_phase "$NAME" merged
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  clean)
    NAME="${2:?Usage: codex-fleet.sh clean <name>}"
    validate_name "$NAME"
    if alive_of "$NAME"; then die "worker '$NAME' is still running — refusing to clean"; fi
    WT="$WT_DIR/$NAME"; BRANCH="codex/$NAME"; errs=""
    if [ -d "$WT" ]; then git -C "$REPO_ROOT" worktree remove "$WT" --force 2>/dev/null || errs="${errs}worktree "; fi
    git -C "$REPO_ROOT" branch -D "$BRANCH" 2>/dev/null || true
    rm -rf "$FLEET/$NAME" 2>/dev/null || errs="${errs}state "
    if [ -n "$errs" ]; then echo "cleaned '$NAME' with WARNINGS — could not remove: $errs(check open handles)"; exit 1; fi
    echo "cleaned worker: $NAME (worktree + branch + state)"
    ;;

  # ─────────────────────────────────────────────────────────────────────────
  help|--help|-h)
    grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,50p'
    ;;
  *)
    echo "codex-fleet: unknown subcommand '$SUB' (run|lint|collect|status|check|merge|clean|help)" >&2
    exit 2
    ;;
esac
