# Agent client installation troubleshooting

Use supported installer and client commands for diagnosis and recovery. Do not
hand-edit `~/.codex/config.toml`, `~/.claude.json`, or unrelated client config.
The installer checks ownership before changing files and rolls back incomplete
transactions.

## Establish the actual state

Run diagnostics with the same `PREFIX` used at installation, if customized:

```sh
make doctor
make doctor PREFIX="$HOME/.local/share/mcp-bpmn-work"
codex mcp list
codex mcp get mcp-bpmn --json
claude mcp list
claude mcp get mcp-bpmn
```

An owned installation reports the stable executable, `owned` registrations,
installed skill discovery, the diagram directory, and SVG readiness. A missing
client is expected when that integration is not installed. A `conflict` means
the same name points to a different command, arguments, scope, or diagram path;
the installer does not silently replace it.

## WSL resolves Windows tools

The checkout and all runtime/client tools must be on the Linux side:

```sh
pwd -P
command -v node npm codex claude
node -p 'process.platform + " " + process.versions.node'
```

Move a checkout under `$HOME` if `pwd` starts with `/mnt/c`. Install Linux
Node.js/npm and Linux client CLIs inside WSL, then fix `PATH` until no result is
under `/mnt/c` or ends in `.exe`. The installer rejects Windows Node/npm and
Node older than 22.12.0; do not bypass that check.

## Stale or conflicting registrations

First inspect both the client result and `make doctor`. If the registration and
same-named skill belong to another installation you still need, leave them
unchanged and choose which integration should own the `mcp-bpmn` name.

If the exact same-named registration and skill are stale and may be replaced,
use the installer's explicit transactional replacement:

```sh
make install-codex FORCE=1
make install-claude FORCE=1
make doctor
```

`FORCE=1` is intentionally narrow but destructive: it can replace the existing
`mcp-bpmn` registration and `bpmn-modeler` skill directory for the selected
client. It does not rewrite other MCP entries or unrelated client settings.
Inspect those exact named items first.

To remove only a known stale registration before reinstalling, use the client
CLI rather than editing configuration:

```sh
codex mcp remove mcp-bpmn
claude mcp remove --scope user mcp-bpmn
make install
```

The Claude option ordering above is required: `--scope user` belongs before the
server name. Only remove entries you have positively identified as stale.

## Make install and a development plugin collide

Make-based installation provides a user registration and standalone skill.
Client plugins bundle their own MCP endpoint and namespaced skill. Public
marketplace entries are not yet claimed, so plugin commands in this repository
are development/release tests only.

Do not keep two different `mcp-bpmn` endpoints enabled. Before switching, use
the list/get commands above. Remove the obsolete endpoint with its owning client
CLI or plugin manager, then restart the client. Diagram files remain outside
plugin caches and installer-owned program directories.

## Update cannot find or safely change the install

`make update` requires the same install root and installer ownership marker. For
a custom root, repeat it:

```sh
make update PREFIX="$HOME/.local/share/mcp-bpmn-work"
```

If a targeted install tries to change `MCP_BPMN_DIAGRAMS_PATH` while another
installed client would retain the old value, the installer rejects the split
state. Make both clients available and update them coherently:

```sh
make install \
  MCP_BPMN_DIAGRAMS_PATH="$HOME/Documents/BPMN diagrams"
```

Do not move diagram files until both registrations report the intended path.
Without an explicit override, launch a fresh client session from the intended
repository and call `get_workspace`. If a client reports a different launch
cwd, set an absolute `MCP_BPMN_DIAGRAMS_PATH` during installation as a fallback;
the server never guesses another directory or silently writes outside the
reported workspace.

## Installer transaction is reported active

Wait for the other install/update/uninstall process to finish. If the process
was interrupted, verify that the owner PID printed by the error is no longer
running before removing only the exact stale lock path printed by the installer.
Never remove a lock while an installer process is active. Rerun `make doctor`
and the intended lifecycle command afterward.

## SVG browser unavailable

The server can operate fully in XML-only mode. For SVG, install Chrome or
Chromium or point Puppeteer at a compatible executable before starting the
client:

```sh
export PUPPETEER_EXECUTABLE_PATH="$HOME/Applications/chrome-linux/chrome"
make doctor
```

Start the agent client from that same environment. The installer does not add
`PUPPETEER_EXECUTABLE_PATH` to MCP registrations, so doctor seeing the browser
does not make a separately launched client inherit the variable. Prefer a
standard discoverable browser location or stay with XML export when client
environment inheritance cannot be guaranteed.

On macOS, doctor also checks the standard Google Chrome and Chromium application
paths. On Linux/WSL it checks common Chrome/Chromium commands and Puppeteer's
managed download. Do not configure a Windows browser executable from WSL.

## SVG render fails with a Chrome sandbox error

If the browser is installed but the launch diagnostic ends in `Running as root
without --no-sandbox is not supported` or another sandbox failure, Chrome is
present and the sandbox is what cannot start. The server already launches Chrome
with `--no-sandbox --disable-setuid-sandbox` when it runs as uid 0, so this
remains only where the sandbox is blocked for a non-root user — commonly hosts
that restrict unprivileged user namespaces, such as Ubuntu 24.04 runners and
hardened containers. Set the launch arguments explicitly for the client session:

```sh
export MCP_BPMN_BROWSER_ARGS="--no-sandbox --disable-setuid-sandbox"
make doctor
```

`MCP_BPMN_BROWSER_ARGS` is a space-separated list that replaces the default
arguments entirely; an empty string launches Chrome with none. Like
`PUPPETEER_EXECUTABLE_PATH`, the installer does not add it to MCP registrations,
so export it in the environment the agent client is started from.

## Uninstall did not remove an item

This is normally a safety decision. Uninstall preserves conflicting
registrations, non-installer-owned skill directories, unverified program files,
and the configured diagram directory. Inspect the warning and ownership before
taking further action. The default recovery remains:

```sh
make uninstall
```

It preserves diagrams. Use the separately confirmed purge form in the
[installation guide](agent-client-installation.md#update-and-uninstall) only
when deletion of that exact directory is intended.

The lifecycle, force-replacement, CLI removal ordering, custom-prefix, WSL,
browser diagnostic, and preservation commands in this guide are covered by the
automated installer test and the explicit WSL/authenticated smoke procedures
listed in the installation guide's
[command verification ownership](agent-client-installation.md#command-verification-ownership).
