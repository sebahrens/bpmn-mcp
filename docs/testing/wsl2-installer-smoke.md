# WSL2 installer smoke

Ubuntu CI covers the Linux installer and simulates Windows tools on `PATH`, but
it cannot reproduce WSL2's real kernel detection and `/mnt/<drive>` executable
paths. Run this opt-in smoke on an Ubuntu WSL2 distribution before an installer
release. It does not require authenticated Codex or Claude accounts.

1. Copy the exact release-candidate tarball used by the macOS package and plugin
   checks into WSL2, record its SHA-256, and export its absolute Linux path:

   ```sh
   export MCP_BPMN_PACKAGE_TARBALL=/tmp/mcp-bpmn-server-0.2.0.tgz
   export MCP_BPMN_PACKAGE_SHA256='<SHA-256 copied from the macOS gate evidence>'
   test -f "$MCP_BPMN_PACKAGE_TARBALL"
   test "$(sha256sum "$MCP_BPMN_PACKAGE_TARBALL" | awk '{print $1}')" = \
     "$MCP_BPMN_PACKAGE_SHA256"
   printf '%s  %s\n' "$MCP_BPMN_PACKAGE_SHA256" "$MCP_BPMN_PACKAGE_TARBALL"
   ```

   Keep this variable set for every successful install and update below. The
   checksum must match the macOS gate evidence; do not create another tarball.

2. From WSL2, enter a clean checkout and confirm the environment is genuine
   WSL2:

   ```sh
   grep -i microsoft /proc/version
   ./scripts/install-agent-integrations.sh doctor | grep -F 'WSL detected: yes'
   ```

   `doctor` also requires a native Linux Node.js 22.12 or newer and npm. Its
   client-registration lines may report that Codex and Claude are not found.

3. Create throwaway state under the Linux temporary directory and a disposable
   executable directory on the mounted Windows filesystem:

   ```sh
   smoke_root=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-wsl-smoke.XXXXXX")
   mkdir -p /mnt/c/Temp
   test -d /mnt/c/Temp
   test -w /mnt/c/Temp
   windows_path_root=$(mktemp -d /mnt/c/Temp/mcp-bpmn-wsl-path.XXXXXX)
   mkdir -p "$smoke_root/home" "$smoke_root/xdg" "$smoke_root/npm-prefix" \
     "$smoke_root/codex" "$smoke_root/claude" "$smoke_root/diagrams"
   printf '#!/bin/sh\nexit 99\n' > "$windows_path_root/node"
   printf '#!/bin/sh\nexit 99\n' > "$windows_path_root/npm"
   chmod +x "$windows_path_root/node" "$windows_path_root/npm"
   ```

4. Run the installer with the mounted-Windows shims first on `PATH`. The command
   must fail before packing, writing active installation state, or invoking a
   client:

   ```sh
   HOME="$smoke_root/home" \
   XDG_DATA_HOME="$smoke_root/xdg" \
   npm_config_prefix="$smoke_root/npm-prefix" \
   PREFIX="$smoke_root/install" \
   CODEX_HOME="$smoke_root/codex" \
   CLAUDE_CONFIG_DIR="$smoke_root/claude" \
   MCP_BPMN_DIAGRAMS_PATH="$smoke_root/diagrams" \
   PATH="$windows_path_root:/usr/bin:/bin" \
     ./scripts/install-agent-integrations.sh install all
   ```

   Expected stderr contains `WSL is using Windows Node.js at
   /mnt/c/Temp/.../node; install a Linux Node.js and fix PATH`, and the command
   exits nonzero.

   Then keep native Linux `node` first on `PATH` while exposing only the
   mounted-Windows npm shim ahead of the system npm:

   ```sh
   native_node_root=$(mktemp -d "${TMPDIR:-/tmp}/mcp-bpmn-wsl-node.XXXXXX")
   ln -s "$(command -v node)" "$native_node_root/node"
   HOME="$smoke_root/home" \
   XDG_DATA_HOME="$smoke_root/xdg" \
   npm_config_prefix="$smoke_root/npm-prefix" \
   PREFIX="$smoke_root/install" \
   CODEX_HOME="$smoke_root/codex" \
   CLAUDE_CONFIG_DIR="$smoke_root/claude" \
   MCP_BPMN_DIAGRAMS_PATH="$smoke_root/diagrams" \
   PATH="$native_node_root:$windows_path_root:/usr/bin:/bin" \
     ./scripts/install-agent-integrations.sh install all
   ```

   Expected stderr now contains `WSL is using Windows npm at
   /mnt/c/Temp/.../npm; install Linux npm and fix PATH`, and the command exits
   nonzero.

5. Verify that rejection left no active or discovered installation and did not
   alter the diagram directory:

   ```sh
   test ! -e "$smoke_root/install/app"
   test ! -e "$smoke_root/install/.mcp-bpmn-installer-owned"
   test ! -e "$smoke_root/codex/skills/bpmn-modeler"
   test ! -e "$smoke_root/claude/skills/bpmn-modeler"
   test -d "$smoke_root/diagrams"
   ```

6. With native Linux Node.js and npm first on `PATH`, run the full lifecycle
   against the supplied candidate and require both client workflows to pass:

   ```sh
   set -eu
   for command_name in node npm codex claude; do
     command_path=$(command -v "$command_name") || {
       printf 'missing required WSL2 smoke command: %s\n' "$command_name" >&2
       exit 1
     }
     case "$command_path" in
       /mnt/*|*.exe|*.EXE)
         printf 'WSL2 smoke requires native Linux %s, found %s\n' \
           "$command_name" "$command_path" >&2
         exit 1
         ;;
     esac
   done
   native_path=$PATH
   run_smoke() {
     env PATH="$native_path" \
       HOME="$smoke_root/home" \
       XDG_DATA_HOME="$smoke_root/xdg" \
       npm_config_prefix="$smoke_root/npm-prefix" \
       PREFIX="$smoke_root/install" \
       CODEX_HOME="$smoke_root/codex" \
       CLAUDE_CONFIG_DIR="$smoke_root/claude" \
       MCP_BPMN_DIAGRAMS_PATH="$smoke_root/diagrams" \
       MCP_BPMN_PACKAGE_TARBALL="$MCP_BPMN_PACKAGE_TARBALL" \
       MCP_BPMN_PACKAGE_SHA256="$MCP_BPMN_PACKAGE_SHA256" \
       "$@"
   }
   run_smoke ./scripts/install-agent-integrations.sh install all
   doctor_output=$(run_smoke ./scripts/install-agent-integrations.sh doctor)
   printf '%s\n' "$doctor_output"
   printf '%s\n' "$doctor_output" | grep -F 'Codex MCP registration: owned'
   printf '%s\n' "$doctor_output" | grep -F 'Claude MCP registration: owned'
   run_smoke ./scripts/install-agent-integrations.sh update all
   doctor_output=$(run_smoke ./scripts/install-agent-integrations.sh doctor)
   printf '%s\n' "$doctor_output" | grep -F 'Codex MCP registration: owned'
   printf '%s\n' "$doctor_output" | grep -F 'Claude MCP registration: owned'
   run_smoke npm run test:codex-plugin
   run_smoke npm run test:claude-plugin
   run_smoke ./scripts/install-agent-integrations.sh uninstall
   test ! -e "$smoke_root/install/app"
   test -d "$smoke_root/diagrams"
   test "$(sha256sum "$MCP_BPMN_PACKAGE_TARBALL" | awk '{print $1}')" = \
     "$MCP_BPMN_PACKAGE_SHA256"
   ```

   Confirm both registrations in `doctor`; the native plugin validators must
   exercise both artifact-backed MCP adapters.

7. Remove the validated temporary roots:

   ```sh
   rm -rf "$smoke_root" "$windows_path_root" "$native_node_root"
   ```

Do not substitute real home, client-config, npm-prefix, or diagram paths in this
smoke. The cross-platform automated harness remains `npm run test:installer`.
