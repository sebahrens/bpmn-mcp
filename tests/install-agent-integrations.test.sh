#!/bin/sh

set -eu

PROJECT_ROOT=$(CDPATH= cd -P "$(dirname "$0")/.." && pwd)
INSTALLER=$PROJECT_ROOT/scripts/install-agent-integrations.sh
REAL_NODE=$(command -v node)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-installer-test.XXXXXX")

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  printf '%s' "$1" | grep -F "$2" >/dev/null \
    || fail "expected output to contain: $2"
}

assert_equals() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_file() {
  [ -f "$1" ] || fail "expected file: $1"
}

assert_absent() {
  [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected path to be absent: $1"
}

set_claude_registration() {
  config_file=$1
  command_path=$2
  diagrams_path=$3
  "$REAL_NODE" -e '
    const fs = require("fs");
    const [path, command, diagrams] = process.argv.slice(1);
    const config = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8")) : {};
    config.mcpServers ||= {};
    config.mcpServers["mcp-bpmn"] = {
      type: "stdio", command, args: [], env: { MCP_BPMN_DIAGRAMS_PATH: diagrams }
    };
    fs.mkdirSync(require("path").dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(config));
  ' "$config_file" "$command_path" "$diagrams_path"
}

claude_registration_field() {
  "$REAL_NODE" -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const registration = config.mcpServers["mcp-bpmn"];
    process.stdout.write(process.argv[2] === "command"
      ? registration.command : registration.env.MCP_BPMN_DIAGRAMS_PATH);
  ' "$1" "$2"
}

write_fakes() {
  fake_bin=$1
  mkdir -p "$fake_bin"

  sed "s|__REAL_NODE__|$REAL_NODE|g" > "$fake_bin/node" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "-p" ] && [ "${2:-}" = "process.versions.node" ]; then
  printf '%s\n' "${FAKE_NODE_VERSION:-22.12.0}"
  exit 0
fi
if [ "${1:-}" = "-p" ] && [ "${2:-}" = "process.platform" ]; then
  printf '%s\n' linux
  exit 0
fi
exec __REAL_NODE__ "$@"
EOF

  cat > "$fake_bin/npm" <<'EOF'
#!/bin/sh
set -eu
log=$FAKE_STATE_DIR/npm.log
{
  printf 'cache=<%s>|prefix=<%s>' "${npm_config_cache:-}" \
    "${npm_config_prefix:-${NPM_CONFIG_PREFIX:-}}"
  for argument in "$@"; do
    printf '|<%s>' "$argument"
  done
  printf '\n'
} >> "$log"
case "${1:-}" in
  --version)
    printf '11.0.0\n'
    ;;
  pack)
    package_version=${FAKE_PACKAGE_VERSION:-0.2.0}
    destination=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--pack-destination" ]; then
        shift
        destination=$1
      fi
      shift
    done
    : > "$destination/mcp-bpmn-server-$package_version.tgz"
    printf '> mcp-bpmn-server@%s prepack\n' "$package_version"
    printf '[{"filename":"mcp-bpmn-server-%s.tgz"}]\n' "$package_version"
    ;;
  install)
    [ "${FAKE_FAIL_NPM_INSTALL:-0}" != 1 ] || exit 42
    if [ -n "${FAKE_NPM_WAIT_SIGNAL:-}" ]; then
      : > "$FAKE_NPM_WAIT_SIGNAL"
      while [ ! -f "${FAKE_NPM_WAIT_RELEASE:?}" ]; do sleep 0.05; done
    fi
    if [ "${FAKE_REPLACE_CODEX_DURING_NPM_INSTALL:-0}" = 1 ]; then
      printf '/during-staging/server\n/during-staging/diagrams\n' \
        > "$FAKE_STATE_DIR/codex-registration"
    fi
    package_version=${FAKE_PACKAGE_VERSION:-0.2.0}
    prefix=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--prefix" ]; then
        shift
        prefix=$1
      fi
      shift
    done
    package_root=$prefix/node_modules/mcp-bpmn-server
    mkdir -p "$prefix/node_modules/.bin" "$package_root/skills/bpmn-modeler/references"
    printf '#!/bin/sh\nexit 0\n' > "$prefix/node_modules/.bin/mcp-bpmn-server"
    chmod +x "$prefix/node_modules/.bin/mcp-bpmn-server"
    printf '{"name":"mcp-bpmn-server","version":"%s"}\n' "$package_version" > "$package_root/package.json"
    printf '%s\n' '---' 'name: bpmn-modeler' 'description: test skill' '---' > "$package_root/skills/bpmn-modeler/SKILL.md"
    printf 'test reference for %s\n' "$package_version" > "$package_root/skills/bpmn-modeler/references/workflows.md"
    ;;
  *)
    printf 'unexpected fake npm invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
EOF

  cat > "$fake_bin/codex" <<'EOF'
#!/bin/sh
set -eu
state=$FAKE_STATE_DIR/codex-registration
log=$FAKE_STATE_DIR/codex.log
{
  printf 'argv'
  for argument in "$@"; do
    printf '|<%s>' "$argument"
  done
  printf '\n'
} >> "$log"
case "$1 ${2:-}" in
  'mcp get')
    if [ -f "$FAKE_STATE_DIR/fail-next-codex-get" ]; then
      /bin/rm -f "$FAKE_STATE_DIR/fail-next-codex-get"
      printf 'injected Codex configuration read failure\n' >&2
      exit 42
    fi
    if [ -f "$FAKE_STATE_DIR/fail-all-codex-get" ]; then
      printf 'injected persistent Codex configuration read failure\n' >&2
      exit 42
    fi
    if [ -f "$state" ]; then
      command_path=$(sed -n '1p' "$state")
      diagrams_path=$(sed -n '2p' "$state")
      if [ "$(sed -n '3p' "$state")" = disabled ]; then
        printf '{"enabled":false,"transport":{"type":"stdio","command":"%s","args":[],"env":{"MCP_BPMN_DIAGRAMS_PATH":"%s"}}}\n' \
          "$command_path" "$diagrams_path"
      elif [ "$(sed -n '3p' "$state")" = legacy-http ]; then
        printf '{"transport":{"type":"http","url":"https://example.invalid/mcp"}}\n'
      elif [ -z "$diagrams_path" ]; then
        printf '{"transport":{"type":"stdio","command":"%s","args":[],"env":{}}}\n' \
          "$command_path"
      else
        printf '{"transport":{"type":"stdio","command":"%s","args":[],"env":{"MCP_BPMN_DIAGRAMS_PATH":"%s"}}}\n' \
          "$command_path" "$diagrams_path"
      fi
    else
      printf "Error: No MCP server named 'mcp-bpmn' found.\n" >&2
      exit 1
    fi
    ;;
  'mcp add')
    [ "${FAKE_FAIL_CODEX_ADD:-0}" != 1 ] || exit 42
    previous=
    command_path=
    diagrams_path=
    for argument in "$@"; do
      if [ "$previous" = -- ]; then
        command_path=$argument
        break
      fi
      case "$argument" in
        MCP_BPMN_DIAGRAMS_PATH=*) diagrams_path=${argument#MCP_BPMN_DIAGRAMS_PATH=} ;;
      esac
      previous=$argument
    done
    printf '%s\n%s\n' "$command_path" "$diagrams_path" > "$state"
    if [ "${FAKE_FAIL_CODEX_VERIFY_ONCE:-0}" = 1 ] \
      && [ ! -f "$FAKE_STATE_DIR/codex-verify-failure-used" ]; then
      : > "$FAKE_STATE_DIR/codex-verify-failure-used"
      : > "$FAKE_STATE_DIR/fail-next-codex-get"
    fi
    ;;
  'mcp remove')
    rm -f "$state"
    ;;
  '--version ')
    printf 'codex-cli 1.0.0\n'
    ;;
  *) exit 1 ;;
esac
EOF

  cat > "$fake_bin/claude" <<'EOF'
#!/bin/sh
set -eu
state=$CLAUDE_CONFIG_DIR/.claude.json
log=$FAKE_STATE_DIR/claude.log
{
  printf 'argv'
  for argument in "$@"; do
    printf '|<%s>' "$argument"
  done
  printf '\n'
} >> "$log"
case "$1 ${2:-}" in
  'mcp get')
    if [ -f "$FAKE_STATE_DIR/fail-all-claude-get" ]; then
      printf 'injected persistent Claude configuration read failure\n' >&2
      exit 42
    fi
    registration=$("$REAL_NODE" -e '
      const fs = require("fs");
      try {
        const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).mcpServers?.["mcp-bpmn"];
        if (!value) process.exit(1);
        process.stdout.write(`${value.command}\n${value.env?.MCP_BPMN_DIAGRAMS_PATH || ""}`);
      } catch { process.exit(1); }
    ' "$state") || {
      printf 'No MCP server named "mcp-bpmn".\n' >&2
      exit 1
    }
    registration_command=$(printf '%s\n' "$registration" | sed -n '1p')
    registration_diagrams=$(printf '%s\n' "$registration" | sed -n '2p')
    printf 'mcp-bpmn:\n  Scope: User config\n  Command: %s\n  Args:\n  Environment:\n' \
      "$registration_command"
    if [ -n "$registration_diagrams" ]; then
      printf '    MCP_BPMN_DIAGRAMS_PATH=%s\n' "$registration_diagrams"
    fi
    ;;
  'mcp add')
    if [ "${FAKE_FAIL_CLAUDE_ADD:-0}" = 1 ]; then
      if [ "${FAKE_MUTATE_CODEX_CONFIG_ON_CLAUDE_FAILURE:-0}" = 1 ]; then
        printf 'unrelated-during-install=true\n' >> "$CODEX_HOME/config.toml"
      fi
      if [ "${FAKE_REPLACE_CODEX_ON_CLAUDE_FAILURE:-0}" = 1 ]; then
        printf '/late/third-party/server\n/late/third-party/diagrams\n' \
          > "$FAKE_STATE_DIR/codex-registration"
      fi
      if [ "${FAKE_DELETE_CODEX_ON_CLAUDE_FAILURE:-0}" = 1 ]; then
        /bin/rm -f "$FAKE_STATE_DIR/codex-registration"
      fi
      if [ "${FAKE_BREAK_CODEX_READ_ON_CLAUDE_FAILURE:-0}" = 1 ]; then
        : > "$FAKE_STATE_DIR/fail-all-codex-get"
      fi
      exit 42
    fi
    command_path=
    diagrams_path=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = mcp-bpmn ]; then
        shift
        command_path=$1
      elif [ "$1" = -e ] && [ "$#" -ge 2 ]; then
        shift
        diagrams_path=${1#MCP_BPMN_DIAGRAMS_PATH=}
      fi
      shift
    done
    "$REAL_NODE" -e '
      const fs = require("fs"), path = require("path");
      const [file, command, diagrams] = process.argv.slice(1);
      const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      config.mcpServers ||= {};
      const registration = { type: "stdio", command, args: [] };
      if (diagrams) registration.env = { MCP_BPMN_DIAGRAMS_PATH: diagrams };
      config.mcpServers["mcp-bpmn"] = registration;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config));
    ' "$state" "$command_path" "$diagrams_path"
    if [ "${FAKE_REPLACE_CLAUDE_AFTER_ADD:-0}" = 1 ]; then
      "$REAL_NODE" -e '
        const fs = require("fs"), file = process.argv[1];
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        config.mcpServers["mcp-bpmn"] = {
          type: "stdio", command: "/late/claude/server", args: [],
          env: { MCP_BPMN_DIAGRAMS_PATH: "/late/claude/diagrams" }
        };
        fs.writeFileSync(file, JSON.stringify(config));
      ' "$state"
    fi
    if [ "${FAKE_DELETE_CLAUDE_AFTER_ADD:-0}" = 1 ]; then
      "$REAL_NODE" -e '
        const fs = require("fs"), file = process.argv[1];
        const config = JSON.parse(fs.readFileSync(file, "utf8"));
        delete config.mcpServers["mcp-bpmn"];
        fs.writeFileSync(file, JSON.stringify(config));
      ' "$state"
    fi
    if [ "${FAKE_BREAK_CLAUDE_READ_AFTER_ADD:-0}" = 1 ]; then
      printf '{' > "$state"
      : > "$FAKE_STATE_DIR/fail-all-claude-get"
    fi
    ;;
  'mcp add-json')
    json=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = mcp-bpmn ] && [ "$#" -ge 2 ]; then shift; json=$1; fi
      shift
    done
    "$REAL_NODE" -e '
      const fs = require("fs"), path = require("path");
      const [file, json] = process.argv.slice(1);
      const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
      config.mcpServers ||= {};
      config.mcpServers["mcp-bpmn"] = JSON.parse(json);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config));
    ' "$state" "$json"
    ;;
  'mcp remove')
    "$REAL_NODE" -e '
      const fs = require("fs");
      const file = process.argv[1];
      if (!fs.existsSync(file)) process.exit(0);
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      if (config.mcpServers) delete config.mcpServers["mcp-bpmn"];
      fs.writeFileSync(file, JSON.stringify(config));
    ' "$state"
    ;;
  '--version ')
    printf '1.0.0 (Claude Code)\n'
    ;;
  *) exit 1 ;;
esac
EOF

  cat > "$fake_bin/cp" <<'EOF'
#!/bin/sh
set -eu
if [ "${FAKE_FAIL_SKILL_COPY:-0}" = 1 ]; then
  for argument in "$@"; do
    case "$argument" in
      */node_modules/mcp-bpmn-server/skills/bpmn-modeler/.) exit 42 ;;
    esac
  done
fi
exec /bin/cp "$@"
EOF

  cat > "$fake_bin/mv" <<'EOF'
#!/bin/sh
set -eu
destination=
for argument in "$@"; do
  destination=$argument
done
if [ -n "${FAKE_INTERRUPT_AFTER_SNAPSHOT_MOVE:-}" ]; then
  case "$destination" in
    */rollback/"$FAKE_INTERRUPT_AFTER_SNAPSHOT_MOVE")
      /bin/mv "$@"
      kill -TERM "$PPID"
      exit 0
      ;;
  esac
fi
exec /bin/mv "$@"
EOF

  cat > "$fake_bin/rm" <<'EOF'
#!/bin/sh
set -eu
if [ "${FAKE_FAIL_TEMP_CLEANUP:-0}" = 1 ]; then
  for argument in "$@"; do
    case "$argument" in
      */mcp-bpmn-install.*) exit 42 ;;
    esac
  done
fi
exec /bin/rm "$@"
EOF

  chmod +x "$fake_bin/node" "$fake_bin/npm" "$fake_bin/codex" "$fake_bin/claude" \
    "$fake_bin/cp" "$fake_bin/mv" "$fake_bin/rm"
}

CASE_ROOT=$TEST_ROOT/'checkout and install paths with spaces'
SOURCE_ROOT=$CASE_ROOT/'source checkout'
FAKE_BIN=$CASE_ROOT/bin
FAKE_STATE_DIR=$CASE_ROOT/state
HOME=$CASE_ROOT/home
XDG_DATA_HOME=$CASE_ROOT/'xdg data'
NPM_CONFIG_PREFIX=$CASE_ROOT/'npm prefix'
npm_config_prefix=$NPM_CONFIG_PREFIX
TMPDIR=$CASE_ROOT/tmp
PREFIX=$CASE_ROOT/'stable install'
MCP_BPMN_DIAGRAMS_PATH=$CASE_ROOT/'user diagrams'
CODEX_HOME=$CASE_ROOT/'codex home'
CLAUDE_CONFIG_DIR=$CASE_ROOT/'claude home'
CODEX_STATE=$FAKE_STATE_DIR/codex-registration
CLAUDE_STATE=$CLAUDE_CONFIG_DIR/.claude.json
export FAKE_STATE_DIR HOME XDG_DATA_HOME NPM_CONFIG_PREFIX npm_config_prefix TMPDIR PREFIX \
  MCP_BPMN_DIAGRAMS_PATH CODEX_HOME CLAUDE_CONFIG_DIR REAL_NODE
mkdir -p "$FAKE_STATE_DIR" "$HOME" "$MCP_BPMN_DIAGRAMS_PATH" "$SOURCE_ROOT/scripts" "$TMPDIR"
cp -f "$PROJECT_ROOT/Makefile" "$SOURCE_ROOT/Makefile"
cp -f "$PROJECT_ROOT/scripts/install-agent-integrations.sh" "$SOURCE_ROOT/scripts/install-agent-integrations.sh"
INSTALLER=$SOURCE_ROOT/scripts/install-agent-integrations.sh
printf 'keep me\n' > "$MCP_BPMN_DIAGRAMS_PATH/diagram.bpmn"
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
printf 'unrelated codex config\n' > "$CODEX_HOME/config.toml"
printf '{"unrelatedClaudeConfig":true}' > "$CLAUDE_STATE"
printf 'unrelated codex config\n' > "$CODEX_HOME/unrelated.toml"
printf 'unrelated claude config\n' > "$CLAUDE_CONFIG_DIR/settings.json"
write_fakes "$FAKE_BIN"
PATH=$FAKE_BIN:/usr/bin:/bin
export PATH

if empty_override_output=$(MCP_BPMN_DIAGRAMS_PATH= \
  make -s -C "$SOURCE_ROOT" install 2>&1); then
  fail 'installer accepted an empty MCP_BPMN_DIAGRAMS_PATH override'
fi
assert_contains "$empty_override_output" \
  'MCP_BPMN_DIAGRAMS_PATH must be a non-empty absolute path'

# A normal install owns one stable command registration without pinning all
# client sessions to one global diagrams directory.
DEFAULT_PREFIX=$CASE_ROOT/'default workspace install'
PREFIX=$DEFAULT_PREFIX
export PREFIX
unset MCP_BPMN_DIAGRAMS_PATH
: > "$FAKE_STATE_DIR/codex.log"
: > "$FAKE_STATE_DIR/claude.log"
default_install_output=$(make -s -C "$SOURCE_ROOT" install)
assert_contains "$default_install_output" 'diagram workspace resolves per client session cwd'
assert_contains "$(cat "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned")" \
  'diagrams-path-explicit=0'
assert_equals "$(sed -n '2p' "$CODEX_STATE")" ''
"$REAL_NODE" -e '
  const registration = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    .mcpServers["mcp-bpmn"];
  if (registration.env !== undefined) process.exit(1);
' "$CLAUDE_STATE" || fail 'default Claude registration unexpectedly pinned a workspace'
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" \
  "argv|<mcp>|<add>|<mcp-bpmn>|<-->|<$DEFAULT_PREFIX/app/node_modules/.bin/mcp-bpmn-server>"
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  "argv|<mcp>|<add>|<--scope>|<user>|<mcp-bpmn>|<$DEFAULT_PREFIX/app/node_modules/.bin/mcp-bpmn-server>"

# Updating legacy installer state removes only the historical default path.
sed '/^diagrams-path-explicit=/d; s|^diagrams-path=.*|diagrams-path='"$HOME"'/mcp-bpmn|' \
  "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned" \
  > "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned.legacy"
mv -f "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned.legacy" \
  "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned"
printf '%s\n%s\n' "$DEFAULT_PREFIX/app/node_modules/.bin/mcp-bpmn-server" \
  "$HOME/mcp-bpmn" > "$CODEX_STATE"
set_claude_registration "$CLAUDE_STATE" \
  "$DEFAULT_PREFIX/app/node_modules/.bin/mcp-bpmn-server" "$HOME/mcp-bpmn"
make -s -C "$SOURCE_ROOT" update >/dev/null
assert_equals "$(sed -n '2p' "$CODEX_STATE")" ''
assert_contains "$(cat "$DEFAULT_PREFIX/.mcp-bpmn-installer-owned")" \
  'diagrams-path-explicit=0'
"$REAL_NODE" -e '
  const registration = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    .mcpServers["mcp-bpmn"];
  if (registration.env !== undefined) process.exit(1);
' "$CLAUDE_STATE" || fail 'legacy default Claude workspace survived update'
make -s -C "$SOURCE_ROOT" uninstall >/dev/null
assert_absent "$DEFAULT_PREFIX"
assert_absent "$CODEX_STATE"

PREFIX=$CASE_ROOT/'stable install'
MCP_BPMN_DIAGRAMS_PATH=$CASE_ROOT/'user diagrams'
export PREFIX MCP_BPMN_DIAGRAMS_PATH

install_output=$(make -s -C "$SOURCE_ROOT" install)
assert_contains "$install_output" "registered Codex MCP command: $PREFIX/app/node_modules/.bin/mcp-bpmn-server"
assert_contains "$install_output" "registered Claude Code user MCP command: $PREFIX/app/node_modules/.bin/mcp-bpmn-server"
assert_file "$PREFIX/app/node_modules/.bin/mcp-bpmn-server"
assert_file "$CODEX_HOME/skills/bpmn-modeler/SKILL.md"
assert_file "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/SKILL.md"
[ ! -L "$CODEX_HOME/skills/bpmn-modeler" ] \
  || fail 'Codex skill was symlinked instead of copied'
[ ! -L "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler" ] \
  || fail 'Claude Code skill was symlinked instead of copied'
assert_contains "$(cat "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned")" \
  'package=mcp-bpmn-server@0.2.0'
assert_contains "$(cat "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/.mcp-bpmn-installer-owned")" \
  'package=mcp-bpmn-server@0.2.0'
[ "$(sed -n '1p' "$CODEX_STATE")" = "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" ] \
  || fail 'Codex did not receive the stable absolute executable'
[ "$(claude_registration_field "$CLAUDE_STATE" command)" = "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" ] \
  || fail 'Claude Code did not receive the stable absolute executable'
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" \
  'argv|<mcp>|<get>|<mcp-bpmn>|<--json>'
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" \
  "argv|<mcp>|<add>|<mcp-bpmn>|<--env>|<MCP_BPMN_DIAGRAMS_PATH=$MCP_BPMN_DIAGRAMS_PATH>|<-->|<$PREFIX/app/node_modules/.bin/mcp-bpmn-server>"
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  'argv|<mcp>|<get>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  "argv|<mcp>|<add>|<--scope>|<user>|<mcp-bpmn>|<$PREFIX/app/node_modules/.bin/mcp-bpmn-server>|<-e>|<MCP_BPMN_DIAGRAMS_PATH=$MCP_BPMN_DIAGRAMS_PATH>"
assert_contains "$(cat "$FAKE_STATE_DIR/npm.log")" "prefix=<$NPM_CONFIG_PREFIX>|<pack>|<--silent>|<--pack-destination>"
assert_contains "$(cat "$FAKE_STATE_DIR/npm.log")" "prefix=<$NPM_CONFIG_PREFIX>|<install>|<--omit=dev>|<--no-audit>|<--no-fund>|<--prefix>"
assert_contains "$(cat "$FAKE_STATE_DIR/npm.log")" "cache=<$TMPDIR/mcp-bpmn-install."

candidate_dir=$CASE_ROOT/'release candidates'
mkdir -p "$candidate_dir"
candidate_dir=$(CDPATH= cd -P "$candidate_dir" && pwd -P)
candidate_tarball=$candidate_dir/mcp-bpmn-server-0.2.0.tgz
: > "$candidate_tarball"
candidate_sha256=$($REAL_NODE -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
' "$candidate_tarball")
pack_count_before=$(grep -c '|<pack>|' "$FAKE_STATE_DIR/npm.log")
npm_line_count_before=$(wc -l < "$FAKE_STATE_DIR/npm.log" | tr -d ' ')
MCP_BPMN_PACKAGE_TARBALL="$candidate_tarball" \
  MCP_BPMN_PACKAGE_SHA256="$candidate_sha256" \
  make -s -C "$SOURCE_ROOT" update >/dev/null
pack_count_after=$(grep -c '|<pack>|' "$FAKE_STATE_DIR/npm.log")
assert_equals "$pack_count_after" "$pack_count_before"
npm_line_count_after=$(wc -l < "$FAKE_STATE_DIR/npm.log" | tr -d ' ')
assert_equals "$npm_line_count_after" "$((npm_line_count_before + 1))"
candidate_install_log=$(sed -n "${npm_line_count_after}p" "$FAKE_STATE_DIR/npm.log")
assert_contains "$candidate_install_log" \
  '|<install>|<--omit=dev>|<--no-audit>|<--no-fund>|<--prefix>'
candidate_cache=${candidate_install_log#cache=<}
candidate_cache=${candidate_cache%%>|*}
case "$candidate_cache" in
  "$TMPDIR"/mcp-bpmn-install.*/npm-cache) ;;
  *) fail "candidate install did not use a private staging directory: $candidate_cache" ;;
esac
candidate_staging_dir=${candidate_cache%/npm-cache}
assert_contains "$candidate_install_log" \
  "|<$candidate_staging_dir/release-candidate.tgz>"

if missing_candidate_output=$(MCP_BPMN_PACKAGE_TARBALL="$candidate_dir/missing.tgz" \
  MCP_BPMN_PACKAGE_SHA256="$candidate_sha256" \
  make -s -C "$SOURCE_ROOT" update 2>&1); then
  fail 'installer accepted a missing supplied release tarball'
fi
assert_contains "$missing_candidate_output" \
  'MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file'

candidate_symlink=$candidate_dir/candidate-link.tgz
ln -s "$candidate_tarball" "$candidate_symlink"
if symlink_candidate_output=$(MCP_BPMN_PACKAGE_TARBALL="$candidate_symlink" \
  MCP_BPMN_PACKAGE_SHA256="$candidate_sha256" \
  make -s -C "$SOURCE_ROOT" update 2>&1); then
  fail 'installer accepted a symlinked supplied release tarball'
fi
assert_contains "$symlink_candidate_output" \
  'MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file'

if digest_candidate_output=$(MCP_BPMN_PACKAGE_TARBALL="$candidate_tarball" \
  MCP_BPMN_PACKAGE_SHA256=ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff \
  make -s -C "$SOURCE_ROOT" update 2>&1); then
  fail 'installer accepted a supplied release tarball with the wrong digest'
fi
assert_contains "$digest_candidate_output" \
  'prebuilt release tarball does not match MCP_BPMN_PACKAGE_SHA256'

pack_count_before=$(grep -c '|<pack>|' "$FAKE_STATE_DIR/npm.log")
if digest_only_output=$(MCP_BPMN_PACKAGE_SHA256="$candidate_sha256" \
  make -s -C "$SOURCE_ROOT" update 2>&1); then
  fail 'installer accepted a release digest without an artifact path'
fi
pack_count_after=$(grep -c '|<pack>|' "$FAKE_STATE_DIR/npm.log")
assert_equals "$pack_count_after" "$pack_count_before"
assert_contains "$digest_only_output" \
  'MCP_BPMN_PACKAGE_SHA256 requires MCP_BPMN_PACKAGE_TARBALL'

configured_diagrams=$MCP_BPMN_DIAGRAMS_PATH
unset MCP_BPMN_DIAGRAMS_PATH
make -s -C "$SOURCE_ROOT" install >/dev/null
FAKE_PACKAGE_VERSION=0.3.0 make -s -C "$SOURCE_ROOT" update >/dev/null
assert_contains "$(cat "$PREFIX/.mcp-bpmn-installer-owned")" \
  'package=mcp-bpmn-server@0.3.0'
assert_contains "$(cat "$PREFIX/app/node_modules/mcp-bpmn-server/package.json")" \
  '"version":"0.3.0"'
persisted_doctor_output=$(make -s -C "$SOURCE_ROOT" doctor)
assert_contains "$persisted_doctor_output" "Diagrams directory: $configured_diagrams (present)"
[ "$(sed -n '2p' "$CODEX_STATE")" = "$configured_diagrams" ] \
  || fail 'update without MCP_BPMN_DIAGRAMS_PATH did not preserve the installed Codex path'
[ "$(claude_registration_field "$CLAUDE_STATE" diagrams)" = "$configured_diagrams" ] \
  || fail 'update without MCP_BPMN_DIAGRAMS_PATH did not preserve the installed Claude path'
MCP_BPMN_DIAGRAMS_PATH=$configured_diagrams
export MCP_BPMN_DIAGRAMS_PATH
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" 'argv|<mcp>|<remove>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" 'argv|<mcp>|<remove>|<--scope>|<user>|<mcp-bpmn>'

printf '/other/server\n' > "$CODEX_STATE"
if conflict_output=$("$INSTALLER" install codex 2>&1); then
  fail 'conflicting registration was replaced without explicit force'
fi
assert_contains "$conflict_output" "conflicting 'mcp-bpmn' registration"
[ "$(sed -n '1p' "$CODEX_STATE")" = /other/server ] \
  || fail 'conflicting Codex registration changed before force was provided'
make -s -C "$SOURCE_ROOT" install-codex FORCE=1 >/dev/null

set_claude_registration "$CLAUDE_STATE" /other/claude-server 'other claude diagrams'
: > "$FAKE_STATE_DIR/claude.log"
claude_conflict_before=$(cat "$CLAUDE_STATE")
if claude_conflict_output=$("$INSTALLER" install claude 2>&1); then
  fail 'conflicting Claude registration was replaced without explicit force'
fi
assert_contains "$claude_conflict_output" "conflicting 'mcp-bpmn' registration"
assert_equals "$(cat "$CLAUDE_STATE")" "$claude_conflict_before"
: > "$FAKE_STATE_DIR/claude.log"
FORCE=1 "$INSTALLER" install claude >/dev/null
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  'argv|<mcp>|<get>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  'argv|<mcp>|<remove>|<--scope>|<user>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  "argv|<mcp>|<add>|<--scope>|<user>|<mcp-bpmn>|<$PREFIX/app/node_modules/.bin/mcp-bpmn-server>|<-e>|<MCP_BPMN_DIAGRAMS_PATH=$MCP_BPMN_DIAGRAMS_PATH>"

rm -rf "$CODEX_HOME/skills/bpmn-modeler"
dangling_skill_target=$CASE_ROOT/'missing third-party Codex skill'
ln -s "$dangling_skill_target" "$CODEX_HOME/skills/bpmn-modeler"
if dangling_skill_output=$("$INSTALLER" install codex 2>&1); then
  fail 'installer replaced a dangling third-party skill symlink without force'
fi
assert_contains "$dangling_skill_output" 'already exists and is not installer-owned'
[ -L "$CODEX_HOME/skills/bpmn-modeler" ] \
  || fail 'dangling third-party skill symlink was removed during preflight'
assert_equals "$(readlink "$CODEX_HOME/skills/bpmn-modeler")" "$dangling_skill_target"
FORCE=1 "$INSTALLER" install codex >/dev/null
assert_file "$CODEX_HOME/skills/bpmn-modeler/SKILL.md"
[ ! -L "$CODEX_HOME/skills/bpmn-modeler" ] \
  || fail 'forced install did not replace dangling Codex skill symlink'

: > "$FAKE_STATE_DIR/codex.log"
: > "$FAKE_STATE_DIR/claude.log"
make -s -C "$SOURCE_ROOT" install-codex >/dev/null
[ -s "$FAKE_STATE_DIR/codex.log" ] || fail 'targeted Codex install did not invoke Codex'
[ ! -s "$FAKE_STATE_DIR/claude.log" ] || fail 'targeted Codex install invoked Claude Code'

: > "$FAKE_STATE_DIR/codex.log"
: > "$FAKE_STATE_DIR/claude.log"
make -s -C "$SOURCE_ROOT" install-claude >/dev/null
[ ! -s "$FAKE_STATE_DIR/codex.log" ] || fail 'targeted Claude install invoked Codex'
[ -s "$FAKE_STATE_DIR/claude.log" ] || fail 'targeted Claude install did not invoke Claude Code'

printf '%s\n%s\n' "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" /other/diagrams \
  > "$CODEX_STATE"
if env_conflict_output=$("$INSTALLER" install codex 2>&1); then
  fail 'installer silently replaced a registration with a different diagrams path'
fi
assert_contains "$env_conflict_output" "conflicting 'mcp-bpmn' registration"
make -s -C "$SOURCE_ROOT" install-codex FORCE=1 >/dev/null

doctor_output=$(make -s -C "$SOURCE_ROOT" doctor)
assert_contains "$doctor_output" 'Platform:'
assert_contains "$doctor_output" 'WSL detected:'
assert_contains "$doctor_output" "Installed executable: $PREFIX/app/node_modules/.bin/mcp-bpmn-server"
assert_contains "$doctor_output" 'Codex MCP registration: owned'
assert_contains "$doctor_output" 'Claude MCP registration: owned'
assert_contains "$doctor_output" 'Codex skill discovery: installed'
assert_contains "$doctor_output" 'Claude skill discovery: installed'
assert_contains "$doctor_output" "Diagrams directory: $MCP_BPMN_DIAGRAMS_PATH (present)"
assert_contains "$doctor_output" 'SVG browser readiness:'

if nested_output=$(MCP_BPMN_DIAGRAMS_PATH="$PREFIX/app/diagrams" \
  "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted diagrams inside its removable app tree'
fi
assert_contains "$nested_output" 'must be outside installer-owned'

if codex_skill_diagrams_output=$(MCP_BPMN_DIAGRAMS_PATH="$CODEX_HOME/skills/bpmn-modeler" \
  "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted diagrams at the removable Codex skill tree'
fi
assert_contains "$codex_skill_diagrams_output" 'must be outside removable Codex skill tree'

if claude_skill_diagrams_output=$(MCP_BPMN_DIAGRAMS_PATH="$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/diagrams" \
  "$INSTALLER" install claude 2>&1); then
  fail 'installer accepted diagrams beneath the removable Claude Code skill tree'
fi
assert_contains "$claude_skill_diagrams_output" 'must be outside removable Claude Code skill tree'

skill_parent_alias=$CASE_ROOT/'Codex skills alias'
ln -s "$CODEX_HOME/skills" "$skill_parent_alias"
if aliased_skill_diagrams_output=$(MCP_BPMN_DIAGRAMS_PATH="$skill_parent_alias/bpmn-modeler/diagrams" \
  "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted a symlink alias into the Codex skill tree'
fi
assert_contains "$aliased_skill_diagrams_output" 'must be outside removable Codex skill tree'

install_parent_alias=$CASE_ROOT/'install root alias'
ln -s "$PREFIX" "$install_parent_alias"
mkdir -p "$PREFIX/app/alias-purge-diagrams"
printf 'preserve unsafe purge\n' > "$PREFIX/app/alias-purge-diagrams/diagram.bpmn"
aliased_app_diagrams=$install_parent_alias/app/alias-purge-diagrams
if aliased_purge_output=$(MCP_BPMN_DIAGRAMS_PATH="$aliased_app_diagrams" \
  PURGE_DIAGRAMS="$aliased_app_diagrams" CONFIRM_PURGE="$aliased_app_diagrams" \
  "$INSTALLER" uninstall 2>&1); then
  fail 'purge accepted a symlink alias into the removable app tree'
fi
assert_contains "$aliased_purge_output" 'must be outside installer-owned'
assert_file "$PREFIX/app/alias-purge-diagrams/diagram.bpmn"
rm -rf "$PREFIX/app/alias-purge-diagrams"

rm -rf "$CODEX_HOME/skills/bpmn-modeler"
mkdir -p "$CODEX_HOME/skills/bpmn-modeler"
printf 'third-party skill\n' > "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
symlinked_marker_target=$CASE_ROOT/'third-party marker contents'
printf '%s\n' mcp-bpmn-installer > "$symlinked_marker_target"
ln -s "$symlinked_marker_target" \
  "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned"
if symlinked_marker_output=$("$INSTALLER" install codex 2>&1); then
  fail 'installer trusted a symlinked skill ownership marker without force'
fi
assert_contains "$symlinked_marker_output" 'already exists and is not installer-owned'
assert_file "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
[ -L "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned" ] \
  || fail 'symlinked skill ownership marker was changed without force'
FORCE=1 "$INSTALLER" install codex >/dev/null
assert_file "$CODEX_HOME/skills/bpmn-modeler/SKILL.md"
[ ! -L "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned" ] \
  || fail 'forced install retained a symlinked skill ownership marker'

# Simulate legacy state that predates the install-time overlap guard. Uninstall
# must preserve both a non-owned marker symlink and owned skill-contained diagrams.
rm -rf "$CODEX_HOME/skills/bpmn-modeler"
mkdir -p "$CODEX_HOME/skills/bpmn-modeler"
printf 'third-party skill\n' > "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
ln -s "$symlinked_marker_target" \
  "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned"
legacy_skill_diagrams=$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/'user diagrams'
mkdir -p "$legacy_skill_diagrams"
printf 'preserve legacy diagram\n' > "$legacy_skill_diagrams/diagram.bpmn"
MCP_BPMN_DIAGRAMS_PATH="$legacy_skill_diagrams" \
  make -s -C "$SOURCE_ROOT" uninstall >/dev/null
assert_absent "$PREFIX/app"
assert_file "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
[ -L "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned" ] \
  || fail 'uninstall removed a symlinked non-owned skill marker'
assert_file "$legacy_skill_diagrams/diagram.bpmn"
rm -rf "$CODEX_HOME/skills/bpmn-modeler" "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
assert_absent "$CODEX_HOME/skills/bpmn-modeler"
assert_absent "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
assert_file "$MCP_BPMN_DIAGRAMS_PATH/diagram.bpmn"
assert_contains "$(cat "$CODEX_HOME/unrelated.toml")" 'unrelated codex config'
assert_contains "$(cat "$CLAUDE_CONFIG_DIR/settings.json")" 'unrelated claude config'
if update_missing_output=$(make -s -C "$SOURCE_ROOT" update 2>&1); then
  fail 'update succeeded without an installer-owned installation'
fi
assert_contains "$update_missing_output" 'run make install first'

mkdir -p "$MCP_BPMN_DIAGRAMS_PATH"
printf 'purge me\n' > "$MCP_BPMN_DIAGRAMS_PATH/diagram.bpmn"
if purge_output=$(PURGE_DIAGRAMS="$MCP_BPMN_DIAGRAMS_PATH" CONFIRM_PURGE=wrong \
  "$INSTALLER" uninstall 2>&1); then
  fail 'diagram purge succeeded without exact confirmation'
fi
assert_contains "$purge_output" 'requires CONFIRM_PURGE to exactly repeat'
assert_file "$MCP_BPMN_DIAGRAMS_PATH/diagram.bpmn"
make -s -C "$SOURCE_ROOT" uninstall PURGE_DIAGRAMS="$MCP_BPMN_DIAGRAMS_PATH" \
  CONFIRM_PURGE="$MCP_BPMN_DIAGRAMS_PATH" >/dev/null
assert_absent "$MCP_BPMN_DIAGRAMS_PATH"

mv -f "$FAKE_BIN/codex" "$FAKE_BIN/codex-missing"
mv -f "$FAKE_BIN/claude" "$FAKE_BIN/claude-missing"
all_missing_output=$("$INSTALLER" install all)
assert_contains "$all_missing_output" 'Codex CLI not found; skipping Codex registration and skill'
assert_contains "$all_missing_output" 'Claude Code not found; skipping Claude registration and skill'
assert_contains "$all_missing_output" 'no supported client was found; installing the stable artifact only'
if targeted_missing_output=$(make -s -C "$SOURCE_ROOT" install-codex 2>&1); then
  fail 'targeted Codex installation succeeded without Codex'
fi
assert_contains "$targeted_missing_output" "Codex CLI was requested but 'codex' is not on PATH"
if targeted_missing_output=$(make -s -C "$SOURCE_ROOT" install-claude 2>&1); then
  fail 'targeted Claude installation succeeded without Claude Code'
fi
assert_contains "$targeted_missing_output" "Claude Code was requested but 'claude' is not on PATH"
mv -f "$FAKE_BIN/codex-missing" "$FAKE_BIN/codex"
mv -f "$FAKE_BIN/claude-missing" "$FAKE_BIN/claude"
make -s -C "$SOURCE_ROOT" install-codex >/dev/null
make -s -C "$SOURCE_ROOT" install-claude >/dev/null
[ "$(claude_registration_field "$CLAUDE_STATE" command)" = "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" ] \
  || fail 'targeted Claude Code install did not register the stable executable'

if old_node_output=$(FAKE_NODE_VERSION=22.11.9 "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted Node older than 22.12.0'
fi
assert_contains "$old_node_output" 'Node.js 22.11.9 is too old'

WSL_BIN=$CASE_ROOT/mnt/c/Program\ Files/nodejs
mkdir -p "$WSL_BIN"
cp -f "$FAKE_BIN/node" "$WSL_BIN/node"
cp -f "$FAKE_BIN/npm" "$WSL_BIN/npm"
cp -f "$FAKE_BIN/codex" "$WSL_BIN/codex"
printf '#!/bin/sh\nprintf "Linux\\n"\n' > "$WSL_BIN/uname"
chmod +x "$WSL_BIN/uname"
if wsl_output=$(WSL_DISTRO_NAME=Ubuntu PATH="$WSL_BIN:/usr/bin:/bin" \
  "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted Windows Node.js inherited by WSL'
fi
assert_contains "$wsl_output" 'WSL is using Windows Node.js'

WSL_NATIVE_BIN=$CASE_ROOT/'linux node bin'
WSL_NPM_PREFIX=$CASE_ROOT/'wsl npm rejection'
mkdir -p "$WSL_NATIVE_BIN" "$WSL_NPM_PREFIX/home" "$WSL_NPM_PREFIX/tmp" \
  "$WSL_NPM_PREFIX/diagrams"
cp -f "$FAKE_BIN/node" "$WSL_NATIVE_BIN/node"
if wsl_npm_output=$(WSL_DISTRO_NAME=Ubuntu \
  HOME="$WSL_NPM_PREFIX/home" TMPDIR="$WSL_NPM_PREFIX/tmp" \
  PREFIX="$WSL_NPM_PREFIX/install" CODEX_HOME="$WSL_NPM_PREFIX/codex" \
  CLAUDE_CONFIG_DIR="$WSL_NPM_PREFIX/claude" \
  MCP_BPMN_DIAGRAMS_PATH="$WSL_NPM_PREFIX/diagrams" \
  PATH="$WSL_NATIVE_BIN:$WSL_BIN:/usr/bin:/bin" \
  "$INSTALLER" install codex 2>&1); then
  fail 'installer accepted Windows npm with native Linux Node.js in WSL'
fi
assert_contains "$wsl_npm_output" 'WSL is using Windows npm'
assert_absent "$WSL_NPM_PREFIX/install/app"
assert_absent "$WSL_NPM_PREFIX/install/.mcp-bpmn-installer-owned"
assert_absent "$WSL_NPM_PREFIX/codex/skills/bpmn-modeler"
[ -d "$WSL_NPM_PREFIX/diagrams" ] \
  || fail 'WSL npm rejection changed the diagrams directory'

ROLLBACK_ROOT=$TEST_ROOT/'rollback with third-party state'
FAKE_BIN=$ROLLBACK_ROOT/bin
FAKE_STATE_DIR=$ROLLBACK_ROOT/state
HOME=$ROLLBACK_ROOT/home
XDG_DATA_HOME=$ROLLBACK_ROOT/'xdg data'
NPM_CONFIG_PREFIX=$ROLLBACK_ROOT/'npm prefix'
npm_config_prefix=$NPM_CONFIG_PREFIX
TMPDIR=$ROLLBACK_ROOT/tmp
PREFIX=$ROLLBACK_ROOT/'stable install'
MCP_BPMN_DIAGRAMS_PATH=$ROLLBACK_ROOT/'user diagrams'
CODEX_HOME=$ROLLBACK_ROOT/'codex home'
CLAUDE_CONFIG_DIR=$ROLLBACK_ROOT/'claude home'
CODEX_STATE=$FAKE_STATE_DIR/codex-registration
CLAUDE_STATE=$CLAUDE_CONFIG_DIR/.claude.json
export FAKE_STATE_DIR HOME XDG_DATA_HOME NPM_CONFIG_PREFIX npm_config_prefix TMPDIR PREFIX \
  MCP_BPMN_DIAGRAMS_PATH CODEX_HOME CLAUDE_CONFIG_DIR
mkdir -p "$FAKE_STATE_DIR" "$HOME" "$TMPDIR" "$MCP_BPMN_DIAGRAMS_PATH" \
  "$CODEX_HOME/skills/bpmn-modeler" "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
printf 'third-party codex\nthird-party diagrams\n' > "$CODEX_STATE"
printf 'unrelated-before-install=true\n' > "$CODEX_HOME/config.toml"
printf '{"unrelatedClaudeConfig":"before-install"}' > "$CLAUDE_STATE"
set_claude_registration "$CLAUDE_STATE" 'third-party claude' 'third-party diagrams'
printf 'third-party Codex skill\n' > "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
printf 'third-party Claude skill\n' > "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/third-party.txt"
printf 'preserve diagram\n' > "$MCP_BPMN_DIAGRAMS_PATH/preserved.bpmn"
printf 'preserve home config\n' > "$HOME/unrelated.conf"
write_fakes "$FAKE_BIN"
PATH=$FAKE_BIN:/usr/bin:/bin
export PATH

if rollback_output=$(FAKE_FAIL_CLAUDE_ADD=1 FORCE=1 \
  "$INSTALLER" install all 2>&1); then
  fail 'installer succeeded after injected Claude registration failure'
fi
assert_contains "$rollback_output" 'could not add the Claude Code user registration'
assert_absent "$PREFIX/app"
assert_absent "$PREFIX/.mcp-bpmn-installer-owned"
assert_equals "$(cat "$CODEX_STATE")" "$(printf 'third-party codex\nthird-party diagrams')"
assert_equals "$(claude_registration_field "$CLAUDE_STATE" command)" 'third-party claude'
assert_equals "$(claude_registration_field "$CLAUDE_STATE" diagrams)" 'third-party diagrams'
assert_file "$CODEX_HOME/skills/bpmn-modeler/third-party.txt"
assert_file "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/third-party.txt"
assert_absent "$CODEX_HOME/skills/bpmn-modeler/.mcp-bpmn-installer-owned"
assert_absent "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/.mcp-bpmn-installer-owned"
assert_file "$MCP_BPMN_DIAGRAMS_PATH/preserved.bpmn"
assert_file "$HOME/unrelated.conf"
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" \
  'argv|<mcp>|<remove>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/codex.log")" \
  "argv|<mcp>|<add>|<mcp-bpmn>|<--env>|<MCP_BPMN_DIAGRAMS_PATH=$MCP_BPMN_DIAGRAMS_PATH>|<-->|<$PREFIX/app/node_modules/.bin/mcp-bpmn-server>"
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  'argv|<mcp>|<remove>|<--scope>|<user>|<mcp-bpmn>'
assert_contains "$(cat "$FAKE_STATE_DIR/claude.log")" \
  "argv|<mcp>|<add>|<--scope>|<user>|<mcp-bpmn>|<$PREFIX/app/node_modules/.bin/mcp-bpmn-server>|<-e>|<MCP_BPMN_DIAGRAMS_PATH=$MCP_BPMN_DIAGRAMS_PATH>"

FORCE=1 "$INSTALLER" install all >/dev/null

printf 'disabled\n' >> "$CODEX_STATE"
if rich_codex_output=$(FORCE=1 "$INSTALLER" update codex 2>&1); then
  fail 'installer replaced a Codex registration it could not restore exactly'
fi
assert_contains "$rich_codex_output" 'codex mcp add cannot restore exactly'
assert_equals "$(sed -n '3p' "$CODEX_STATE")" disabled
sed -n '1,2p' "$CODEX_STATE" > "$CODEX_STATE.restored"
mv -f "$CODEX_STATE.restored" "$CODEX_STATE"

printf 'legacy-http\n' >> "$CODEX_STATE"
if legacy_http_output=$(FORCE=1 "$INSTALLER" update codex 2>&1); then
  fail 'installer accepted a legacy Codex HTTP registration it cannot round-trip exactly'
fi
assert_contains "$legacy_http_output" 'codex mcp add cannot restore exactly'
assert_equals "$(sed -n '3p' "$CODEX_STATE")" legacy-http
sed -n '1,2p' "$CODEX_STATE" > "$CODEX_STATE.restored"
mv -f "$CODEX_STATE.restored" "$CODEX_STATE"

codex_before_staging_race=$(cat "$CODEX_STATE")
if staging_race_output=$(FAKE_REPLACE_CODEX_DURING_NPM_INSTALL=1 \
  "$INSTALLER" update codex 2>&1); then
  fail 'installer overwrote a Codex registration replaced during artifact staging'
fi
assert_contains "$staging_race_output" "conflicting 'mcp-bpmn' registration"
assert_equals "$(sed -n '1p' "$CODEX_STATE")" /during-staging/server
printf '%s\n' "$codex_before_staging_race" > "$CODEX_STATE"

if verify_failure_output=$(FAKE_FAIL_CODEX_VERIFY_ONCE=1 \
  "$INSTALLER" update codex 2>&1); then
  fail 'installer succeeded after an injected post-add Codex verification failure'
fi
assert_contains "$verify_failure_output" 'could not verify the new Codex registration'
assert_equals "$(cat "$CODEX_STATE")" "$codex_before_staging_race"

cleanup_failure_output=$(FAKE_FAIL_TEMP_CLEANUP=1 "$INSTALLER" update codex 2>&1)
assert_contains "$cleanup_failure_output" 'could not remove temporary installer directory'
assert_absent "$PREFIX.mcp-bpmn-install.lock"

lock_signal=$ROLLBACK_ROOT/lock-holder-ready
lock_release=$ROLLBACK_ROOT/release-lock-holder
lock_output=$ROLLBACK_ROOT/lock-holder.out
FAKE_NPM_WAIT_SIGNAL=$lock_signal FAKE_NPM_WAIT_RELEASE=$lock_release \
  "$INSTALLER" update codex > "$lock_output" 2>&1 &
lock_holder_pid=$!
lock_wait_attempts=0
while [ ! -f "$lock_signal" ]; do
  lock_wait_attempts=$((lock_wait_attempts + 1))
  if [ "$lock_wait_attempts" -ge 200 ]; then
    : > "$lock_release"
    wait "$lock_holder_pid" 2>/dev/null || true
    fail 'timed out waiting for the first installer to hold the transaction lock'
  fi
  sleep 0.05
done
codex_log_before_contention=$(cat "$FAKE_STATE_DIR/codex.log")
prefix_alias=$ROLLBACK_ROOT/'stable install alias'
ln -s "$PREFIX" "$prefix_alias"
if lock_contention_output=$(PREFIX="$prefix_alias" "$INSTALLER" update codex 2>&1); then
  : > "$lock_release"
  wait "$lock_holder_pid" 2>/dev/null || true
  fail 'a concurrent installer mutated the same prefix while its lock was held'
fi
assert_contains "$lock_contention_output" 'another installer transaction is active'
assert_contains "$lock_contention_output" 'retry after it finishes'
assert_equals "$(cat "$FAKE_STATE_DIR/codex.log")" "$codex_log_before_contention"
: > "$lock_release"
wait "$lock_holder_pid" || fail 'the lock-holding installer failed after contention was released'
assert_absent "$PREFIX.mcp-bpmn-install.lock"

original_diagrams_path=$MCP_BPMN_DIAGRAMS_PATH
changed_diagrams_path=$ROLLBACK_ROOT/'changed diagrams path'
mkdir -p "$changed_diagrams_path"
if targeted_path_output=$(MCP_BPMN_DIAGRAMS_PATH="$changed_diagrams_path" FORCE=1 \
  "$INSTALLER" install codex 2>&1); then
  fail 'targeted diagrams-path change stranded the unselected installer-owned client'
fi
assert_contains "$targeted_path_output" 'would leave the installer-owned Claude Code client on stale diagrams path'
assert_contains "$targeted_path_output" 'run install all'
assert_equals "$(sed -n '2p' "$CODEX_STATE")" "$original_diagrams_path"
assert_equals "$(claude_registration_field "$CLAUDE_STATE" diagrams)" "$original_diagrams_path"

claude_skill_backup=$ROLLBACK_ROOT/'claude skill backup'
claude_cli_backup=$FAKE_BIN/claude-unavailable
mv -f "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler" "$claude_skill_backup"
mv -f "$FAKE_BIN/claude" "$claude_cli_backup"
if unavailable_other_output=$(MCP_BPMN_DIAGRAMS_PATH="$changed_diagrams_path" FORCE=1 \
  "$INSTALLER" install codex 2>&1); then
  mv -f "$claude_cli_backup" "$FAKE_BIN/claude"
  mv -f "$claude_skill_backup" "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
  fail 'targeted path change ignored the recorded unselected Claude ownership'
fi
if unavailable_all_output=$(MCP_BPMN_DIAGRAMS_PATH="$changed_diagrams_path" FORCE=1 \
  "$INSTALLER" install all 2>&1); then
  mv -f "$claude_cli_backup" "$FAKE_BIN/claude"
  mv -f "$claude_skill_backup" "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
  fail 'all-client path change skipped a recorded unavailable Claude client'
fi
mv -f "$claude_cli_backup" "$FAKE_BIN/claude"
mv -f "$claude_skill_backup" "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler"
assert_contains "$unavailable_other_output" \
  'would leave the installer-owned Claude Code client on stale diagrams path'
assert_contains "$unavailable_all_output" \
  'recorded Claude Code client is unavailable'

old_state=$(cat "$PREFIX/.mcp-bpmn-installer-owned")
old_codex_skill=$(cat "$CODEX_HOME/skills/bpmn-modeler/references/workflows.md")
old_claude_skill=$(cat "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/references/workflows.md")

if interrupted_snapshot_output=$(FAKE_PACKAGE_VERSION=0.2.1 \
  FAKE_INTERRUPT_AFTER_SNAPSHOT_MOVE=active-app \
  "$INSTALLER" update codex 2>&1); then
  fail 'installer succeeded after interruption between rollback move and marker creation'
fi
assert_contains "$interrupted_snapshot_output" 'rolled back the incomplete installation'
assert_equals "$(cat "$PREFIX/app/node_modules/mcp-bpmn-server/package.json")" \
  '{"name":"mcp-bpmn-server","version":"0.2.0"}'
assert_equals "$(cat "$PREFIX/.mcp-bpmn-installer-owned")" "$old_state"

if staged_skill_output=$(FAKE_PACKAGE_VERSION=0.2.1 FAKE_FAIL_SKILL_COPY=1 \
  "$INSTALLER" update codex 2>&1); then
  fail 'installer succeeded after injected staged skill copy failure'
fi
assert_contains "$staged_skill_output" 'rolled back the incomplete installation'
[ -z "$(find "$CODEX_HOME/skills" "$CLAUDE_CONFIG_DIR/skills" \
  -name '.mcp-bpmn-skill.*' -print)" ] \
  || fail 'failed update left an adjacent staged skill directory'
assert_equals "$(cat "$PREFIX/app/node_modules/mcp-bpmn-server/package.json")" \
  '{"name":"mcp-bpmn-server","version":"0.2.0"}'
assert_equals "$(cat "$PREFIX/.mcp-bpmn-installer-owned")" "$old_state"

printf 'unrelated-codex-setting=true\n' >> "$CODEX_HOME/config.toml"
"$REAL_NODE" -e '
  const fs = require("fs"), file = process.argv[1];
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  config.unrelatedClaudeSetting = true;
  fs.writeFileSync(file, JSON.stringify(config));
' "$CLAUDE_STATE"
old_codex_registration=$(cat "$CODEX_STATE")
old_claude_registration=$(cat "$CLAUDE_STATE")
if failed_update_output=$(FAKE_PACKAGE_VERSION=0.3.0 FAKE_FAIL_CLAUDE_ADD=1 \
  FAKE_MUTATE_CODEX_CONFIG_ON_CLAUDE_FAILURE=1 \
  "$INSTALLER" update all 2>&1); then
  fail 'installer succeeded after injected Claude failure during update'
fi
assert_contains "$failed_update_output" 'could not add the Claude Code user registration'
assert_equals "$(cat "$PREFIX/app/node_modules/mcp-bpmn-server/package.json")" \
  '{"name":"mcp-bpmn-server","version":"0.2.0"}'
assert_equals "$(cat "$PREFIX/.mcp-bpmn-installer-owned")" "$old_state"
assert_equals "$(cat "$CODEX_STATE")" "$old_codex_registration"
assert_equals "$(cat "$CLAUDE_STATE")" "$old_claude_registration"
assert_contains "$(cat "$CODEX_HOME/config.toml")" 'unrelated-during-install=true'
assert_equals "$(cat "$CODEX_HOME/skills/bpmn-modeler/references/workflows.md")" \
  "$old_codex_skill"
assert_equals "$(cat "$CLAUDE_CONFIG_DIR/skills/bpmn-modeler/references/workflows.md")" \
  "$old_claude_skill"
assert_file "$MCP_BPMN_DIAGRAMS_PATH/preserved.bpmn"
assert_file "$HOME/unrelated.conf"

if late_deletion_output=$(FAKE_PACKAGE_VERSION=0.3.0 FAKE_FAIL_CLAUDE_ADD=1 \
  FAKE_DELETE_CODEX_ON_CLAUDE_FAILURE=1 "$INSTALLER" update all 2>&1); then
  fail 'installer succeeded after the late Codex deletion failure scenario'
fi
assert_contains "$late_deletion_output" \
  "preserving deletion of Codex 'mcp-bpmn' registration"
assert_absent "$CODEX_STATE"
printf '%s\n' "$old_codex_registration" > "$CODEX_STATE"

if late_claude_replacement_output=$(FAKE_PACKAGE_VERSION=0.3.0 \
  FAKE_REPLACE_CLAUDE_AFTER_ADD=1 "$INSTALLER" update claude 2>&1); then
  fail 'installer succeeded after Claude was replaced during post-add verification'
fi
assert_contains "$late_claude_replacement_output" \
  "preserving Claude Code 'mcp-bpmn' registration changed by another process during rollback"
assert_equals "$(claude_registration_field "$CLAUDE_STATE" command)" /late/claude/server
assert_equals "$(claude_registration_field "$CLAUDE_STATE" diagrams)" /late/claude/diagrams
set_claude_registration "$CLAUDE_STATE" \
  "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" "$MCP_BPMN_DIAGRAMS_PATH"

if late_claude_deletion_output=$(FAKE_PACKAGE_VERSION=0.3.0 \
  FAKE_DELETE_CLAUDE_AFTER_ADD=1 "$INSTALLER" update claude 2>&1); then
  fail 'installer succeeded after Claude was deleted during post-add verification'
fi
assert_contains "$late_claude_deletion_output" \
  "preserving deletion of Claude Code 'mcp-bpmn' registration"
if claude_registration_field "$CLAUDE_STATE" command >/dev/null 2>&1; then
  fail 'rollback resurrected a Claude registration deleted after add'
fi
set_claude_registration "$CLAUDE_STATE" \
  "$PREFIX/app/node_modules/.bin/mcp-bpmn-server" "$MCP_BPMN_DIAGRAMS_PATH"

if late_replacement_output=$(FAKE_PACKAGE_VERSION=0.3.0 FAKE_FAIL_CLAUDE_ADD=1 \
  FAKE_REPLACE_CODEX_ON_CLAUDE_FAILURE=1 "$INSTALLER" update all 2>&1); then
  fail 'installer succeeded after the late third-party replacement failure scenario'
fi
assert_contains "$late_replacement_output" \
  "preserving Codex 'mcp-bpmn' registration changed by another process during rollback"
assert_equals "$(sed -n '1p' "$CODEX_STATE")" /late/third-party/server
assert_equals "$(sed -n '2p' "$CODEX_STATE")" /late/third-party/diagrams
assert_equals "$(cat "$PREFIX/app/node_modules/mcp-bpmn-server/package.json")" \
  '{"name":"mcp-bpmn-server","version":"0.2.0"}'
assert_equals "$(cat "$PREFIX/.mcp-bpmn-installer-owned")" "$old_state"

if unreadable_replacement_output=$(FAKE_PACKAGE_VERSION=0.3.0 FORCE=1 \
  FAKE_FAIL_CLAUDE_ADD=1 FAKE_REPLACE_CODEX_ON_CLAUDE_FAILURE=1 \
  FAKE_BREAK_CODEX_READ_ON_CLAUDE_FAILURE=1 "$INSTALLER" update all 2>&1); then
  fail 'installer succeeded after the unreadable late-replacement scenario'
fi
assert_contains "$unreadable_replacement_output" \
  "preserving Codex 'mcp-bpmn' state because it could not be read safely during rollback"
assert_contains "$unreadable_replacement_output" 'installation rollback was incomplete'
assert_equals "$(sed -n '1p' "$CODEX_STATE")" /late/third-party/server
assert_equals "$(sed -n '2p' "$CODEX_STATE")" /late/third-party/diagrams

/bin/rm -f "$FAKE_STATE_DIR/fail-all-codex-get"
printf '%s\n' "$old_codex_registration" > "$CODEX_STATE"
if unreadable_claude_output=$(FAKE_PACKAGE_VERSION=0.3.0 \
  FAKE_BREAK_CLAUDE_READ_AFTER_ADD=1 "$INSTALLER" update claude 2>&1); then
  fail 'installer succeeded after Claude state became unreadable during verification'
fi
assert_contains "$unreadable_claude_output" \
  "preserving Claude Code 'mcp-bpmn' state because it could not be read safely during rollback"
assert_contains "$unreadable_claude_output" 'installation rollback was incomplete'
assert_equals "$(cat "$CLAUDE_STATE")" '{'

printf 'ok - isolated installer lifecycle, serialized transactions, exact rollback, doctor, and uninstall\n'
