#!/bin/sh

set -eu

PROGRAM_NAME=mcp-bpmn
PACKAGE_NAME=mcp-bpmn-server
SKILL_NAME=bpmn-modeler
MINIMUM_NODE_VERSION=22.12.0
OWNERSHIP_MARKER=mcp-bpmn-installer

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd)

log() {
  printf '%s\n' "[mcp-bpmn] $*"
}

warn() {
  printf '%s\n' "[mcp-bpmn] warning: $*" >&2
}

fail() {
  printf '%s\n' "[mcp-bpmn] error: $*" >&2
  exit 1
}

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

default_install_root() {
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s\n' "$XDG_DATA_HOME/mcp-bpmn"
  else
    printf '%s\n' "$HOME/.local/share/mcp-bpmn"
  fi
}

INSTALL_ROOT=${PREFIX:-$(default_install_root)}
case "$INSTALL_ROOT" in
  /*) ;;
  *) INSTALL_ROOT="$PROJECT_ROOT/$INSTALL_ROOT" ;;
esac
while [ "$INSTALL_ROOT" != "/" ] && [ "${INSTALL_ROOT%/}" != "$INSTALL_ROOT" ]; do
  INSTALL_ROOT=${INSTALL_ROOT%/}
done
[ "$INSTALL_ROOT" != "/" ] || fail "PREFIX must not be the filesystem root"

APP_DIR=$INSTALL_ROOT/app
STATE_FILE=$INSTALL_ROOT/.mcp-bpmn-installer-owned
SERVER_BIN=$APP_DIR/node_modules/.bin/mcp-bpmn-server
if [ -n "${MCP_BPMN_DIAGRAMS_PATH:-}" ]; then
  DIAGRAMS_DIR=$MCP_BPMN_DIAGRAMS_PATH
elif [ ! -L "$STATE_FILE" ] && [ -f "$STATE_FILE" ] \
  && [ "$(sed -n '1p' "$STATE_FILE")" = "$OWNERSHIP_MARKER" ]; then
  DIAGRAMS_DIR=$(sed -n 's/^diagrams-path=//p' "$STATE_FILE")
  DIAGRAMS_DIR=${DIAGRAMS_DIR:-$HOME/mcp-bpmn}
else
  DIAGRAMS_DIR=$HOME/mcp-bpmn
fi
while [ "$DIAGRAMS_DIR" != "/" ] && [ "${DIAGRAMS_DIR%/}" != "$DIAGRAMS_DIR" ]; do
  DIAGRAMS_DIR=${DIAGRAMS_DIR%/}
done
CODEX_SKILL_DIR=${CODEX_HOME:-$HOME/.codex}/skills/$SKILL_NAME
CLAUDE_SKILL_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/$SKILL_NAME
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CLAUDE_USER_CONFIG_FILE=$CLAUDE_CONFIG_DIR/.claude.json
else
  CLAUDE_USER_CONFIG_FILE=$HOME/.claude.json
fi

TEMP_DIR=
ROLLBACK_DIR=
STAGED_SKILL_DIR=
TRANSACTION_ACTIVE=0
TRANSACTION_LOCK_DIR=
TRANSACTION_LOCK_HELD=0
cleanup() {
  exit_status=$?
  trap - EXIT
  if [ "$TRANSACTION_ACTIVE" -eq 1 ]; then
    if rollback_install; then
      warn "rolled back the incomplete installation"
    else
      warn "installation rollback was incomplete; inspect $INSTALL_ROOT before retrying"
    fi
  fi
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR" || warn "could not remove temporary installer directory $TEMP_DIR"
  fi
  if [ -n "$STAGED_SKILL_DIR" ] \
    && { [ -e "$STAGED_SKILL_DIR" ] || [ -L "$STAGED_SKILL_DIR" ]; }; then
    rm -rf "$STAGED_SKILL_DIR" || warn "could not remove staged skill directory $STAGED_SKILL_DIR"
  fi
  release_transaction_lock
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

usage() {
  cat <<'EOF'
Usage:
  scripts/install-agent-integrations.sh install [all|codex|claude] [--force]
  scripts/install-agent-integrations.sh update [all|codex|claude] [--force]
  scripts/install-agent-integrations.sh doctor
  scripts/install-agent-integrations.sh uninstall [--purge-diagrams PATH --confirm-purge PATH]

Environment:
  PREFIX                    Stable user-owned installation directory
  MCP_BPMN_DIAGRAMS_PATH    Diagram directory registered with the server
  MCP_BPMN_PACKAGE_TARBALL  Prebuilt release tarball to install instead of packing
  MCP_BPMN_PACKAGE_SHA256   Required SHA-256 for a prebuilt release tarball
  FORCE=1                   Replace conflicting registrations or skill copies
  PURGE_DIAGRAMS=PATH       Diagram path to remove during uninstall
  CONFIRM_PURGE=PATH        Must exactly repeat PURGE_DIAGRAMS
EOF
}

detect_platform() {
  kernel_name=$(uname -s 2>/dev/null || printf unknown)
  case "$kernel_name" in
    Darwin)
      PLATFORM=macOS
      IS_WSL=0
      ;;
    Linux)
      PLATFORM=Linux
      if [ -n "${WSL_DISTRO_NAME:-}" ] \
        || { [ -r /proc/version ] && grep -qi microsoft /proc/version; }; then
        IS_WSL=1
        PLATFORM=WSL
      else
        IS_WSL=0
      fi
      ;;
    *)
      PLATFORM=$kernel_name
      IS_WSL=0
      ;;
  esac
}

version_at_least() {
  awk -v actual="$1" -v minimum="$2" 'BEGIN {
    split(actual, a, /[.-]/)
    split(minimum, m, /[.-]/)
    for (i = 1; i <= 3; i++) {
      av = a[i] + 0
      mv = m[i] + 0
      if (av > mv) exit 0
      if (av < mv) exit 1
    }
    exit 0
  }'
}

windows_binary_in_wsl() {
  case "$1" in
    /mnt/[a-zA-Z]/*|*/mnt/[a-zA-Z]/*|*.exe|*.EXE) return 0 ;;
    *) return 1 ;;
  esac
}

check_runtime() {
  command -v node >/dev/null 2>&1 || fail "Node.js $MINIMUM_NODE_VERSION or newer is required"
  command -v npm >/dev/null 2>&1 || fail "npm is required"

  NODE_BIN=$(command -v node)
  NPM_BIN=$(command -v npm)
  if [ "$IS_WSL" -eq 1 ]; then
    windows_binary_in_wsl "$NODE_BIN" \
      && fail "WSL is using Windows Node.js at $NODE_BIN; install a Linux Node.js and fix PATH"
    windows_binary_in_wsl "$NPM_BIN" \
      && fail "WSL is using Windows npm at $NPM_BIN; install Linux npm and fix PATH"
  fi

  NODE_VERSION=$(node -p 'process.versions.node' 2>/dev/null) \
    || fail "could not read the Node.js version from $NODE_BIN"
  version_at_least "$NODE_VERSION" "$MINIMUM_NODE_VERSION" \
    || fail "Node.js $NODE_VERSION is too old; $MINIMUM_NODE_VERSION or newer is required"
}

state_is_owned() {
  [ ! -L "$STATE_FILE" ] && [ -f "$STATE_FILE" ] \
    && [ "$(sed -n '1p' "$STATE_FILE")" = "$OWNERSHIP_MARKER" ]
}

skill_is_owned() {
  [ -d "$1" ] && [ ! -L "$1" ] \
    && [ -f "$1/.mcp-bpmn-installer-owned" ] \
    && [ ! -L "$1/.mcp-bpmn-installer-owned" ] \
    && [ "$(sed -n '1p' "$1/.mcp-bpmn-installer-owned")" = "$OWNERSHIP_MARKER" ]
}

canonicalize_path() {
  CP_candidate=$1
  CP_suffix=

  while [ ! -e "$CP_candidate" ]; do
    [ ! -L "$CP_candidate" ] || return 1
    [ "$CP_candidate" != / ] || return 1
    CP_component=${CP_candidate##*/}
    CP_suffix=/$CP_component$CP_suffix
    CP_candidate=${CP_candidate%/*}
    [ -n "$CP_candidate" ] || CP_candidate=/
  done

  if [ -d "$CP_candidate" ]; then
    CP_physical=$(CDPATH= cd -P "$CP_candidate" 2>/dev/null && pwd -P) \
      || return 1
  else
    [ ! -L "$CP_candidate" ] || return 1
    CP_parent=${CP_candidate%/*}
    [ -n "$CP_parent" ] || CP_parent=/
    CP_name=${CP_candidate##*/}
    CP_physical_parent=$(CDPATH= cd -P "$CP_parent" 2>/dev/null && pwd -P) \
      || return 1
    CP_physical=${CP_physical_parent%/}/$CP_name
  fi

  printf '%s\n' "${CP_physical%/}$CP_suffix"
}

canonicalize_boundary_path() {
  if canonicalize_path "$1"; then
    return 0
  fi

  # A dangling final skill symlink is still a lexical replacement boundary.
  [ -L "$1" ] || return 1
  CBP_parent=${1%/*}
  [ -n "$CBP_parent" ] || CBP_parent=/
  CBP_name=${1##*/}
  CBP_physical_parent=$(canonicalize_path "$CBP_parent") || return 1
  printf '%s\n' "${CBP_physical_parent%/}/$CBP_name"
}

path_is_equal_or_within() {
  case "$2" in
    /) return 0 ;;
  esac
  case "$1" in
    "$2"|"$2"/*) return 0 ;;
    *) return 1 ;;
  esac
}

validate_outside_removable_paths() {
  VORP_path=$1
  VORP_label=$2
  VORP_canonical=$(canonicalize_path "$VORP_path") \
    || fail "$VORP_label could not be safely resolved: $VORP_path"

  VORP_app=$(canonicalize_boundary_path "$APP_DIR") \
    || fail "could not safely resolve installer-owned boundary $APP_DIR"
  VORP_codex=$(canonicalize_boundary_path "$CODEX_SKILL_DIR") \
    || fail "could not safely resolve Codex skill boundary $CODEX_SKILL_DIR"
  VORP_claude=$(canonicalize_boundary_path "$CLAUDE_SKILL_DIR") \
    || fail "could not safely resolve Claude Code skill boundary $CLAUDE_SKILL_DIR"

  path_is_equal_or_within "$VORP_canonical" "$VORP_app" \
    && fail "$VORP_label must be outside installer-owned $APP_DIR"
  path_is_equal_or_within "$VORP_canonical" "$VORP_codex" \
    && fail "$VORP_label must be outside removable Codex skill tree $CODEX_SKILL_DIR"
  path_is_equal_or_within "$VORP_canonical" "$VORP_claude" \
    && fail "$VORP_label must be outside removable Claude Code skill tree $CLAUDE_SKILL_DIR"
  return 0
}

diagrams_within_path() {
  DWP_diagrams=$(canonicalize_path "$DIAGRAMS_DIR") || return 2
  DWP_boundary=$(canonicalize_boundary_path "$1") || return 2
  path_is_equal_or_within "$DWP_diagrams" "$DWP_boundary"
}

codex_registration_state() {
  CODEX_REGISTRATION=missing
  CODEX_REGISTRATION_OUTPUT=
  if CODEX_REGISTRATION_OUTPUT=$(codex mcp get "$PROGRAM_NAME" --json 2>/dev/null); then
    if printf '%s' "$CODEX_REGISTRATION_OUTPUT" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const config = JSON.parse(input);
          const transport = config.transport || {};
          const environment = transport.env || {};
          process.exit(transport.type === "stdio"
            && transport.command === process.argv[1]
            && Array.isArray(transport.args)
            && transport.args.length === 0
            && environment.MCP_BPMN_DIAGRAMS_PATH === process.argv[2]
            && Object.keys(environment).length === 1 ? 0 : 1);
        } catch {
          process.exit(1);
        }
      });
    ' "$SERVER_BIN" "$DIAGRAMS_DIR"; then
      CODEX_REGISTRATION=owned
    else
      CODEX_REGISTRATION=conflict
    fi
  fi
}

claude_registration_state() {
  CLAUDE_REGISTRATION=missing
  CLAUDE_REGISTRATION_OUTPUT=
  if CLAUDE_REGISTRATION_OUTPUT=$(claude mcp get "$PROGRAM_NAME" 2>/dev/null); then
    if printf '%s\n' "$CLAUDE_REGISTRATION_OUTPUT" \
      | awk -v expected="$SERVER_BIN" -v expected_diagrams="$DIAGRAMS_DIR" '
      /^[[:space:]]*Scope:[[:space:]]*User config/ { user_scope = 1 }
      /^[[:space:]]*Command:[[:space:]]*/ {
        value = $0
        sub(/^[[:space:]]*Command:[[:space:]]*/, "", value)
        found = 1
      }
      /^[[:space:]]*MCP_BPMN_DIAGRAMS_PATH=/ {
        diagrams = $0
        sub(/^[[:space:]]*MCP_BPMN_DIAGRAMS_PATH=/, "", diagrams)
        diagrams_found = 1
      }
      END { exit !(user_scope && found && value == expected && diagrams_found && diagrams == expected_diagrams) }
    '; then
      CLAUDE_REGISTRATION=owned
    else
      CLAUDE_REGISTRATION=conflict
    fi
  fi
}

json_documents_equal() {
  node -e '
    const fs = require("fs");
    const normalize = value => {
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
      }
      return value;
    };
    try {
      const expected = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      let actual = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { actual += chunk; });
      process.stdin.on("end", () => {
        try {
          process.exit(JSON.stringify(normalize(expected)) === JSON.stringify(normalize(JSON.parse(actual))) ? 0 : 1);
        } catch { process.exit(1); }
      });
    } catch { process.exit(1); }
  ' "$1"
}

claude_user_registration_json() {
  [ -f "$CLAUDE_USER_CONFIG_FILE" ] && [ ! -L "$CLAUDE_USER_CONFIG_FILE" ] || return 1
  node -e '
    const fs = require("fs");
    try {
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const registration = config.mcpServers?.[process.argv[2]];
      if (!registration || typeof registration !== "object") process.exit(1);
      process.stdout.write(JSON.stringify(registration));
    } catch { process.exit(1); }
  ' "$CLAUDE_USER_CONFIG_FILE" "$PROGRAM_NAME"
}

acquire_transaction_lock() {
  canonical_lock_root=$(canonicalize_path "$INSTALL_ROOT") \
    || fail "could not safely resolve installer lock path for $INSTALL_ROOT"
  TRANSACTION_LOCK_DIR=$canonical_lock_root.mcp-bpmn-install.lock
  lock_parent=$(dirname "$TRANSACTION_LOCK_DIR")
  mkdir -p "$lock_parent" || fail "could not create installer lock parent $lock_parent"
  if ! mkdir "$TRANSACTION_LOCK_DIR" 2>/dev/null; then
    lock_owner=$(sed -n '1p' "$TRANSACTION_LOCK_DIR/owner" 2>/dev/null || true)
    [ -n "$lock_owner" ] || lock_owner=unknown
    fail "another installer transaction is active for $INSTALL_ROOT (owner PID: $lock_owner); retry after it finishes, or remove stale lock $TRANSACTION_LOCK_DIR after verifying no installer is running"
  fi
  TRANSACTION_LOCK_HELD=1
  printf '%s\n' "$$" > "$TRANSACTION_LOCK_DIR/owner" \
    || fail "could not record installer lock ownership in $TRANSACTION_LOCK_DIR"
}

release_transaction_lock() {
  [ "$TRANSACTION_LOCK_HELD" -eq 1 ] || return 0
  rm -f "$TRANSACTION_LOCK_DIR/owner" \
    || warn "could not remove installer lock owner file $TRANSACTION_LOCK_DIR/owner"
  rmdir "$TRANSACTION_LOCK_DIR" 2>/dev/null \
    || warn "could not remove installer transaction lock $TRANSACTION_LOCK_DIR"
  TRANSACTION_LOCK_HELD=0
}

client_requested() {
  [ "$CLIENT_SELECTION" = all ] || [ "$CLIENT_SELECTION" = "$1" ]
}

prepare_clients() {
  USE_CODEX=0
  USE_CLAUDE=0

  if client_requested codex; then
    if command -v codex >/dev/null 2>&1; then
      USE_CODEX=1
    elif [ "$CLIENT_SELECTION" = codex ]; then
      fail "Codex CLI was requested but 'codex' is not on PATH"
    else
      log "Codex CLI not found; skipping Codex registration and skill"
    fi
  fi

  if client_requested claude; then
    if command -v claude >/dev/null 2>&1; then
      USE_CLAUDE=1
    elif [ "$CLIENT_SELECTION" = claude ]; then
      fail "Claude Code was requested but 'claude' is not on PATH"
    else
      log "Claude Code not found; skipping Claude registration and skill"
    fi
  fi

  if [ "$USE_CODEX" -eq 0 ] && [ "$USE_CLAUDE" -eq 0 ]; then
    log "no supported client was found; installing the stable artifact only"
  fi
}

validate_targeted_diagrams_change() {
  state_is_owned || return 0
  installed_diagrams=$(sed -n 's/^diagrams-path=//p' "$STATE_FILE")
  [ -n "$installed_diagrams" ] || return 0
  [ "$installed_diagrams" != "$DIAGRAMS_DIR" ] || return 0
  installed_clients=$(sed -n 's/^clients=//p' "$STATE_FILE")

  if [ "$CLIENT_SELECTION" = all ]; then
    case ",$installed_clients," in
      *,codex,*)
        [ "$USE_CODEX" -eq 1 ] \
          || fail "cannot change MCP_BPMN_DIAGRAMS_PATH while the recorded Codex client is unavailable; restore the Codex CLI or keep diagrams path $installed_diagrams"
        ;;
    esac
    case ",$installed_clients," in
      *,claude,*)
        [ "$USE_CLAUDE" -eq 1 ] \
          || fail "cannot change MCP_BPMN_DIAGRAMS_PATH while the recorded Claude Code client is unavailable; restore the Claude Code CLI or keep diagrams path $installed_diagrams"
        ;;
    esac
    return 0
  fi

  case "$CLIENT_SELECTION" in
    codex)
      other_name='Claude Code'
      other_skill=$CLAUDE_SKILL_DIR
      other_owned=0
      case ",$installed_clients," in *,claude,*) other_owned=1 ;; esac
      if [ "$other_owned" -eq 0 ] && skill_is_owned "$other_skill"; then
        other_owned=1
      elif [ "$other_owned" -eq 0 ] && command -v claude >/dev/null 2>&1; then
        requested_diagrams=$DIAGRAMS_DIR
        DIAGRAMS_DIR=$installed_diagrams
        claude_registration_state
        DIAGRAMS_DIR=$requested_diagrams
        [ "$CLAUDE_REGISTRATION" != owned ] || other_owned=1
      elif [ "$other_owned" -eq 0 ] && [ -z "$installed_clients" ]; then
        other_owned=2
      fi
      ;;
    claude)
      other_name=Codex
      other_skill=$CODEX_SKILL_DIR
      other_owned=0
      case ",$installed_clients," in *,codex,*) other_owned=1 ;; esac
      if [ "$other_owned" -eq 0 ] && skill_is_owned "$other_skill"; then
        other_owned=1
      elif [ "$other_owned" -eq 0 ] && command -v codex >/dev/null 2>&1; then
        requested_diagrams=$DIAGRAMS_DIR
        DIAGRAMS_DIR=$installed_diagrams
        codex_registration_state
        DIAGRAMS_DIR=$requested_diagrams
        [ "$CODEX_REGISTRATION" != owned ] || other_owned=1
      elif [ "$other_owned" -eq 0 ] && [ -z "$installed_clients" ]; then
        other_owned=2
      fi
      ;;
  esac

  if [ "$other_owned" -eq 1 ]; then
    fail "targeted $CLIENT_SELECTION install would leave the installer-owned $other_name client on stale diagrams path $installed_diagrams; run install all to change MCP_BPMN_DIAGRAMS_PATH coherently"
  elif [ "$other_owned" -eq 2 ]; then
    fail "targeted $CLIENT_SELECTION install cannot verify whether legacy $other_name state uses diagrams path $installed_diagrams because its CLI and ownership marker are unavailable; run install all to change MCP_BPMN_DIAGRAMS_PATH coherently"
  fi
}

preflight_install() {
  validate_diagrams_path
  if [ -L "$STATE_FILE" ]; then
    fail "$STATE_FILE must not be a symbolic link"
  fi
  if [ -L "$APP_DIR" ]; then
    fail "$APP_DIR must not be a symbolic link"
  fi
  if [ -e "$APP_DIR" ] && ! state_is_owned; then
    fail "$APP_DIR exists but is not owned by this installer"
  fi
  if [ -e "$STATE_FILE" ] && ! state_is_owned; then
    fail "$STATE_FILE exists but is not a valid installer ownership marker"
  fi
  if [ "$ACTION" = update ] && ! state_is_owned; then
    fail "no installer-owned installation exists at $INSTALL_ROOT; run make install first"
  fi
  validate_targeted_diagrams_change

  if [ "$USE_CODEX" -eq 1 ]; then
    codex_registration_state
    if [ "$CODEX_REGISTRATION" = conflict ] && ! is_true "$FORCE_INSTALL"; then
      fail "Codex already has a conflicting '$PROGRAM_NAME' registration; rerun with FORCE=1 to replace it"
    fi
    if { [ -e "$CODEX_SKILL_DIR" ] || [ -L "$CODEX_SKILL_DIR" ]; } \
      && ! skill_is_owned "$CODEX_SKILL_DIR" \
      && ! is_true "$FORCE_INSTALL"; then
      fail "$CODEX_SKILL_DIR already exists and is not installer-owned; rerun with FORCE=1 to replace it"
    fi
  fi

  if [ "$USE_CLAUDE" -eq 1 ]; then
    claude_registration_state
    if [ "$CLAUDE_REGISTRATION" = conflict ] && ! is_true "$FORCE_INSTALL"; then
      fail "Claude Code already has a conflicting '$PROGRAM_NAME' registration; rerun with FORCE=1 to replace it"
    fi
    if { [ -e "$CLAUDE_SKILL_DIR" ] || [ -L "$CLAUDE_SKILL_DIR" ]; } \
      && ! skill_is_owned "$CLAUDE_SKILL_DIR" \
      && ! is_true "$FORCE_INSTALL"; then
      fail "$CLAUDE_SKILL_DIR already exists and is not installer-owned; rerun with FORCE=1 to replace it"
    fi
  fi
}

snapshot_moved_path() {
  source_path=$1
  snapshot_name=$2
  snapshot_path=$ROLLBACK_DIR/$snapshot_name
  if [ -e "$source_path" ] || [ -L "$source_path" ]; then
    : > "$ROLLBACK_DIR/$snapshot_name.present"
    if ! mv -f "$source_path" "$snapshot_path"; then
      rm -f "$ROLLBACK_DIR/$snapshot_name.present"
      fail "could not stage rollback data for $source_path"
    fi
  fi
  : > "$ROLLBACK_DIR/$snapshot_name.snapshotted"
}

restore_moved_path() {
  destination=$1
  snapshot_name=$2
  if [ -f "$ROLLBACK_DIR/$snapshot_name.present" ]; then
    if [ ! -e "$ROLLBACK_DIR/$snapshot_name" ] \
      && [ ! -L "$ROLLBACK_DIR/$snapshot_name" ]; then
      return 1
    fi
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      rm -rf "$destination" || return 1
    fi
    mkdir -p "$(dirname "$destination")" || return 1
    mv -f "$ROLLBACK_DIR/$snapshot_name" "$destination" || return 1
  elif [ -f "$ROLLBACK_DIR/$snapshot_name.snapshotted" ]; then
    if [ -e "$destination" ] || [ -L "$destination" ]; then
      rm -rf "$destination" || return 1
    fi
  fi
}

snapshot_client_registrations() {
  if [ "$USE_CODEX" -eq 1 ]; then
    codex_registration_state
    if [ "$CODEX_REGISTRATION" = conflict ] && ! is_true "$FORCE_INSTALL"; then
      fail "Codex '$PROGRAM_NAME' registration changed during artifact staging; rerun with FORCE=1 only if it should be replaced"
    fi
    printf '%s\n' "$CODEX_REGISTRATION" > "$ROLLBACK_DIR/codex-registration.state"
    if [ "$CODEX_REGISTRATION" != missing ]; then
      printf '%s' "$CODEX_REGISTRATION_OUTPUT" > "$ROLLBACK_DIR/codex-registration.json"
      json_documents_equal "$ROLLBACK_DIR/codex-registration.json" \
        < "$ROLLBACK_DIR/codex-registration.json" \
        || fail "Codex returned an invalid JSON registration for $PROGRAM_NAME"
      codex_snapshot_is_cli_restorable "$ROLLBACK_DIR/codex-registration.json" \
        || fail "Codex '$PROGRAM_NAME' registration contains settings that codex mcp add cannot restore exactly; preserve it or remove those settings before forcing replacement"
    fi
  fi

  if [ "$USE_CLAUDE" -eq 1 ]; then
    claude_registration_state
    if [ "$CLAUDE_REGISTRATION" = conflict ] && ! is_true "$FORCE_INSTALL"; then
      fail "Claude Code '$PROGRAM_NAME' registration changed during artifact staging; rerun with FORCE=1 only if it should be replaced"
    fi
    printf '%s\n' "$CLAUDE_REGISTRATION" > "$ROLLBACK_DIR/claude-registration.state"
    if [ "$CLAUDE_REGISTRATION" != missing ]; then
      claude_user_registration_json > "$ROLLBACK_DIR/claude-registration.json" \
        || fail "could not snapshot the exact Claude Code user registration for $PROGRAM_NAME"
    fi
  fi
}

codex_snapshot_is_cli_restorable() {
  node -e '
    const fs = require("fs");
    try {
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const transport = config.transport || {};
      const allowedConfigKeys = new Set([
        "name", "enabled", "disabled_reason", "transport", "enabled_tools",
        "disabled_tools", "startup_timeout_sec", "tool_timeout_sec"
      ]);
      const defaultsAreRestorable = (config.enabled === undefined || config.enabled === true)
        && (config.disabled_reason === undefined || config.disabled_reason === null)
        && (config.enabled_tools === undefined || config.enabled_tools === null)
        && (config.disabled_tools === undefined || config.disabled_tools === null)
        && (config.startup_timeout_sec === undefined || config.startup_timeout_sec === null)
        && (config.tool_timeout_sec === undefined || config.tool_timeout_sec === null)
        && Object.keys(config).every(key => allowedConfigKeys.has(key));
      const commonTransportDefaults = (transport.cwd === undefined || transport.cwd === null)
        && (transport.env_vars === undefined || (Array.isArray(transport.env_vars) && transport.env_vars.length === 0));
      const stdio = transport.type === "stdio"
        && typeof transport.command === "string"
        && Array.isArray(transport.args)
        && (!transport.env || typeof transport.env === "object")
        && commonTransportDefaults
        && Object.keys(transport).every(key => ["type", "command", "args", "env", "env_vars", "cwd"].includes(key));
      const http = transport.type === "streamable_http"
        && typeof transport.url === "string"
        && commonTransportDefaults
        && Object.keys(transport).every(key => ["type", "url", "bearer_token_env_var", "env_vars", "cwd"].includes(key));
      process.exit(defaultsAreRestorable && (stdio || http) ? 0 : 1);
    } catch { process.exit(1); }
  ' "$1"
}

codex_registration_unchanged() {
  original_state=$(cat "$ROLLBACK_DIR/codex-registration.state")
  if [ "$original_state" = missing ]; then
    codex_registration_state
    [ "$CODEX_REGISTRATION" = missing ]
    return
  fi
  current_json=$(codex mcp get "$PROGRAM_NAME" --json 2>/dev/null) || return 1
  printf '%s' "$current_json" | json_documents_equal "$ROLLBACK_DIR/codex-registration.json"
}

claude_registration_unchanged() {
  original_state=$(cat "$ROLLBACK_DIR/claude-registration.state")
  if [ "$original_state" = missing ]; then
    claude_registration_state
    [ "$CLAUDE_REGISTRATION" = missing ]
    return
  fi
  current_json=$(claude_user_registration_json) || return 1
  printf '%s' "$current_json" | json_documents_equal "$ROLLBACK_DIR/claude-registration.json"
}

restore_codex_json() {
  node -e '
    const fs = require("fs");
    const { spawnSync } = require("child_process");
    try {
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const transport = config.transport || {};
      const argv = ["mcp", "add", process.argv[2]];
      if (transport.type === "stdio" && typeof transport.command === "string" && Array.isArray(transport.args)) {
        for (const [key, value] of Object.entries(transport.env || {})) argv.push("--env", `${key}=${value}`);
        argv.push("--", transport.command, ...transport.args);
      } else if ((transport.type === "streamable_http" || transport.type === "http") && typeof transport.url === "string") {
        argv.push("--url", transport.url);
        if (transport.bearer_token_env_var) argv.push("--bearer-token-env-var", transport.bearer_token_env_var);
      } else {
        process.exit(2);
      }
      const result = spawnSync("codex", argv, { stdio: "ignore" });
      process.exit(result.status === null ? 1 : result.status);
    } catch { process.exit(1); }
  ' "$ROLLBACK_DIR/codex-registration.json" "$PROGRAM_NAME" || return 1
  restored_json=$(codex mcp get "$PROGRAM_NAME" --json 2>/dev/null) || return 1
  printf '%s' "$restored_json" | json_documents_equal "$ROLLBACK_DIR/codex-registration.json"
}

codex_registration_is_confirmed_missing() {
  missing_error=$ROLLBACK_DIR/codex-registration-missing.error
  if codex mcp get "$PROGRAM_NAME" --json >/dev/null 2> "$missing_error"; then
    return 1
  fi
  grep -F "No MCP server named" "$missing_error" >/dev/null 2>&1
}

claude_registration_is_confirmed_missing() {
  missing_error=$ROLLBACK_DIR/claude-registration-missing.error
  if claude mcp get "$PROGRAM_NAME" >/dev/null 2> "$missing_error"; then
    return 1
  fi
  grep -F "No MCP server named" "$missing_error" >/dev/null 2>&1
}

rollback_codex_registration() {
  [ -f "$ROLLBACK_DIR/codex-registration.touched" ] || return 0
  if current_json=$(codex mcp get "$PROGRAM_NAME" --json 2>/dev/null); then
    current_is_installed=0
    if [ -f "$ROLLBACK_DIR/codex-registration.installed.json" ] \
      && printf '%s' "$current_json" \
        | json_documents_equal "$ROLLBACK_DIR/codex-registration.installed.json"; then
      current_is_installed=1
    elif [ -f "$ROLLBACK_DIR/codex-registration.add-succeeded" ]; then
      codex_registration_state
      [ "$CODEX_REGISTRATION" != owned ] || current_is_installed=1
    fi
    if [ "$current_is_installed" -eq 0 ]; then
      warn "preserving Codex '$PROGRAM_NAME' registration changed by another process during rollback"
      return 0
    fi
    codex mcp remove "$PROGRAM_NAME" >/dev/null || return 1
  else
    if ! codex_registration_is_confirmed_missing; then
      warn "preserving Codex '$PROGRAM_NAME' state because it could not be read safely during rollback"
      return 1
    fi
    if [ -f "$ROLLBACK_DIR/codex-registration.add-succeeded" ]; then
      warn "preserving deletion of Codex '$PROGRAM_NAME' registration made after this transaction added it"
      return 0
    fi
  fi
  [ "$(cat "$ROLLBACK_DIR/codex-registration.state")" = missing ] \
    || restore_codex_json
}

rollback_claude_registration() {
  [ -f "$ROLLBACK_DIR/claude-registration.touched" ] || return 0
  if current_json=$(claude_user_registration_json); then
    expected_claude_registration=$ROLLBACK_DIR/claude-registration.installed.json
    [ -f "$expected_claude_registration" ] \
      || expected_claude_registration=$ROLLBACK_DIR/claude-registration.desired.json
    if [ ! -f "$expected_claude_registration" ] \
      || ! printf '%s' "$current_json" \
        | json_documents_equal "$expected_claude_registration"; then
      warn "preserving Claude Code '$PROGRAM_NAME' registration changed by another process during rollback"
      return 0
    fi
    claude mcp remove --scope user "$PROGRAM_NAME" >/dev/null || return 1
  else
    if ! claude_registration_is_confirmed_missing; then
      warn "preserving Claude Code '$PROGRAM_NAME' state because it could not be read safely during rollback"
      return 1
    fi
    if [ -f "$ROLLBACK_DIR/claude-registration.add-succeeded" ]; then
      warn "preserving deletion of Claude Code '$PROGRAM_NAME' registration made after this transaction added it"
      return 0
    fi
  fi
  if [ "$(cat "$ROLLBACK_DIR/claude-registration.state")" != missing ]; then
    claude mcp add-json --scope user "$PROGRAM_NAME" \
      "$(cat "$ROLLBACK_DIR/claude-registration.json")" >/dev/null || return 1
  fi
}

rollback_install() {
  rollback_failed=0
  TRANSACTION_ACTIVE=0

  rollback_codex_registration || rollback_failed=1
  rollback_claude_registration || rollback_failed=1
  restore_moved_path "$CODEX_SKILL_DIR" codex-skill || rollback_failed=1
  restore_moved_path "$CLAUDE_SKILL_DIR" claude-skill || rollback_failed=1
  restore_moved_path "$STATE_FILE" installer-state || rollback_failed=1
  restore_moved_path "$APP_DIR" active-app || rollback_failed=1
  rmdir "$INSTALL_ROOT" 2>/dev/null || true

  [ "$rollback_failed" -eq 0 ]
}

begin_install_transaction() {
  ROLLBACK_DIR=$TEMP_DIR/rollback
  mkdir -p "$ROLLBACK_DIR"
  snapshot_client_registrations
  TRANSACTION_ACTIVE=1
}

commit_install_transaction() {
  TRANSACTION_ACTIVE=0
}

build_and_install_artifact() {
  mkdir -p "$INSTALL_ROOT"
  TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-install.XXXXXX") \
    || fail "could not create a temporary installation directory"
  if [ -n "${MCP_BPMN_PACKAGE_TARBALL:-}" ]; then
    case "$MCP_BPMN_PACKAGE_TARBALL" in
      /*) tarball_path=$MCP_BPMN_PACKAGE_TARBALL ;;
      *) tarball_path=$PROJECT_ROOT/$MCP_BPMN_PACKAGE_TARBALL ;;
    esac
    tarball_path=$(canonicalize_path "$tarball_path") \
      || fail "MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file"
    [ -f "$tarball_path" ] \
      || fail "MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file"
    [ -n "${MCP_BPMN_PACKAGE_SHA256:-}" ] \
      || fail "MCP_BPMN_PACKAGE_SHA256 is required with MCP_BPMN_PACKAGE_TARBALL"
    cp -f "$tarball_path" "$TEMP_DIR/release-candidate.tgz" \
      || fail "could not stage the prebuilt release tarball"
    tarball_path=$TEMP_DIR/release-candidate.tgz
    node -e '
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      const actual = createHash("sha256").update(readFileSync(process.argv[1])).digest("hex");
      const expected = process.argv[2].toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) process.exit(1);
    ' "$tarball_path" "$MCP_BPMN_PACKAGE_SHA256" \
      || fail "prebuilt release tarball does not match MCP_BPMN_PACKAGE_SHA256"
  else
    (cd "$PROJECT_ROOT" && npm_config_cache="$TEMP_DIR/npm-cache" \
      npm pack --silent --pack-destination "$TEMP_DIR" >/dev/null) \
      || fail "npm pack failed"
    tarball_path=
    for packed_candidate in "$TEMP_DIR"/*.tgz; do
      [ -f "$packed_candidate" ] || continue
      [ -z "$tarball_path" ] \
        || fail "npm pack created more than one tarball"
      tarball_path=$packed_candidate
    done
    [ -n "$tarball_path" ] \
      || fail "npm pack did not create a tarball"
  fi

  mkdir -p "$TEMP_DIR/app"
  PUPPETEER_SKIP_DOWNLOAD=true npm_config_cache="$TEMP_DIR/npm-cache" \
    npm install --omit=dev --no-audit --no-fund --prefix "$TEMP_DIR/app" \
      "$tarball_path" \
    || fail "npm could not install the packed artifact"
  [ -x "$TEMP_DIR/app/node_modules/.bin/mcp-bpmn-server" ] \
    || fail "the installed artifact does not provide an executable mcp-bpmn-server"

  PACKAGE_VERSION=$(node -e '
    const metadata = require(process.argv[1]);
    process.stdout.write(String(metadata.version));
  ' "$TEMP_DIR/app/node_modules/$PACKAGE_NAME/package.json") \
    || fail "could not read the installed package version"
}

activate_staged_artifact() {
  installed_clients=$(sed -n 's/^clients=//p' "$STATE_FILE" 2>/dev/null || true)
  if [ "$USE_CODEX" -eq 1 ]; then
    case ",$installed_clients," in
      *,codex,*) ;;
      ,,) installed_clients=codex ;;
      *) installed_clients=$installed_clients,codex ;;
    esac
  fi
  if [ "$USE_CLAUDE" -eq 1 ]; then
    case ",$installed_clients," in
      *,claude,*) ;;
      ,,) installed_clients=claude ;;
      *) installed_clients=$installed_clients,claude ;;
    esac
  fi
  snapshot_moved_path "$APP_DIR" active-app
  snapshot_moved_path "$STATE_FILE" installer-state
  if ! mv -f "$TEMP_DIR/app" "$APP_DIR"; then
    fail "could not activate the installed artifact"
  fi

  {
    printf '%s\n' "$OWNERSHIP_MARKER"
    printf 'package=%s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
    printf 'installed-root=%s\n' "$INSTALL_ROOT"
    printf 'diagrams-path=%s\n' "$DIAGRAMS_DIR"
    printf 'clients=%s\n' "$installed_clients"
  } > "$STATE_FILE"
  log "installed $PACKAGE_NAME@$PACKAGE_VERSION at $APP_DIR"
}

install_skill() {
  client_name=$1
  destination=$2
  source_dir=$APP_DIR/node_modules/$PACKAGE_NAME/skills/$SKILL_NAME
  [ -f "$source_dir/SKILL.md" ] || fail "the installed artifact is missing $SKILL_NAME/SKILL.md"

  destination_parent=$(dirname "$destination")
  mkdir -p "$destination_parent"
  STAGED_SKILL_DIR=$(mktemp -d "$destination_parent/.mcp-bpmn-skill.XXXXXX") \
    || fail "could not stage the $client_name skill"
  cp -Rf "$source_dir/." "$STAGED_SKILL_DIR/"
  {
    printf '%s\n' "$OWNERSHIP_MARKER"
    printf 'package=%s@%s\n' "$PACKAGE_NAME" "$PACKAGE_VERSION"
    printf 'installed-root=%s\n' "$INSTALL_ROOT"
  } > "$STAGED_SKILL_DIR/.mcp-bpmn-installer-owned"

  case "$client_name" in
    Codex) snapshot_name=codex-skill ;;
    'Claude Code') snapshot_name=claude-skill ;;
    *) fail "unknown client while staging skill rollback: $client_name" ;;
  esac
  snapshot_moved_path "$destination" "$snapshot_name"
  mv -f "$STAGED_SKILL_DIR" "$destination"
  STAGED_SKILL_DIR=
  log "installed $client_name skill at $destination"
}

register_codex() {
  codex_registration_unchanged \
    || fail "Codex '$PROGRAM_NAME' registration changed after preflight; refusing to overwrite it"
  : > "$ROLLBACK_DIR/codex-registration.touched"
  if [ "$(cat "$ROLLBACK_DIR/codex-registration.state")" != missing ]; then
    codex mcp remove "$PROGRAM_NAME" >/dev/null \
      || fail "could not remove the existing Codex registration"
  fi
  codex mcp add "$PROGRAM_NAME" \
    --env "MCP_BPMN_DIAGRAMS_PATH=$DIAGRAMS_DIR" -- "$SERVER_BIN" >/dev/null \
    || fail "could not add the Codex registration"
  : > "$ROLLBACK_DIR/codex-registration.add-succeeded"
  codex mcp get "$PROGRAM_NAME" --json > "$ROLLBACK_DIR/codex-registration.installed.candidate.json" 2>/dev/null \
    || fail "could not verify the new Codex registration"
  codex_registration_state
  [ "$CODEX_REGISTRATION" = owned ] \
    || fail "the new Codex registration changed before it could be verified"
  mv -f "$ROLLBACK_DIR/codex-registration.installed.candidate.json" \
    "$ROLLBACK_DIR/codex-registration.installed.json"
  log "registered Codex MCP command: $SERVER_BIN"
}

register_claude() {
  claude_registration_unchanged \
    || fail "Claude Code '$PROGRAM_NAME' user registration changed after preflight; refusing to overwrite it"
  : > "$ROLLBACK_DIR/claude-registration.touched"
  node -e '
    process.stdout.write(JSON.stringify({
      type: "stdio", command: process.argv[1], args: [],
      env: { MCP_BPMN_DIAGRAMS_PATH: process.argv[2] }
    }));
  ' "$SERVER_BIN" "$DIAGRAMS_DIR" > "$ROLLBACK_DIR/claude-registration.desired.json"
  if [ "$(cat "$ROLLBACK_DIR/claude-registration.state")" != missing ]; then
    claude mcp remove --scope user "$PROGRAM_NAME" >/dev/null \
      || fail "could not remove the existing Claude Code user registration"
  fi
  claude mcp add --scope user "$PROGRAM_NAME" "$SERVER_BIN" \
    -e "MCP_BPMN_DIAGRAMS_PATH=$DIAGRAMS_DIR" >/dev/null \
    || fail "could not add the Claude Code user registration"
  : > "$ROLLBACK_DIR/claude-registration.add-succeeded"
  claude_user_registration_json > "$ROLLBACK_DIR/claude-registration.installed.candidate.json" \
    || fail "could not verify the new Claude Code user registration"
  json_documents_equal "$ROLLBACK_DIR/claude-registration.desired.json" \
    < "$ROLLBACK_DIR/claude-registration.installed.candidate.json" \
    || fail "the new Claude Code user registration changed before it could be verified"
  fresh_claude_registration=$(claude_user_registration_json) \
    || fail "could not revalidate the new Claude Code user registration"
  printf '%s' "$fresh_claude_registration" \
    | json_documents_equal "$ROLLBACK_DIR/claude-registration.desired.json" \
    || fail "the new Claude Code user registration changed during verification"
  printf '%s' "$fresh_claude_registration" \
    > "$ROLLBACK_DIR/claude-registration.installed.json"
  log "registered Claude Code user MCP command: $SERVER_BIN"
}

run_install() {
  detect_platform
  case "$PLATFORM" in
    macOS|Linux|WSL) ;;
    *) fail "unsupported operating system: $PLATFORM (supported: macOS and WSL/Linux)" ;;
  esac
  check_runtime
  prepare_clients
  acquire_transaction_lock
  preflight_install
  build_and_install_artifact
  preflight_install
  begin_install_transaction
  activate_staged_artifact

  if [ "$USE_CODEX" -eq 1 ]; then
    install_skill Codex "$CODEX_SKILL_DIR"
    register_codex
  fi
  if [ "$USE_CLAUDE" -eq 1 ]; then
    install_skill "Claude Code" "$CLAUDE_SKILL_DIR"
    register_claude
  fi

  commit_install_transaction
  log "diagrams remain in $DIAGRAMS_DIR"
}

remove_owned_skill() {
  client_name=$1
  destination=$2
  if skill_is_owned "$destination"; then
    if diagrams_within_path "$destination"; then
      warn "preserving installer-owned $client_name skill because it contains the configured diagrams path $DIAGRAMS_DIR"
    else
      diagrams_check=$?
      if [ "$diagrams_check" -eq 2 ]; then
        warn "preserving installer-owned $client_name skill because the diagrams deletion boundary could not be safely resolved"
      else
        rm -rf "$destination"
        log "removed installer-owned $client_name skill at $destination"
      fi
    fi
  elif [ -e "$destination" ] || [ -L "$destination" ]; then
    warn "preserving non-installer-owned skill at $destination"
  fi
}

validate_purge_request() {
  purge_target=${PURGE_DIAGRAMS:-}
  purge_confirmation=${CONFIRM_PURGE:-}
  if [ -z "$purge_target" ]; then
    [ -z "$purge_confirmation" ] \
      || fail "CONFIRM_PURGE requires a matching PURGE_DIAGRAMS path"
    return 0
  fi
  [ "$purge_target" = "$purge_confirmation" ] \
    || fail "diagram purge requires CONFIRM_PURGE to exactly repeat PURGE_DIAGRAMS"
  [ "$purge_target" = "$DIAGRAMS_DIR" ] \
    || fail "PURGE_DIAGRAMS must exactly match the configured diagrams path: $DIAGRAMS_DIR"
  case "$purge_target" in
    /*) ;;
    *) fail "diagram purge requires an absolute path" ;;
  esac
  case "$purge_target" in
    /|"$HOME"|"$PROJECT_ROOT"|"$INSTALL_ROOT"|*/../*|*/..|*/./*)
      fail "refusing unsafe diagram purge target: $purge_target"
      ;;
  esac

  purge_canonical=$(canonicalize_path "$purge_target") \
    || fail "diagram purge target could not be safely resolved: $purge_target"
  for protected_path in "$HOME" "$PROJECT_ROOT" "$INSTALL_ROOT"; do
    protected_canonical=$(canonicalize_boundary_path "$protected_path") \
      || fail "could not safely resolve protected purge boundary $protected_path"
    [ "$purge_canonical" != "$protected_canonical" ] \
      || fail "refusing unsafe diagram purge target: $purge_target"
  done
  validate_outside_removable_paths "$purge_target" "diagram purge target"
}

validate_diagrams_path() {
  case "$DIAGRAMS_DIR" in
    /*) ;;
    *) fail "MCP_BPMN_DIAGRAMS_PATH must be an absolute path" ;;
  esac
  case "$DIAGRAMS_DIR" in
    */../*|*/..|*/./*|*/.) fail "MCP_BPMN_DIAGRAMS_PATH must not contain dot path segments" ;;
  esac
  validate_outside_removable_paths "$DIAGRAMS_DIR" MCP_BPMN_DIAGRAMS_PATH
}

safe_purge_diagrams() {
  purge_target=${PURGE_DIAGRAMS:-}
  [ -n "$purge_target" ] || return 0
  # Re-resolve immediately before deletion in case an ancestor changed.
  validate_purge_request
  if [ -e "$purge_target" ] || [ -L "$purge_target" ]; then
    rm -rf "$purge_target"
    log "purged confirmed diagrams path $purge_target"
  else
    log "confirmed diagrams path is already absent: $purge_target"
  fi
}

run_uninstall() {
  acquire_transaction_lock
  validate_purge_request

  preserve_app_for_diagrams=0
  if diagrams_within_path "$APP_DIR"; then
    preserve_app_for_diagrams=1
    warn "preserving $APP_DIR because it contains the configured diagrams path $DIAGRAMS_DIR"
  else
    diagrams_check=$?
    if [ "$diagrams_check" -eq 2 ]; then
      preserve_app_for_diagrams=1
      warn "preserving $APP_DIR because the diagrams deletion boundary could not be safely resolved"
    fi
  fi

  installation_owned=0
  if state_is_owned; then
    installation_owned=1
  fi

  if [ "$installation_owned" -eq 1 ] \
    && command -v node >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    codex_registration_state
    if [ "$CODEX_REGISTRATION" = owned ]; then
      codex mcp remove "$PROGRAM_NAME" >/dev/null \
        || fail "could not remove the installer-owned Codex registration"
      log "removed installer-owned Codex MCP registration"
    elif [ "$CODEX_REGISTRATION" = conflict ]; then
      warn "preserving conflicting Codex '$PROGRAM_NAME' registration"
    fi
  elif [ "$installation_owned" -eq 1 ]; then
    log "Codex CLI not found; no Codex registration was changed"
  else
    log "installer ownership is not recorded; no Codex registration was changed"
  fi

  if [ "$installation_owned" -eq 1 ] && command -v claude >/dev/null 2>&1; then
    claude_registration_state
    if [ "$CLAUDE_REGISTRATION" = owned ]; then
      claude mcp remove --scope user "$PROGRAM_NAME" >/dev/null \
        || fail "could not remove the installer-owned Claude Code user registration"
      log "removed installer-owned Claude Code MCP registration"
    elif [ "$CLAUDE_REGISTRATION" = conflict ]; then
      warn "preserving conflicting Claude Code '$PROGRAM_NAME' registration"
    fi
  elif [ "$installation_owned" -eq 1 ]; then
    log "Claude Code CLI not found; no Claude Code registration was changed"
  else
    log "installer ownership is not recorded; no Claude Code registration was changed"
  fi

  remove_owned_skill Codex "$CODEX_SKILL_DIR"
  remove_owned_skill "Claude Code" "$CLAUDE_SKILL_DIR"

  if [ "$installation_owned" -eq 1 ]; then
    if [ "$preserve_app_for_diagrams" -eq 0 ] \
      && { [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; }; then
      rm -rf "$APP_DIR"
      log "removed installer-owned program files at $APP_DIR"
    fi
    if [ "$preserve_app_for_diagrams" -eq 0 ]; then
      rm -f "$STATE_FILE"
      rmdir "$INSTALL_ROOT" 2>/dev/null || true
    fi
  elif [ -e "$APP_DIR" ] || [ -e "$STATE_FILE" ]; then
    warn "preserving files at $INSTALL_ROOT because ownership could not be verified"
  fi

  if [ -z "${PURGE_DIAGRAMS:-}" ]; then
    log "preserved diagrams at $DIAGRAMS_DIR"
  else
    safe_purge_diagrams
  fi
}

report_command_version() {
  label=$1
  command_name=$2
  if command -v "$command_name" >/dev/null 2>&1; then
    command_path=$(command -v "$command_name")
    command_version=$("$command_name" --version 2>&1 | sed -n '1p') \
      || command_version='version unavailable'
    printf '%s: %s (%s)\n' "$label" "$command_version" "$command_path"
  else
    printf '%s: not found\n' "$label"
  fi
}

browser_path() {
  if [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ] && [ -x "$PUPPETEER_EXECUTABLE_PATH" ]; then
    printf '%s\n' "$PUPPETEER_EXECUTABLE_PATH"
    return 0
  fi
  for browser_name in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$browser_name" >/dev/null 2>&1; then
      command -v "$browser_name"
      return 0
    fi
  done
  for browser_candidate in \
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
    '/Applications/Chromium.app/Contents/MacOS/Chromium'; do
    if [ -x "$browser_candidate" ]; then
      printf '%s\n' "$browser_candidate"
      return 0
    fi
  done
  if [ -f "$APP_DIR/node_modules/puppeteer/package.json" ]; then
    puppeteer_path=$(node -e '
      try {
        const puppeteer = require(process.argv[1]);
        process.stdout.write(puppeteer.executablePath());
      } catch {
        process.exit(1);
      }
    ' "$APP_DIR/node_modules/puppeteer" 2>/dev/null || true)
    if [ -n "$puppeteer_path" ] && [ -x "$puppeteer_path" ]; then
      printf '%s\n' "$puppeteer_path"
      return 0
    fi
  fi
  return 1
}

run_doctor() {
  detect_platform
  printf 'Platform: %s\n' "$PLATFORM"
  printf 'WSL detected: %s\n' "$([ "$IS_WSL" -eq 1 ] && printf yes || printf no)"
  report_command_version Node node
  report_command_version npm npm
  report_command_version Codex codex
  report_command_version 'Claude Code' claude
  printf 'Install root: %s\n' "$INSTALL_ROOT"
  if state_is_owned && [ -x "$SERVER_BIN" ]; then
    printf 'Installed executable: %s\n' "$SERVER_BIN"
  else
    printf 'Installed executable: not installed\n'
  fi

  if command -v node >/dev/null 2>&1 && command -v codex >/dev/null 2>&1; then
    codex_registration_state
    printf 'Codex MCP registration: %s\n' "$CODEX_REGISTRATION"
  else
    printf 'Codex MCP registration: client not found\n'
  fi
  if command -v claude >/dev/null 2>&1; then
    claude_registration_state
    printf 'Claude MCP registration: %s\n' "$CLAUDE_REGISTRATION"
  else
    printf 'Claude MCP registration: client not found\n'
  fi

  if skill_is_owned "$CODEX_SKILL_DIR"; then
    printf 'Codex skill discovery: installed at %s\n' "$CODEX_SKILL_DIR"
  else
    printf 'Codex skill discovery: not installed at %s\n' "$CODEX_SKILL_DIR"
  fi
  if skill_is_owned "$CLAUDE_SKILL_DIR"; then
    printf 'Claude skill discovery: installed at %s\n' "$CLAUDE_SKILL_DIR"
  else
    printf 'Claude skill discovery: not installed at %s\n' "$CLAUDE_SKILL_DIR"
  fi
  printf 'Diagrams directory: %s (%s)\n' "$DIAGRAMS_DIR" \
    "$([ -d "$DIAGRAMS_DIR" ] && printf present || printf not-created)"
  if detected_browser=$(browser_path); then
    printf 'SVG browser readiness: ready (%s)\n' "$detected_browser"
  else
    printf 'SVG browser readiness: unavailable (install Chrome/Chromium or set PUPPETEER_EXECUTABLE_PATH)\n'
  fi

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    check_runtime
  else
    fail "Node.js $MINIMUM_NODE_VERSION or newer and npm are required"
  fi
}

[ "$#" -ge 1 ] || { usage >&2; exit 2; }
ACTION=$1
shift
CLIENT_SELECTION=all
FORCE_INSTALL=${FORCE:-}

case "$ACTION" in
  install|update)
    if [ "$#" -gt 0 ]; then
      case "$1" in
        all|codex|claude) CLIENT_SELECTION=$1; shift ;;
      esac
    fi
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --force) FORCE_INSTALL=1 ;;
        *) fail "unknown option for $ACTION: $1" ;;
      esac
      shift
    done
    run_install
    ;;
  doctor)
    [ "$#" -eq 0 ] || fail "doctor does not accept positional arguments"
    run_doctor
    ;;
  uninstall)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --purge-diagrams)
          [ "$#" -ge 2 ] || fail "--purge-diagrams requires a path"
          PURGE_DIAGRAMS=$2
          shift
          ;;
        --confirm-purge)
          [ "$#" -ge 2 ] || fail "--confirm-purge requires a path"
          CONFIRM_PURGE=$2
          shift
          ;;
        *) fail "unknown option for uninstall: $1" ;;
      esac
      shift
    done
    run_uninstall
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
