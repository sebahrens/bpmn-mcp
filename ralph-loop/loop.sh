#!/bin/bash

# Ralph implementation loop for mcp-bpmn.
#
# Each iteration selects and claims one actionable Beads leaf, starts a fresh
# implementation agent, and accepts the attempt only when Beads confirms the
# selected issue is closed. If the same issue remains unclosed for three
# consecutive attempts, a separate Codex recovery session investigates and
# repairs the Beads/code/test blocker before the normal loop continues.
#
# Console output is deliberately quiet: only loop start/stop lines and the
# agent's tool calls are printed. Agent prose and reasoning are discarded.
# Ctrl-C stops the loop: the running agent process group is terminated, the
# selected bead is returned to the open queue, and the loop exits 130. A second
# Ctrl-C exits immediately without waiting for cleanup.
#
# Usage:
#   ./ralph-loop/loop.sh          # Run until no actionable leaf remains
#   ./ralph-loop/loop.sh 10       # Run at most 10 implementation attempts
#   ./ralph-loop/loop.sh --once   # Run one implementation attempt
#
# Configuration (environment variables):
#   MAX_ITERATIONS            0 means unlimited (default: 0)
#   AGENT_CMD                 implementation executable (default: codex)
#   AGENT_MODEL               optional implementation model
#   AGENT_TIMEOUT_SECS        per-attempt timeout; 0 disables (default: 3600)
#   CODEX_CMD                 Codex executable (default: codex)
#   CODEX_MODEL               optional Codex recovery model
#   CODEX_TIMEOUT_SECS        recovery timeout; 0 disables (default: 3600)
#   STUCK_LOOP_THRESHOLD      same-bead failures before recovery (default: 3)
#   RETRY_DELAY_SECS          pause after an unclosed attempt (default: 2)
#   RALPH_SHOW_AGENT_OUTPUT   1 streams raw agent output instead of tool lines

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROMPT_FILE="${PROMPT_FILE:-$SCRIPT_DIR/PROMPT_build.md}"

MAX_ITERATIONS="${MAX_ITERATIONS:-0}"
AGENT_CMD="${AGENT_CMD:-codex}"
AGENT_MODEL="${AGENT_MODEL:-}"
AGENT_TIMEOUT_SECS="${AGENT_TIMEOUT_SECS:-3600}"
CODEX_CMD="${CODEX_CMD:-codex}"
CODEX_MODEL="${CODEX_MODEL:-}"
CODEX_TIMEOUT_SECS="${CODEX_TIMEOUT_SECS:-3600}"
STUCK_LOOP_THRESHOLD="${STUCK_LOOP_THRESHOLD:-3}"
RETRY_DELAY_SECS="${RETRY_DELAY_SECS:-2}"
RALPH_SHOW_AGENT_OUTPUT="${RALPH_SHOW_AGENT_OUTPUT:-0}"

LAST_FAILED_BEAD=""
CONSECUTIVE_FAILURES=0
ACTIVE_BEAD=""
LOCK_DIR=""
CURRENT_ITERATION=0

AGENT_PID=""
FILTER_PID=""
WATCHDOG_PID=""
STREAM_DIR=""
TIMEOUT_BIN=""

usage() {
    cat <<'EOF'
Usage:
  ./ralph-loop/loop.sh          Run until no actionable leaf remains
  ./ralph-loop/loop.sh 10       Run at most 10 implementation attempts
  ./ralph-loop/loop.sh --once   Run one implementation attempt
  ./ralph-loop/loop.sh --help   Show this help
EOF
}

is_nonnegative_integer() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

die() {
    echo "[ralph] error: $*" >&2
    exit 1
}

timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

say_start() {
    echo "[ralph] start: $*"
}

say_stop() {
    echo "[ralph] stop: $*"
}

if [ "$#" -gt 1 ]; then
    usage >&2
    exit 2
fi
if [ "$#" -eq 1 ]; then
    case "$1" in
        --help|-h)
            usage
            exit 0
            ;;
        --once)
            MAX_ITERATIONS=1
            ;;
        *)
            is_nonnegative_integer "$1" || die "iteration limit must be a nonnegative integer"
            MAX_ITERATIONS="$1"
            ;;
    esac
fi

is_nonnegative_integer "$MAX_ITERATIONS" || die "MAX_ITERATIONS must be a nonnegative integer"
is_nonnegative_integer "$AGENT_TIMEOUT_SECS" || die "AGENT_TIMEOUT_SECS must be a nonnegative integer"
is_nonnegative_integer "$CODEX_TIMEOUT_SECS" || die "CODEX_TIMEOUT_SECS must be a nonnegative integer"
is_nonnegative_integer "$RETRY_DELAY_SECS" || die "RETRY_DELAY_SECS must be a nonnegative integer"
is_nonnegative_integer "$STUCK_LOOP_THRESHOLD" || die "STUCK_LOOP_THRESHOLD must be a positive integer"
[ "$STUCK_LOOP_THRESHOLD" -gt 0 ] || die "STUCK_LOOP_THRESHOLD must be greater than zero"

[ -f "$PROMPT_FILE" ] || die "implementation prompt not found: $PROMPT_FILE"
command -v bd >/dev/null 2>&1 || die "bd is required"
command -v jq >/dev/null 2>&1 || die "jq is required"
command -v git >/dev/null 2>&1 || die "git is required"
command -v "$AGENT_CMD" >/dev/null 2>&1 || die "implementation agent not found: $AGENT_CMD"
command -v "$CODEX_CMD" >/dev/null 2>&1 || die "Codex CLI not found: $CODEX_CMD"

if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN=gtimeout
fi

cd "$PROJECT_DIR" || die "cannot enter project directory: $PROJECT_DIR"

# Beads runner indirection: the interrupt path swaps in a bounded runner so a
# hanging `bd` can never block shutdown.
BD_RUNNER=bd_direct

bd_direct() {
    bd "$@"
}

bd_bounded() {
    if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" 20 bd "$@"
    else
        bd "$@"
    fi
}

lock_key() {
    if command -v shasum >/dev/null 2>&1; then
        printf '%s' "$PROJECT_DIR" | shasum | awk '{print substr($1, 1, 10)}'
    else
        printf '%s' "$PROJECT_DIR" | cksum | awk '{print $1}'
    fi
}

acquire_lock() {
    local lock_root existing_pid
    lock_root="${RALPH_LOCK_ROOT:-${TMPDIR:-/tmp}}"
    mkdir -p "$lock_root" || die "cannot create lock root: $lock_root"
    LOCK_DIR="$lock_root/mcp-bpmn-ralph-$(lock_key).lock"

    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        existing_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
        if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
            die "another loop is already running for $PROJECT_DIR (pid $existing_pid)"
        fi
        echo "[ralph] removing stale lock $LOCK_DIR" >&2
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR" 2>/dev/null || die "cannot acquire loop lock: $LOCK_DIR"
    fi
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

cleanup_exit() {
    [ -z "$STREAM_DIR" ] || rm -rf "$STREAM_DIR"
    [ -z "$LOCK_DIR" ] || rm -rf "$LOCK_DIR"
}
trap cleanup_exit EXIT

# Every process descended from $1, deepest last. Collected before signalling
# because agents such as Codex run each shell command in its own process group,
# and those grandchildren are reparented away the moment the agent dies.
descendant_pids() {
    ps -o pid=,ppid= -ax 2>/dev/null | awk -v root="$1" '
        {
            pid[NR] = $1
            parent[$1] = $2
            total = NR
        }
        END {
            marked[root] = 1
            changed = 1
            while (changed) {
                changed = 0
                for (i = 1; i <= total; i++) {
                    if (!marked[pid[i]] && marked[parent[pid[i]]]) {
                        marked[pid[i]] = 1
                        changed = 1
                    }
                }
            }
            for (i = 1; i <= total; i++) {
                if (pid[i] != root && marked[pid[i]]) {
                    print pid[i]
                }
            }
        }'
}

# Stop $1, its process group, and every process it spawned, escalating to
# SIGKILL after $2 seconds.
terminate_tree() {
    local root="$1" grace="$2" descendants pid waited=0
    [ -n "$root" ] || return 0

    descendants=$(descendant_pids "$root")
    kill -TERM -"$root" 2>/dev/null || kill -TERM "$root" 2>/dev/null || true
    for pid in $descendants; do
        kill -TERM "$pid" 2>/dev/null || true
    done

    while [ "$waited" -lt "$grace" ] && kill -0 "$root" 2>/dev/null; do
        sleep 1
        waited=$((waited + 1))
    done

    kill -KILL -"$root" 2>/dev/null || kill -KILL "$root" 2>/dev/null || true
    for pid in $descendants; do
        kill -KILL "$pid" 2>/dev/null || true
    done
}

# Stop the running agent (and everything it started), then drop the stream
# reader and the timeout watchdog.
terminate_agent() {
    if [ -n "$WATCHDOG_PID" ]; then
        kill "$WATCHDOG_PID" 2>/dev/null || true
        WATCHDOG_PID=""
    fi
    if [ -n "$AGENT_PID" ]; then
        terminate_tree "$AGENT_PID" 5
        AGENT_PID=""
    fi
    if [ -n "$FILTER_PID" ]; then
        kill -TERM "$FILTER_PID" 2>/dev/null || true
        FILTER_PID=""
    fi
}

issue_status() {
    local issue_id="$1" status
    status=$("$BD_RUNNER" show "$issue_id" --json 2>/dev/null \
        | jq -er '
            (if type == "array" then .[0] else . end)
            | .status | strings | ascii_downcase
        ' 2>/dev/null) || status=""
    case "$status" in
        open|in_progress|closed) printf '%s\n' "$status" ;;
        *) printf '%s\n' unavailable ;;
    esac
}

normalize_open() {
    local issue_id="$1" state
    if "$BD_RUNNER" update "$issue_id" --status open --assignee "" >/dev/null 2>&1; then
        state=$(issue_status "$issue_id")
    else
        state=unavailable
    fi
    if [ "$state" = open ]; then
        return 0
    fi
    echo "[ralph] warning: could not confirm $issue_id open after failed attempt (state=$state)" >&2
    return 1
}

force_interrupt() {
    trap '' INT TERM
    terminate_agent
    say_stop "interrupted (forced)" >&2
    exit 130
}

handle_interrupt() {
    # A second Ctrl-C during cleanup exits immediately.
    trap force_interrupt INT TERM

    printf '\n' >&2
    say_stop "interrupt received; terminating agent" >&2
    terminate_agent

    BD_RUNNER=bd_bounded
    if [ -n "$ACTIVE_BEAD" ] && [ "$(issue_status "$ACTIVE_BEAD")" != closed ]; then
        normalize_open "$ACTIVE_BEAD" || true
        bd_bounded comments add "$ACTIVE_BEAD" \
            "[RALPH] Interrupted at $(timestamp); returned selected bead to the open queue." \
            >/dev/null 2>&1 || true
        say_stop "returned $ACTIVE_BEAD to the open queue" >&2
    fi

    say_stop "interrupted after $CURRENT_ITERATION iteration(s)" >&2
    exit 130
}
trap handle_interrupt INT TERM

acquire_lock

# Turn an agent's JSONL event stream into one short line per tool call.
# Codex (`codex exec --json`) and Claude (`claude -p --output-format
# stream-json`) schemas are both understood; anything unparsable is dropped.
format_agent_stream() {
    jq -rR --unbuffered '
        def clip: gsub("\\s+"; " ") | if length > 160 then .[0:157] + "..." else . end;
        def brief($i):
            ($i.input // {}) as $in
            | ($in.command // $in.file_path // $in.path // $in.pattern // $in.query
               // $in.url // ($in | tostring)) | tostring | clip;

        (fromjson? // empty) as $e
        | if ($e.type == "item.started" or $e.type == "item.completed") then
              ($e.item // {}) as $i
              | ($i.type // "item") as $kind
              | if ($kind == "agent_message" or $kind == "reasoning" or $kind == "todo_list") then
                    empty
                elif $kind == "command_execution" then
                    if $e.type == "item.started" then
                        "[tool] shell: " + (($i.command // "") | tostring | clip)
                    elif (($i.exit_code // 0) != 0) then
                        "[tool] shell failed (exit " + (($i.exit_code // 0) | tostring) + "): "
                        + (($i.command // "") | tostring | clip)
                    else empty
                    end
                elif $kind == "file_change" then
                    if $e.type == "item.completed" then
                        "[tool] edit: "
                        + (($i.changes // [])
                           | map(((.kind // "?") | ascii_upcase | .[0:1]) + " " + (.path // "?"))
                           | join(", ") | clip)
                    else empty
                    end
                elif $kind == "mcp_tool_call" then
                    if $e.type == "item.started" then
                        "[tool] mcp: " + (($i.server // "?") + "." + ($i.tool // "?"))
                    else empty
                    end
                elif $kind == "web_search" then
                    if $e.type == "item.completed" then
                        "[tool] search: " + (($i.query // "") | tostring | clip)
                    else empty
                    end
                elif $kind == "error" then
                    "[tool] error: " + (($i.message // $i.text // "unknown") | tostring | clip)
                else
                    if $e.type == "item.started" then "[tool] " + $kind else empty end
                end
          elif $e.type == "turn.failed" then
              "[tool] turn failed: " + ((($e.error // {}).message // "unknown") | tostring | clip)
          elif $e.type == "error" then
              "[tool] error: " + (($e.message // "unknown") | tostring | clip)
          elif $e.type == "assistant" then
              (($e.message // {}).content // [])[]
              | select(.type == "tool_use")
              | "[tool] " + (.name // "tool") + ": " + brief(.)
          else empty
          end
    ' 2>/dev/null
}

# Run one agent invocation in its own process group, feeding it $stdin_file and
# streaming its output through the tool-line filter. The prompt is redirected
# explicitly because an asynchronous command otherwise inherits /dev/null as
# stdin whenever job control is unavailable (cron, nohup, CI).
# Usage: run_streamed <timeout_secs> <stdin_file> <command> [args...]
run_streamed() {
    local seconds="$1" stdin_file="$2"
    shift 2
    local fifo raw_log status

    STREAM_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-stream.XXXXXX") || return 1
    fifo="$STREAM_DIR/events"
    mkfifo "$fifo" || {
        rm -rf "$STREAM_DIR"
        STREAM_DIR=""
        return 1
    }

    raw_log="$STREAM_DIR/raw.log"
    if [ "$RALPH_SHOW_AGENT_OUTPUT" = 1 ]; then
        tee "$raw_log" < "$fifo" &
    else
        tee "$raw_log" < "$fifo" | format_agent_stream &
    fi
    FILTER_PID=$!

    # `set -m` gives the agent its own process group so an interrupt can take
    # down the commands it spawned; it is turned back off immediately so job
    # notifications stay off the console.
    set -m 2>/dev/null
    "$@" < "$stdin_file" > "$fifo" 2>&1 &
    AGENT_PID=$!
    set +m 2>/dev/null

    if [ "$seconds" -gt 0 ]; then
        (
            sleep "$seconds"
            kill -0 "$AGENT_PID" 2>/dev/null || exit 0
            terminate_tree "$AGENT_PID" 30
        ) &
        WATCHDOG_PID=$!
    fi

    wait "$AGENT_PID" 2>/dev/null
    status=$?
    AGENT_PID=""

    if [ -n "$WATCHDOG_PID" ]; then
        kill "$WATCHDOG_PID" 2>/dev/null || true
        wait "$WATCHDOG_PID" 2>/dev/null || true
        WATCHDOG_PID=""
    fi

    wait "$FILTER_PID" 2>/dev/null || true
    FILTER_PID=""

    # The tool-line filter drops everything that is not a JSON event, which
    # would also swallow startup failures (bad flags, auth errors). Surface
    # those non-event lines when the agent exits nonzero.
    if [ "$status" -ne 0 ] && [ -s "$raw_log" ]; then
        grep -v '^[[:space:]]*{' "$raw_log" 2>/dev/null | tail -10 | while IFS= read -r line; do
            [ -z "$line" ] || echo "[ralph] agent: $line" >&2
        done
    fi

    rm -rf "$STREAM_DIR"
    STREAM_DIR=""
    return "$status"
}

# Return success only when the issue has no unfinished child issues. Query
# failure is treated conservatively as non-leaf so the loop cannot accidentally
# implement an organizational parent.
is_actionable_leaf() {
    local issue_id="$1" children_json unfinished
    children_json=$(bd list --parent "$issue_id" --limit 0 --json 2>/dev/null) || return 1
    unfinished=$(printf '%s' "$children_json" \
        | jq '[.[] | select((.status // "open") != "closed")] | length' 2>/dev/null) || return 1
    [ "$unfinished" -eq 0 ] 2>/dev/null
}

select_candidate_from_json() {
    local issues_json="$1" candidates candidate issue_id
    candidates=$(printf '%s' "$issues_json" | jq -c '
        .[]
        | select(((.issue_type // .type // "") | ascii_downcase) != "epic")
        | select(
            [(.labels // [])[]
             | ascii_downcase
             | select(. == "no-auto-loop" or . == "manual-gate")]
            | length == 0
          )
    ' 2>/dev/null) || return 1

    while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        issue_id=$(printf '%s' "$candidate" | jq -r '.id // empty' 2>/dev/null)
        [ -n "$issue_id" ] || continue
        if is_actionable_leaf "$issue_id"; then
            PICKED_ID="$issue_id"
            PICKED_TITLE=$(printf '%s' "$candidate" | jq -r '.title // "(untitled)"' 2>/dev/null)
            return 0
        fi
    done <<EOF
$candidates
EOF
    return 1
}

pick_bead() {
    local issues_json
    PICKED_ID=""
    PICKED_TITLE=""

    issues_json=$(bd list --status in_progress --limit 0 --json 2>/dev/null) || issues_json='[]'
    if select_candidate_from_json "$issues_json"; then
        return 0
    fi

    issues_json=$(bd ready --json 2>/dev/null) || issues_json='[]'
    select_candidate_from_json "$issues_json"
}

claim_bead() {
    local issue_id="$1" state
    state=$(issue_status "$issue_id")
    case "$state" in
        open)
            bd update "$issue_id" --claim >/dev/null 2>&1 || return 1
            [ "$(issue_status "$issue_id")" = in_progress ]
            ;;
        in_progress)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

implementation_prompt() {
    local issue_id="$1"
    cat "$PROMPT_FILE"
    cat <<EOF

## Loop-selected task

RALPH_SELECTED_BEAD_ID=$issue_id

Run \`bd show $issue_id\` and work only on this exact bead. Do not select or
claim another issue. This is attempt $CURRENT_ITERATION in a fresh agent session.
EOF
}

run_codex_exec() {
    local executable="$1" timeout_seconds="$2" model="$3" prompt_file="$4"
    local -a codex_args

    codex_args=(
        exec
        --json
        --color never
        --dangerously-bypass-approvals-and-sandbox
        --skip-git-repo-check
        --ephemeral
        -C "$PROJECT_DIR"
    )
    [ -z "$model" ] || codex_args+=(--model "$model")
    codex_args+=(-)

    run_streamed "$timeout_seconds" "$prompt_file" "$executable" "${codex_args[@]}"
}

run_implementation_agent() {
    local issue_id="$1" prompt_temp status
    local -a claude_args
    prompt_temp=$(mktemp "${TMPDIR:-/tmp}/mcp-bpmn-agent-prompt.XXXXXX") || return 1
    implementation_prompt "$issue_id" > "$prompt_temp"

    if [ "$(basename "$AGENT_CMD")" = codex ]; then
        run_codex_exec "$AGENT_CMD" "$AGENT_TIMEOUT_SECS" "$AGENT_MODEL" "$prompt_temp"
        status=$?
    elif [ "$(basename "$AGENT_CMD")" = claude ]; then
        claude_args=(-p --dangerously-skip-permissions --output-format stream-json --verbose)
        [ -z "$AGENT_MODEL" ] || claude_args+=(--model "$AGENT_MODEL")
        run_streamed "$AGENT_TIMEOUT_SECS" "$prompt_temp" "$AGENT_CMD" "${claude_args[@]}"
        status=$?
    else
        run_streamed "$AGENT_TIMEOUT_SECS" "$prompt_temp" "$AGENT_CMD"
        status=$?
    fi
    rm -f "$prompt_temp"
    return "$status"
}

codex_recovery_prompt() {
    local issue_id="$1" failures="$2"
    cat <<EOF
You are the recovery investigator for the mcp-bpmn Ralph implementation loop.

Target bead: \`$issue_id\`.
Observed failure: the selected bead remained unclosed after $failures consecutive
fresh implementation sessions. Investigate broadly before changing anything.

Your outcome is to identify and fix the root cause that prevents this bead from
being completed and closed, then return control to the normal implementation
loop. The problem may be in the Beads database, dependency graph, issue wording,
acceptance criteria, implementation, tests, tooling, or working-tree state.

Required investigation:
1. Read AGENTS.md, CLAUDE.md, and the target with \`bd show $issue_id --json\`.
2. Inspect the Beads database through supported commands: \`bd list\`,
   \`bd ready\`, \`bd blocked\`, \`bd dep cycles\`, \`bd orphans --json\`,
   \`bd lint\`, and the target's comments/history and dependency relationships.
3. Inspect \`git status --short\`, the relevant diff, source, tests, package
   scripts, and every failure artifact needed to reproduce the closure blocker.
4. Decide whether the root cause is stale/invalid issue state, a bad dependency,
   incomplete or contradictory acceptance criteria, a verification failure, an
   implementation defect, or an agent/tooling failure. State the evidence.
5. Make the smallest necessary code, test, documentation, or Beads metadata fix.
   Preserve unrelated user/agent changes and never edit raw Dolt database files.
6. Run the target bead's exact verification plus any focused checks needed to
   prove the root cause is fixed.
7. Close \`$issue_id\` only if its acceptance criteria are actually satisfied.
   Otherwise leave it open with a precise Beads comment containing the blocker,
   evidence, completed work, and exact next action so the implementation loop can
   act on it.

Do not create commits, publish changes, synchronize remotes, rewrite history, or
perform unrelated cleanup. Work autonomously until the closure blocker is fixed
or converted into precise actionable Beads state.
EOF
}

run_codex_recovery() {
    local issue_id="$1" failures="$2" prompt_temp status

    prompt_temp=$(mktemp "${TMPDIR:-/tmp}/mcp-bpmn-codex-prompt.XXXXXX") || return 1
    codex_recovery_prompt "$issue_id" "$failures" > "$prompt_temp"

    say_start "codex recovery for $issue_id after $failures failures"
    run_codex_exec "$CODEX_CMD" "$CODEX_TIMEOUT_SECS" "$CODEX_MODEL" "$prompt_temp"
    status=$?
    say_stop "codex recovery for $issue_id (exit $status)"

    rm -f "$prompt_temp"
    return "$status"
}

record_unclosed_attempt() {
    local issue_id="$1" agent_status="$2" bead_state="$3" recovery_status

    normalize_open "$issue_id" || true
    bd comments add "$issue_id" \
        "[RALPH] Attempt $CURRENT_ITERATION did not close the bead: agent_exit=$agent_status, observed_state=$bead_state. Returned to open for retry." \
        >/dev/null 2>&1 || true

    if [ "$LAST_FAILED_BEAD" = "$issue_id" ]; then
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    else
        LAST_FAILED_BEAD="$issue_id"
        CONSECUTIVE_FAILURES=1
    fi

    say_stop "$issue_id unclosed (agent exit $agent_status, state $bead_state, $CONSECUTIVE_FAILURES/$STUCK_LOOP_THRESHOLD consecutive failures)"
    if [ "$CONSECUTIVE_FAILURES" -lt "$STUCK_LOOP_THRESHOLD" ]; then
        return 0
    fi

    run_codex_recovery "$issue_id" "$CONSECUTIVE_FAILURES"
    recovery_status=$?
    if [ "$recovery_status" -ne 0 ]; then
        echo "[ralph] warning: Codex recovery exited $recovery_status; normal loop will retry" >&2
        bd comments add "$issue_id" \
            "[RALPH] Codex recovery exited $recovery_status after $CONSECUTIVE_FAILURES failures; returning to normal retry loop." \
            >/dev/null 2>&1 || true
    elif [ "$(issue_status "$issue_id")" != closed ]; then
        normalize_open "$issue_id" || true
    fi

    # A completed recovery session starts a new failure window. If the blocker
    # persists, another recovery is allowed only after three more attempts.
    LAST_FAILED_BEAD=""
    CONSECUTIVE_FAILURES=0
}

say_start "mcp-bpmn loop (project $PROJECT_DIR, max iterations $MAX_ITERATIONS, recovery threshold $STUCK_LOOP_THRESHOLD)"

while [ "$MAX_ITERATIONS" -eq 0 ] || [ "$CURRENT_ITERATION" -lt "$MAX_ITERATIONS" ]; do
    CURRENT_ITERATION=$((CURRENT_ITERATION + 1))
    PICKED_ID=""
    PICKED_TITLE=""

    if ! pick_bead; then
        say_stop "no actionable ready or in-progress leaf beads"
        break
    fi

    ACTIVE_BEAD="$PICKED_ID"
    say_start "attempt $CURRENT_ITERATION on $PICKED_ID — $PICKED_TITLE ($(timestamp))"

    if ! claim_bead "$PICKED_ID"; then
        state=$(issue_status "$PICKED_ID")
        echo "[ralph] warning: could not claim $PICKED_ID (state=$state)" >&2
        record_unclosed_attempt "$PICKED_ID" 1 "$state"
        ACTIVE_BEAD=""
        [ "$RETRY_DELAY_SECS" -eq 0 ] || sleep "$RETRY_DELAY_SECS"
        continue
    fi

    run_implementation_agent "$PICKED_ID"
    agent_status=$?
    state=$(issue_status "$PICKED_ID")

    if [ "$state" = closed ]; then
        say_stop "$PICKED_ID closed (attempt $CURRENT_ITERATION, agent exit $agent_status)"
        LAST_FAILED_BEAD=""
        CONSECUTIVE_FAILURES=0
    else
        record_unclosed_attempt "$PICKED_ID" "$agent_status" "$state"
    fi

    ACTIVE_BEAD=""
    [ "$RETRY_DELAY_SECS" -eq 0 ] || sleep "$RETRY_DELAY_SECS"
done

say_stop "loop complete after $CURRENT_ITERATION iteration(s)"
