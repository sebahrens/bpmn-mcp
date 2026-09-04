#!/bin/bash
#
# Integration tests for ralph-loop/loop.sh.
#
# Run with `npm run test:ralph`; `npm run test:all` (and therefore `npm run
# check` and CI) runs it too. Every test builds a throwaway fixture with fake
# `bd`, `codex` and `claude` executables on PATH, so no real Beads database,
# agent or network is touched.
#
# Requires bash, jq and perl. `git` must be on PATH because loop.sh checks for
# it, but no Git command is executed against this repository.

set -eu

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../.." && pwd)"
LOOP_SOURCE="$REPO_ROOT/ralph-loop/loop.sh"
FIXTURES=()
NEW_FIXTURE=""

fail() {
    echo "not ok - $*" >&2
    exit 1
}

pass() {
    echo "ok - $*"
}

assert_eq() {
    local expected="$1" actual="$2" message="$3"
    [ "$expected" = "$actual" ] || fail "$message (expected '$expected', got '$actual')"
}

assert_file_contains() {
    local path="$1" expected="$2" message="$3"
    grep -Fq -- "$expected" "$path" || fail "$message ('$expected' not found in $path)"
}

cleanup() {
    local fixture
    for fixture in ${FIXTURES[@]+"${FIXTURES[@]}"}; do
        rm -rf "$fixture"
    done
}
trap cleanup EXIT

new_fixture() {
    local name="$1" fixture
    fixture=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-loop-${name}.XXXXXX")
    FIXTURES+=("$fixture")
    mkdir -p "$fixture/ralph-loop" "$fixture/bin" "$fixture/state" "$fixture/locks"
    cp -f "$LOOP_SOURCE" "$fixture/ralph-loop/loop.sh"
    cat > "$fixture/ralph-loop/PROMPT_build.md" <<'EOF'
# Test implementation prompt

Implement only the bead selected by the wrapping loop and close it only after verification.
EOF

    cat > "$fixture/bin/bd" <<'EOF'
#!/bin/bash
set -eu

state_file="$TEST_STATE_DIR/issues.json"
log_file="$TEST_STATE_DIR/bd.log"
printf '%q ' "$@" >> "$log_file"
printf '\n' >> "$log_file"

command_name="${1:-}"
[ "$#" -gt 0 ] && shift

write_status() {
    local issue_id="$1" new_status="$2" tmp
    tmp="${state_file}.tmp"
    if [ "${ROTATE_ON_REOPEN:-0}" = "1" ] && [ "$new_status" = "open" ]; then
        jq --arg id "$issue_id" --arg status "$new_status" \
            '(.[] | select(.id == $id) | .status = $status) as $updated
             | [.[] | select(.id != $id)] + [$updated]' \
            "$state_file" > "$tmp"
    else
        jq --arg id "$issue_id" --arg status "$new_status" \
            'map(if .id == $id then .status = $status else . end)' \
            "$state_file" > "$tmp"
    fi
    mv -f "$tmp" "$state_file"
}

case "$command_name" in
    list)
        status=""
        parent=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --status=*) status="${1#--status=}" ;;
                --status) shift; status="${1:-}" ;;
                --parent=*) parent="${1#--parent=}" ;;
                --parent) shift; parent="${1:-}" ;;
            esac
            shift || true
        done
        jq --arg status "$status" --arg parent "$parent" '
            [.[]
             | select(($status == "") or (.status == $status))
             | select(($parent == "") or ((.parent // "") == $parent))]
        ' "$state_file"
        ;;
    ready)
        jq '[.[] | select(.status == "open" and (.ready // true))]' "$state_file"
        ;;
    show)
        issue_id="${1:-}"
        jq --arg id "$issue_id" '[.[] | select(.id == $id)]' "$state_file"
        ;;
    update)
        issue_id="${1:-}"
        shift || true
        new_status=""
        while [ "$#" -gt 0 ]; do
            case "$1" in
                --claim) new_status="in_progress" ;;
                --status=*) new_status="${1#--status=}" ;;
                --status) shift; new_status="${1:-}" ;;
            esac
            shift || true
        done
        [ -z "$new_status" ] || write_status "$issue_id" "$new_status"
        ;;
    comments)
        # Logging the command is sufficient for these integration tests.
        ;;
    *)
        echo "fake bd: unsupported command '$command_name'" >&2
        exit 2
        ;;
esac
EOF

    cat > "$fixture/bin/claude" <<'EOF'
#!/bin/bash
set -eu

cat > "$TEST_STATE_DIR/unexpected-claude-prompt.txt"
printf '%q ' "$@" > "$TEST_STATE_DIR/unexpected-claude-args.txt"
exit 91
EOF

    cat > "$fixture/bin/codex" <<'EOF'
#!/bin/bash
set -eu

raw_prompt=$(mktemp "$TEST_STATE_DIR/codex-input.XXXXXX")
cat > "$raw_prompt"

close_issue() {
    local issue_id="$1"
    tmp="${TEST_STATE_DIR}/issues.json.tmp"
    jq --arg id "$issue_id" \
        'map(if .id == $id then .status = "closed" else . end)' \
        "$TEST_STATE_DIR/issues.json" > "$tmp"
    mv -f "$tmp" "$TEST_STATE_DIR/issues.json"
}

# Mimic the JSONL event stream of `codex exec --json`, including the prose and
# reasoning events the loop is expected to hide.
emit_events() {
    local label="$1"
    printf 'Reading additional input from stdin...\n'
    printf '{"type":"thread.started","thread_id":"test-thread"}\n'
    printf '{"type":"turn.started"}\n'
    printf '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"AGENT-PROSE-%s"}}\n' "$label"
    printf '{"type":"item.completed","item":{"id":"item_1","type":"reasoning","text":"AGENT-REASONING-%s"}}\n' "$label"
    printf '{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"npm test -- %s","exit_code":null,"status":"in_progress"}}\n' "$label"
    printf '{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"npm test -- %s","exit_code":0,"status":"completed"}}\n' "$label"
    printf '{"type":"turn.completed","usage":{"input_tokens":1}}\n'
}

maybe_block() {
    local seconds="${AGENT_SLEEP_SECS:-0}" escaped
    [ "$seconds" -gt 0 ] || return 0
    # Mimic Codex: the spawned command lives in its own process group, so it is
    # not reachable through a kill aimed at the agent's group.
    perl -e 'setpgrp(0,0); exec("sleep", $ARGV[0]) or exit 1' "$seconds" &
    escaped=$!
    printf '%s\n' "$escaped" > "$TEST_STATE_DIR/agent-grandchild.pid"
    printf '%s\n' "$$" > "$TEST_STATE_DIR/agent-child.pid"
    wait "$escaped" 2>/dev/null || true
    : > "$TEST_STATE_DIR/agent-finished"
}

if grep -q '^RALPH_SELECTED_BEAD_ID=' "$raw_prompt"; then
    count_file="$TEST_STATE_DIR/agent.count"
    count=0
    [ ! -f "$count_file" ] || count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    prompt_file="$TEST_STATE_DIR/agent-prompt-${count}.txt"
    args_file="$TEST_STATE_DIR/agent-args-${count}.txt"
    mv -f "$raw_prompt" "$prompt_file"
    issue_id=$(sed -n 's/^RALPH_SELECTED_BEAD_ID=//p' "$prompt_file" | head -1)
    [ -n "$issue_id" ] || exit 3

    printf '%q ' "$@" > "$args_file"
    printf '\n' >> "$args_file"
    emit_events "implementation"
    maybe_block

    case "${AGENT_BEHAVIOR:-never-close}" in
        close) close_issue "$issue_id" ;;
        close-after-recovery)
            [ ! -f "$TEST_STATE_DIR/codex.count" ] || close_issue "$issue_id"
            ;;
        never-close) ;;
        *) exit 4 ;;
    esac
else
    count_file="$TEST_STATE_DIR/codex.count"
    count=0
    [ ! -f "$count_file" ] || count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s\n' "$count" > "$count_file"
    prompt_file="$TEST_STATE_DIR/codex-prompt-${count}.txt"
    args_file="$TEST_STATE_DIR/codex-args-${count}.txt"
    mv -f "$raw_prompt" "$prompt_file"

    printf '%q ' "$@" > "$args_file"
    printf '\n' >> "$args_file"
    emit_events "recovery"

    if [ "${CODEX_BEHAVIOR:-leave-open}" = "close" ]; then
        issue_id=$(sed -n 's/^Target bead: `\([^`]*\)`.*/\1/p' "$prompt_file" | head -1)
        [ -n "$issue_id" ] || exit 5
        close_issue "$issue_id"
    fi
fi
EOF

    chmod +x "$fixture/bin/bd" "$fixture/bin/claude" "$fixture/bin/codex"
    NEW_FIXTURE="$fixture"
}

run_loop() {
    local fixture="$1" max_iterations="$2" agent_behavior="$3" codex_behavior="$4"
    TEST_STATE_DIR="$fixture/state" \
    PATH="$fixture/bin:$PATH" \
    RALPH_LOCK_ROOT="$fixture/locks" \
    MAX_ITERATIONS="$max_iterations" \
    AGENT_BEHAVIOR="$agent_behavior" \
    CODEX_BEHAVIOR="$codex_behavior" \
    AGENT_TIMEOUT_SECS=0 \
    CODEX_TIMEOUT_SECS=0 \
    RETRY_DELAY_SECS=0 \
    "$fixture/ralph-loop/loop.sh" > "$fixture/state/loop.out" 2>&1 \
        || { cat "$fixture/state/loop.out" >&2; fail "loop exited nonzero"; }
}

test_default_executor_is_codex() {
    local fixture
    new_fixture default-codex
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-33g.3","title":"Use Codex by default","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    run_loop "$fixture" 1 close leave-open

    [ -f "$fixture/state/agent.count" ] || fail "default implementation executor should invoke Codex"
    assert_eq 1 "$(cat "$fixture/state/agent.count")" "default Codex implementation should run once"
    [ ! -e "$fixture/state/unexpected-claude-prompt.txt" ] || fail "default implementation executor must not invoke Claude"
    assert_file_contains "$fixture/state/agent-args-1.txt" 'exec' \
        "default Codex implementation should use codex exec"
    pass "default implementation executor is Codex"
}

test_third_failure_runs_codex_and_returns_to_loop() {
    local fixture agent_count codex_count
    new_fixture stuck
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-9sv.7","title":"First dotted task","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true},
  {"id":"mcp-bpmn-9sv.8","title":"Task after recovery","status":"open","issue_type":"task","priority":2,"labels":[],"ready":true}
]
EOF

    run_loop "$fixture" 4 close-after-recovery close

    agent_count=$(cat "$fixture/state/agent.count")
    codex_count=$(cat "$fixture/state/codex.count")
    assert_eq 4 "$agent_count" "normal implementation loop should continue after recovery"
    assert_eq 1 "$codex_count" "third consecutive unclosed attempt should invoke Codex once"
    assert_eq 2 "$(jq '[.[] | select(.status == "closed")] | length' "$fixture/state/issues.json")" \
        "Codex recovery and the resumed loop should close both tasks"
    assert_file_contains "$fixture/state/codex-prompt-1.txt" 'Target bead: `mcp-bpmn-9sv.7`.' \
        "recovery prompt should pin the stuck dotted bead"
    assert_file_contains "$fixture/state/codex-prompt-1.txt" 'Beads database' \
        "recovery prompt should investigate the Beads database"
    assert_file_contains "$fixture/state/codex-prompt-1.txt" 'bd dep cycles' \
        "recovery prompt should inspect dependency cycles"
    assert_file_contains "$fixture/state/codex-prompt-1.txt" 'bd orphans' \
        "recovery prompt should inspect orphaned dependency records"
    assert_file_contains "$fixture/state/codex-prompt-1.txt" 'bd lint' \
        "recovery prompt should inspect issue actionability"
    pass "third same-bead failure invokes broad Codex recovery and resumes"
}

test_successful_closure_never_runs_codex() {
    local fixture
    new_fixture success
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-a3j.1","title":"Close immediately","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    run_loop "$fixture" 2 close leave-open

    assert_eq 1 "$(cat "$fixture/state/agent.count")" "closed bead should need one agent session"
    [ ! -e "$fixture/state/codex.count" ] || fail "successful closure must not invoke Codex"
    pass "confirmed closure resets failures without Codex"
}

test_failures_for_different_beads_do_not_combine() {
    local fixture
    new_fixture alternating
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-a3j.1","title":"Alternating A","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true},
  {"id":"mcp-bpmn-a3j.2","title":"Alternating B","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    ROTATE_ON_REOPEN=1 run_loop "$fixture" 4 never-close leave-open

    assert_eq 4 "$(cat "$fixture/state/agent.count")" "all alternating attempts should run"
    [ ! -e "$fixture/state/codex.count" ] || fail "nonconsecutive failures from different beads must not invoke Codex"
    pass "failure streak is isolated to one bead"
}

test_selector_skips_epics_labels_and_non_leaf_parents() {
    local fixture prompt
    new_fixture selector
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-33g","title":"Organizational epic","status":"open","issue_type":"epic","priority":0,"labels":[],"ready":true},
  {"id":"mcp-bpmn-iqa.1","title":"Manual gate","status":"open","issue_type":"task","priority":0,"labels":["manual-gate"],"ready":true},
  {"id":"mcp-bpmn-5e7.1","title":"Parent task","status":"open","issue_type":"task","priority":0,"labels":[],"ready":true},
  {"id":"mcp-bpmn-5e7.2","title":"Blocked child","status":"open","issue_type":"task","priority":0,"labels":["no-auto-loop"],"parent":"mcp-bpmn-5e7.1","ready":true},
  {"id":"mcp-bpmn-9sv.7","title":"Actionable dotted leaf","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    run_loop "$fixture" 1 close leave-open

    prompt="$fixture/state/agent-prompt-1.txt"
    assert_file_contains "$prompt" 'RALPH_SELECTED_BEAD_ID=mcp-bpmn-9sv.7' \
        "selector should preserve and pin the actionable dotted leaf ID"
    assert_file_contains "$fixture/state/bd.log" 'update mcp-bpmn-9sv.7 --claim' \
        "selector should claim the chosen leaf"
    pass "selector skips epics, gated labels, and non-leaf parents"
}

test_console_shows_only_tools_and_loop_messages() {
    local fixture output
    new_fixture console
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-33g.9","title":"Quiet console","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    run_loop "$fixture" 1 close leave-open
    output="$fixture/state/loop.out"

    assert_file_contains "$output" '[tool] shell: npm test -- implementation' \
        "agent tool calls should reach the console"
    assert_file_contains "$output" '[ralph] start:' "loop should print start messages"
    assert_file_contains "$output" '[ralph] stop:' "loop should print stop messages"
    ! grep -q 'AGENT-PROSE' "$output" || fail "agent prose must not reach the console"
    ! grep -q 'AGENT-REASONING' "$output" || fail "agent reasoning must not reach the console"
    ! grep -q 'thread.started' "$output" || fail "raw agent events must not reach the console"
    ! grep -Ev '^\[(ralph|tool)\]' "$output" | grep -q '[^[:space:]]' \
        || fail "console must only contain [ralph] and [tool] lines: $(cat "$output")"
    assert_file_contains "$fixture/state/agent-args-1.txt" '--json' \
        "implementation agent should request the JSONL event stream"
    pass "console shows only tool calls and loop start/stop messages"
}

test_interrupt_stops_loop_and_releases_bead() {
    local fixture loop_pid status child escaped waited
    new_fixture interrupt
    fixture="$NEW_FIXTURE"
    cat > "$fixture/state/issues.json" <<'EOF'
[
  {"id":"mcp-bpmn-a3j.5","title":"Long running attempt","status":"open","issue_type":"task","priority":1,"labels":[],"ready":true}
]
EOF

    # Job control gives the loop its own process group with a default SIGINT
    # disposition, matching how it runs in the foreground of a terminal.
    set -m
    TEST_STATE_DIR="$fixture/state" \
    PATH="$fixture/bin:$PATH" \
    RALPH_LOCK_ROOT="$fixture/locks" \
    MAX_ITERATIONS=0 \
    AGENT_BEHAVIOR=close \
    AGENT_SLEEP_SECS=45 \
    AGENT_TIMEOUT_SECS=0 \
    CODEX_TIMEOUT_SECS=0 \
    RETRY_DELAY_SECS=0 \
    "$fixture/ralph-loop/loop.sh" > "$fixture/state/loop.out" 2>&1 &
    loop_pid=$!
    set +m

    waited=0
    while [ ! -f "$fixture/state/agent-child.pid" ] && [ "$waited" -lt 100 ]; do
        sleep 0.2
        waited=$((waited + 1))
    done
    [ -f "$fixture/state/agent-child.pid" ] || fail "agent never started"
    child=$(cat "$fixture/state/agent-child.pid")

    kill -INT "$loop_pid"
    status=0
    wait "$loop_pid" 2>/dev/null || status=$?

    assert_eq 130 "$status" "interrupted loop should exit 130"
    [ ! -f "$fixture/state/agent-finished" ] || fail "interrupt should terminate the running agent"

    escaped=$(cat "$fixture/state/agent-grandchild.pid")
    waited=0
    while { kill -0 "$child" 2>/dev/null || kill -0 "$escaped" 2>/dev/null; } && [ "$waited" -lt 50 ]; do
        sleep 0.2
        waited=$((waited + 1))
    done
    ! kill -0 "$child" 2>/dev/null || fail "agent process $child survived the interrupt"
    ! kill -0 "$escaped" 2>/dev/null \
        || fail "command spawned by the agent (pid $escaped) survived the interrupt"

    assert_eq open "$(jq -r '.[] | select(.id == "mcp-bpmn-a3j.5") | .status' "$fixture/state/issues.json")" \
        "interrupt should return the selected bead to open"
    assert_file_contains "$fixture/state/loop.out" '[ralph] stop: interrupt' \
        "interrupt should print a stop message"
    pass "Ctrl-C stops the loop, kills the agent, and releases the bead"
}

[ -f "$LOOP_SOURCE" ] || fail "ralph-loop/loop.sh does not exist"

for required_command in jq perl git; do
    command -v "$required_command" >/dev/null 2>&1 \
        || fail "$required_command is required to run the loop tests"
done

test_default_executor_is_codex
test_third_failure_runs_codex_and_returns_to_loop
test_successful_closure_never_runs_codex
test_failures_for_different_beads_do_not_combine
test_selector_skips_epics_labels_and_non_leaf_parents
test_console_shows_only_tools_and_loop_messages
test_interrupt_stops_loop_and_releases_bead

if grep -En '(^|[;&|[:space:]])(git[[:space:]]+(commit|push|reset|clean|stash)|bd[[:space:]]+dolt[[:space:]]+(push|pull))' \
        "$LOOP_SOURCE" >/dev/null 2>&1; then
    fail "loop contains a forbidden commit/push/sync/stash/clean/reset command path"
fi
pass "loop has no destructive or shared-state Git/Beads command path"

echo "1..8"
