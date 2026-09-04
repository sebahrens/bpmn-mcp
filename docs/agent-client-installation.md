# Agent client installation and operation

This guide covers a source-checkout installation for Codex CLI, Claude Code,
and generic stdio MCP clients. The supported installer environments are macOS,
native Linux, and WSL2. Native Windows is not currently an installer target.

## Prerequisites

- Node.js 22.12.0 or newer and npm
- POSIX `sh` and `make` (the macOS system make or GNU Make)
- Codex CLI and/or Claude Code installed, authenticated, and available on
  `PATH` for their corresponding integration
- A user-writable source checkout and install location; the installer never
  invokes `sudo`, Homebrew, `apt`, or a client installer
- Chrome or Chromium only when SVG export or managed SVG/PNG artifacts are needed

On WSL, keep the checkout under the Linux home filesystem, for example
`$HOME/src/mcp-bpmn`. Run Linux-native `node`, `npm`, `codex`, and `claude`
from that shell. Do not use Windows executables inherited through `/mnt/c` or
paths ending in `.exe`; filesystem and stdio behavior differs across that
boundary.

## Choose the integration shape

| Shape | What is installed | When to use it |
|---|---|---|
| Generic MCP only | One stdio server registration or executable | Any MCP client; server initialization instructions are available, but Agent Skill discovery is client-specific |
| Make-based Codex/Claude install | Stable private server, user MCP registration, and a copied standalone `bpmn-modeler` skill | Recommended for a source checkout today |
| Client plugin | Server metadata and the same canonical skill in a client-native package | Development and later public distribution; the project does not currently claim a published marketplace entry |

A standalone skill does not install or start the MCP server. Conversely, a
generic MCP registration does not make a client discover a standalone skill.
The Make installer sets up both pieces for each detected supported client.

## Install from a source checkout

On macOS or Linux, clone into a user-owned directory and run:

```sh
git clone https://github.com/sebahrens/bpmn-mcp.git
cd mcp-bpmn
npm ci
make install
make doctor
```

On WSL2, first enter a Linux-filesystem checkout and verify the resolved tools:

```sh
cd "$HOME/src/mcp-bpmn"
pwd -P
command -v node npm make codex claude
node -p 'process.platform + " " + process.versions.node'
npm ci
make install
make doctor
```

`pwd -P` and every resolved executable should be a Linux path, not `/mnt/c/...`
or an `.exe`; Node must report `linux` and version 22.12.0 or newer. If only one
agent client is installed, the default target skips the absent client and still
installs the stable server. A targeted install fails if its requested client is
absent:

```sh
make install-codex
make install-claude
```

The default install root is `${XDG_DATA_HOME:-$HOME/.local/share}/mcp-bpmn`.
The user MCP registration contains only the stable executable: every stdio
session normally inherits its repository cwd and uses that canonical directory
as its managed workspace. The install root and an optional fallback workspace
may be set with absolute user-owned paths:

```sh
make install \
  PREFIX="$HOME/.local/share/mcp-bpmn-work" \
  MCP_BPMN_DIAGRAMS_PATH="$HOME/Documents/BPMN diagrams"
```

Keep `MCP_BPMN_DIAGRAMS_PATH` outside the install root and client skill
directories. When updating or uninstalling a custom install, pass the same
`PREFIX`. An update remembers an explicitly installed workspace override when
the environment variable is omitted. Updating a legacy default `$HOME/mcp-bpmn`
registration removes that fixed path so repository cwd inheritance can work:

```sh
make update PREFIX="$HOME/.local/share/mcp-bpmn-work"
make doctor PREFIX="$HOME/.local/share/mcp-bpmn-work"
```

The installer packs the checkout and installs a stable executable beneath the
prefix. MCP registrations and copied skills therefore keep working if the
source checkout is moved or deleted.

To keep diagrams below a repository-specific subdirectory, add this regular,
non-symlinked file at the repository root:

```json
{
  "path": "wiki/processes/assets"
}
```

The path must be relative and may contain only descendant components; dot
segments and symlink traversal fail closed. `get_workspace` reports the
canonical launch cwd, immutable startup boundary, selected workspace, and
resolution source. `select_workspace` can narrow one live session to another
relative descendant. Neither mechanism changes Node's cwd or dependency
resolution.

## Verify Codex

The supported read-only registration checks are:

```sh
codex mcp list
codex mcp get mcp-bpmn --json
```

The `mcp-bpmn` entry should be enabled, use stdio, have an absolute `command`,
and have no arguments. Its environment is empty by default; an explicitly
requested installation override adds only `MCP_BPMN_DIAGRAMS_PATH`.
Start a new Codex session after installation. Invoke the standalone skill by
starting the request with `$bpmn-modeler`, or make a natural-language BPMN
authoring request that matches its description.

## Verify Claude Code

The equivalent user-scoped registration checks are:

```sh
claude mcp list
claude mcp get mcp-bpmn
```

The entry should report `Scope: User config` and the stable absolute executable.
It reports `MCP_BPMN_DIAGRAMS_PATH` only when an override was explicitly
installed. Start a new Claude Code session after
installation and invoke `/bpmn-modeler`, or make a matching natural-language
request. A future installed plugin uses the namespaced selector
`/mcp-bpmn:bpmn-modeler`; that selector is not the Make-installed standalone
skill.

## First safe BPMN workflow

Use a new client session so no diagram is current, then invoke the appropriate
skill selector with this request:

> Create a new portable process named Installation Smoke with a start event, a
> service task named Check installation, and an end event. Connect them in
> order, validate the process, apply auto-layout, validate again at full level,
> and export XML. Do not rename or delete any existing diagram.

Accept only the expected diagram mutations. The result should report an active
`.bpmn` filename, successful validation, and XML output. Creation and every
successful mutation autosave the current diagram; a separate `save` call is not
needed. `export` is read-only and returns XML text or an embedded SVG resource,
not another saved diagram file.

One server instance has one current diagram. Creating or opening a different
diagram replaces that current context, although prior successful mutations are
already saved. Before switching context, use `current` and confirm the intended
file. Require an exact filename and explicit intent for `save_as` and
`delete_diagram_file`; deleting an element may also delete incident connections,
and `auto_layout` replaces manual geometry.

## SVG/PNG or XML-only operation

XML authoring, validation, layout, persistence, and XML export do not require a
browser. SVG export and `save_svg`/`save_png` use Puppeteer and `bpmn-js`. The
normal dependency install downloads a compatible browser. If that download is
disabled, provide an installed Chrome or Chromium executable. Launch Codex or
Claude Code from the same environment so the server inherits the variable:

```sh
export PUPPETEER_EXECUTABLE_PATH="$HOME/Applications/chrome-linux/chrome"
make doctor
```

When requested, the installer records only `MCP_BPMN_DIAGRAMS_PATH` in client
registrations; it does not persist `PUPPETEER_EXECUTABLE_PATH`. Doctor confirms the browser is
visible in its current shell, not that a separately launched GUI or shell will
inherit it. Prefer a standard browser location, explicitly provide the variable
where the client is launched, or use XML-only operation.

If doctor reports `SVG browser readiness: unavailable`, use XML export until a
compatible browser is installed; the rest of the server remains usable.

## Update and uninstall

Update only an installer-owned installation:

```sh
make update
make doctor
```

Uninstall only installer-owned registrations, skill copies, and program files:

```sh
make uninstall
```

**Uninstall preserves the configured diagram directory by default.** Diagram
deletion is a separate destructive operation and requires the same absolute
path twice:

```sh
make uninstall \
  PURGE_DIAGRAMS="$HOME/mcp-bpmn" \
  CONFIRM_PURGE="$HOME/mcp-bpmn"
```

Inspect that path before running the purge form. A mismatch is rejected.

## Command verification ownership

Every command in this guide has one of these verification owners:

| Commands | Verification |
|---|---|
| `git clone`, `cd`, and `npm ci` checkout preparation | Explicit macOS/WSL release-host preparation before the automated smokes; CI also runs `npm ci` from the lockfile |
| `pwd -P`, `command -v`, `node -p`, and `PUPPETEER_EXECUTABLE_PATH` environment probes | Explicit WSL/authenticated release smoke; browser discovery and Node/runtime rejection are also automated by `npm run test:installer` |
| `make install`, targeted installs, custom paths, `update`, `doctor`, `uninstall`, confirmed purge | Automated by `npm run test:installer` with isolated homes, exact client argv assertions, paths containing spaces, lifecycle, preservation, and failure cases |
| `FORCE=1` replacement and `codex mcp remove` / `claude mcp remove --scope user` recovery | Automated by `npm run test:installer`, including exact Claude user-scope option ordering and preservation of unrelated config |
| Source build/start, packed artifact commands, and generic stdio startup | Automated by `npm run test:package`; the full source suite uses `npm run test:all` |
| Codex/Claude plugin development lifecycles | Isolated by `npm run test:codex-plugin` and `npm run test:claude-plugin`; these do not modify real client homes |
| Skill workflow order and selectors | Deterministic coverage in `npm run test:evaluations` |
| Authenticated `npm run eval:codex` and `npm run eval:claude` cases | Explicit opt-in model smoke; these commands consume model quota and are intentionally excluded from CI |
| WSL path/tool checks | Explicit release smoke in [the WSL2 installer checklist](testing/wsl2-installer-smoke.md) |
| Real `codex mcp list/get`, `claude mcp list/get`, client startup, selector invocation, and first workflow | Explicit authenticated manual smoke below; client authentication is intentionally not required by CI |

For the authenticated manual smoke, perform the checkout and environment probes
above on the release host, execute the registration checks in a temporary client
profile or test account, start a fresh session in each installed client, invoke
its standalone selector with the Installation Smoke request, and confirm the
resulting `.bpmn` file is under the doctor-reported diagram path. Then run
`make uninstall` and confirm that file remains. Record client versions, doctor
output, and the two resulting filenames as release evidence.

For failures, continue with
[installation troubleshooting](agent-client-troubleshooting.md).
