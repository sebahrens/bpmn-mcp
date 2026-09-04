# MCP-BPMN Implementation Guide

This guide describes the implementation that is present in this checkout. The
public usage guide is [`README.md`](README.md); this document focuses on source
ownership, contributor commands, and claims that can be checked against code or
tests.

## Runtime architecture

The server is a stateful MCP server over standard input/output:

```text
MCP client
  -> src/server/index.ts          registers and executes tools
  -> src/server/tools.ts          Zod schemas and advertised JSON Schema
  -> src/server/handlers.ts       validation, dispatch, and MCP responses
  -> src/core/SimpleBpmnEngine.ts in-memory document and transactional mutations
  -> src/core/BpmnDocument.ts     BPMN model and XML serialization
  -> src/utils/FileManager.ts     bounded, atomic file operations
```

`DiagramContext` holds one current diagram per server process. Creating or
opening a diagram replaces that context. Every diagram has an active filename —
either the one the caller passed to the creating or opening tool, or a
server-generated placeholder — and successful model mutations serialize and
atomically save it. `save_as` changes the active filename and deletes the
placeholder it replaced; `close` clears the current context.

The engine uses `BpmnDocument` as its internal representation. XML import and
serialization use `bpmn-moddle`. SVG export is rendered by `bpmn-js` through
`BpmnSvgRenderer`. Mermaid input is parsed into the project's AST, generated as
a `BpmnDocument` by `SimpleBpmnGenerator`, serialized to XML, and then laid out
through the same adapter as `auto_layout`.

`BpmnSvgRenderer.launchBrowser` resolves its Chrome command line through
`resolveBrowserLaunchArgs` in [`src/config/index.ts`](src/config/index.ts):
`MCP_BPMN_BROWSER_ARGS` replaces the arguments when it is set, and otherwise the
renderer adds `--no-sandbox --disable-setuid-sandbox` when the process runs as
uid 0, because Chrome refuses to start as root with its sandbox enabled. The
rendered page loads a local document with a `default-src 'none'` policy and makes
no network requests, so the sandbox is not the boundary that isolates it.

### Extension profile status

Portable BPMN core is the default serialization contract. The opt-in Camunda 7
profile uses `http://camunda.org/schema/1.0/bpmn` and exposes typed `assignee`,
`candidateGroups`, and `dueDate` fields on user tasks. Unknown imported
extensions remain opaque and are preserved only after warning-free parsing. See
[`docs/decisions/0001-bpmn-extension-profile.md`](docs/decisions/0001-bpmn-extension-profile.md)
for the versioned fields, compatibility guarantees, alternatives, and fixture
evidence.

## Tool contract

[`src/server/tools.ts`](src/server/tools.ts) is the single source of truth for
tool names and arguments:

- `toolDefinitions` contains strict Zod object schemas.
- `tools` converts those schemas to the JSON Schema advertised over MCP.
- `parseToolRequest` applies the same schemas at runtime, including defaults.
- `ToolArguments<Name>` derives handler argument types from those schemas.
- `BpmnRequestHandler.handleRequest` validates before dispatching.

This arrangement is checked by
[`tests/security/request-validation.test.ts`](tests/security/request-validation.test.ts),
including parity between advertised tools, validators, and dispatchers.

### Current tools and arguments

All argument objects are strict: unknown fields are rejected. `position`
requires both numeric `x` and `y`; `size` requires both numeric `width` and
`height`. Mutating tools additionally accept optimistic-concurrency arguments
(`expectedRevision` and, on connection and geometry tools, `expectedSemanticRevision`,
`expectedGeometryRevision`, `expectedBounds`, or `expectedWaypoints`).

The advertised inventory is not duplicated here. Read it from the source of
truth instead:

- `toolDefinitions` in [`src/server/tools.ts`](src/server/tools.ts) for the
  authoritative names, arguments, enums, and defaults.
- `tools/list` over MCP, or `scripts/tool-contract.json`, for the JSON Schema
  actually advertised to clients.
- The [README API reference](README.md#-api-reference) for prose and worked
  arguments, one `#### \`tool_name\`` heading per tool. `npm run test:package`
  and `tests/integration/tool-inventory.test.ts` fail if that inventory drifts
  from `tools/list`.

A hand-maintained table here previously listed 27 tools and none of their
revision arguments, while the server advertised 39 — and the count has since
moved again. That drift is exactly what the rule below warns about, which is why
no count is repeated here: read it from `tools/list` or
`scripts/tool-contract.json`.

The exact enums, nested event-definition fields, string limits, geometry
limits, and typed property schemas belong in `toolDefinitions`; do not copy
them into another hand-maintained schema.

### Valid argument examples

Create a process:

```json
{
  "name": "Order processing",
  "type": "process"
}
```

Add a user task to the current process:

```json
{
  "activityType": "userTask",
  "name": "Review order",
  "position": { "x": 250, "y": 200 },
  "properties": { "assignee": "reviewer", "candidateGroups": ["operations"] }
}
```

The example requires a current document created with
`"extensionProfile": "camunda7"`. Portable documents reject Camunda fields.

Connect using the element IDs returned by creation calls:

```json
{
  "sourceId": "UserTask_1",
  "targetId": "ServiceTask_1",
  "condition": "amount > 1000",
  "conditionLanguage": "FEEL"
}
```

Static IDs above are illustrative; callers must use IDs returned by their
running server. Activities and supported gateways may own conditional or
default sequence flows. A default flow cannot also have a condition.

## Layout

There is one layout path. Both the `auto_layout` tool and Mermaid conversion
serialize the BPMN document and call `BpmnAutoLayoutV2Adapter` in
[`src/core/layout/BpmnLayoutAdapter.ts`](src/core/layout/BpmnLayoutAdapter.ts);
`MermaidConverter` constructs the same adapter. The selected production package
is `bpmn-auto-layout@2.0.0-alpha.2`.

`src/core/layout/LayoutModel.ts` and `BpmnDocumentLayoutAdapter` remain as the
engine's typed view of placement (`getLayoutModel` / `applyLayoutModel`); they
are not a second layout algorithm. The earlier `LayoutEngine` and `AutoLayout`
prototypes were deleted because nothing imported them (`mcp-bpmn-iqa.4`).

The production adapter runs synchronous third-party layout in a subprocess so
it can enforce a timeout. `SimpleBpmnEngine` then imports the returned XML,
checks that semantic ownership and connectivity did not change, applies the
requested orientation/collaboration policy, and commits the result through the
same persistence path as other mutations.

No asymptotic complexity guarantee is made. Accepted work is bounded by the
configured element, connection, density, byte, concurrency, and timeout limits
in [`src/config/index.ts`](src/config/index.ts). Layout fixtures and behavioral
checks live under `tests/fixtures/layout/`, `tests/unit/layout/`, and the
`tests/integration/layout-*.test.ts` suites.

## Validation and file safety

Security statements in this section describe implemented boundaries, not a
blanket guarantee for all possible inputs.

### Request validation

Every MCP tool call passes through `parseToolRequest`. Top-level and nested
object schemas are strict where defined. Strings, geometry, pagination, Mermaid
input, and recursive property bags have explicit limits in
[`src/server/tools.ts`](src/server/tools.ts). The property-copy boundary rejects
non-JSON values, circular references, accessors, non-plain objects, and the
keys `__proto__`, `prototype`, and `constructor`.

General element-reference arguments are bounded strings, not globally
"sanitized IDs." Fields that become caller-supplied BPMN IDs use the narrower
`bpmnId` schema where applicable, and engine-generated IDs are checked for
uniqueness. BPMN-specific semantic and lexical checks remain the engine's
responsibility.

Reproduce the request-boundary checks with:

```bash
npx jest tests/security/request-validation.test.ts --runInBand
```

### File operations

Client-supplied file operations accept basenames rather than nested paths.
`SafeFileStore` in [`src/utils/SafeFilePath.ts`](src/utils/SafeFilePath.ts)
checks extensions, rejects absolute paths and path separators, and pins the
configured root's device/inode identity for BPMN/Mermaid reads, BPMN writes,
and deletes. Operations run relative to that anchored directory in a bounded
helper process, reject symbolic-link leaves, and never adopt a replaced root
on retry. Writes use an adjacent temporary file followed by an atomic
destination operation.

The configured root's identity is trusted at its first successful resolution;
its parent must therefore not be writable by an untrusted local principal
before the server starts using it. A process running as the same account can
still race which in-root entry occupies a basename, but swapping a leaf or the
configured path to an outside symlink does not redirect reads, writes, or
deletes outside the pinned root.

Reproduce the containment and persistence checks with:

```bash
npx jest tests/unit/utils/FileSecurity.test.ts tests/unit/utils/FileManager.test.ts tests/integration/persistence.test.ts --runInBand
```

Import byte/element/flow/DI limits and layout resource limits are configured in
`src/config/index.ts`. These controls do not justify a general claim that the
application is secure; security regression coverage is under `tests/security/`
and `tests/unit/utils/FileSecurity.test.ts`.

## Build and test workflow

The supported runtime is Node.js `>=22.12.0`, as declared in `package.json`.
From a clean checkout:

```bash
npm ci
npm run build
npm start
```

`npm run build` compiles TypeScript to `dist/`; `npm start` runs
`dist/server/index.js`. To build and run the optional CommonJS bundle:

```bash
npm run build:bundle
npm run start:bundle
```

There is no fixed bundle-size contract. Dependencies and their versions are
defined by `package.json` and the two byte-identical lockfiles,
`package-lock.json` and `npm-shrinkwrap.json` (see
[CONTRIBUTING.md](CONTRIBUTING.md#the-two-lockfiles)); the project does not claim a
"minimal dependency" set. No Dockerfile is maintained in this repository, so
deployment images must be tested separately and must honor the declared Node.js
version.

### Contributor quality gate

Use the same clean aggregate command as CI:

```bash
npm run clean
npm run check
```

`npm run check` cleans output, type-checks, lints, rebuilds, runs all Jest suites
with coverage including e2e, and runs the renderer, installer, ralph-loop,
package-smoke, and production-audit checks. It is intentionally valid when
`dist/` does not exist before the command.

Focused commands are:

```bash
npm test                  # source Jest suites except e2e, then renderer tests
npm run test:unit         # unit tests
npm run test:integration  # integration tests, then renderer tests
npm run test:e2e          # clean build, then e2e tests
npm run test:all          # clean build, every suite, then renderer/installer/ralph
npm run test:coverage     # coverage for non-e2e Jest suites, then renderer tests
npm run test:package      # clean build and package/entrypoint smoke test
npm run type-check
npm run lint
```

Two suites are opt-in because they are slow or shell-based, and `npm run
test:all` runs both:

```bash
npm run test:layout-candidates  # third-party layout comparison matrix
npm run test:ralph              # ralph-loop/tests/loop_test.sh
```

`npm run test:layout-candidates` sets `MCP_BPMN_LAYOUT_CANDIDATES=1`, which is
what un-skips the comparison describe in
`tests/integration/layout-candidates.test.ts`. Without it that file still
exercises the shipped layout path over the whole fixture corpus; only the
dev-only alternative packages are skipped.

No test-count or coverage-percentage claim is maintained here because both
change as the suite evolves. The current structure is:

```text
tests/
  contracts/       engine contract checks
  e2e/             built MCP server protocol tests
  fixtures/        BPMN, Mermaid, dialect, layout, and lint inputs
  helpers/         shared test helpers and helper tests
  integration/     cross-component behavior
  mocks/           Jest/runtime mocks
  security/        adversarial boundary and resource tests
  unit/            component tests grouped by source area
```

## Configuration

There is no fixed home-directory store. `WorkspaceSession.fromLaunch()` in
[`src/config/WorkspaceSession.ts`](src/config/WorkspaceSession.ts) resolves the
diagram workspace once at startup, in this order:

1. `MCP_BPMN_DIAGRAMS_PATH`, if set. It must be an absolute path with no `.` or
   `..` segment; the directory is created if missing (mode `0700`). Source:
   `environment`.
2. A `.mcp-bpmn.json` file in the launch cwd containing exactly
   `{ "path": "relative/path" }`. The path must be a relative descendant with no
   dot segment and no symlinked component. Source: `repository_config`.
3. Otherwise the canonical (realpath-resolved) launch cwd — the directory the
   MCP client started the stdio child in. Source: `launch_cwd`.

```bash
MCP_BPMN_DIAGRAMS_PATH=/var/bpmn/diagrams npm start
```

Startup also fixes an immutable containment boundary for the session.
`select_workspace` may move the session to a strict descendant of that boundary
(source `selection`) and nothing may escape it; `get_workspace` reports the
launch cwd, the boundary, the active workspace, and the resolution source, so
read the boundary from there rather than assuming a directory. Resolving a
workspace never changes `process.cwd()`, so package imports stay anchored to the
installed executable.

`src/config/index.ts` defines the remaining environment variables and their
defaults. The complete set is:

- `MCP_BPMN_MAX_IMPORT_BYTES`
- `MCP_BPMN_MAX_IMPORT_ELEMENTS`
- `MCP_BPMN_MAX_IMPORT_FLOWS`
- `MCP_BPMN_MAX_IMPORT_DI_ELEMENTS`
- `MCP_BPMN_MAX_MERMAID_BYTES`
- `MCP_BPMN_MAX_ARTIFACT_BYTES`
- `MCP_BPMN_MAX_LAYOUT_ELEMENTS`
- `MCP_BPMN_MAX_LAYOUT_CONNECTIONS`
- `MCP_BPMN_MAX_LAYOUT_DENSITY`
- `MCP_BPMN_MAX_LAYOUT_BYTES`
- `MCP_BPMN_MAX_CONCURRENT_LAYOUTS`
- `MCP_BPMN_MAX_LISTING_ITEMS`
- `MCP_BPMN_MAX_LISTING_METADATA_BYTES`
- `MCP_BPMN_LAYOUT_TIMEOUT_MS`
- `MCP_BPMN_SHUTDOWN_TIMEOUT_MS`
- `MCP_BPMN_BROWSER_ARGS` (described under runtime architecture above)

Invalid, non-positive overrides fall back to source defaults. Consult the
configuration module instead of duplicating numeric defaults in deployment
documentation. The [README](README.md#-file-storage) carries the same list with
each variable's effect and default.

The stdio executable handles SIGINT, SIGTERM, and stdin EOF through one
idempotent shutdown coordinator. It stops accepting tool calls, drains accepted
handler work and persistence, releases browser/layout subprocesses, and closes
the transport. The graceful-drain deadline is 15 seconds; a timeout forces a
nonzero exit.

## Further references

- [`README.md`](README.md) — tool usage and MCP client configuration
- [`docs/architecture/engine-contract.md`](docs/architecture/engine-contract.md)
  — engine ownership, import/export, and mutation contract
- [`docs/decisions/0001-bpmn-extension-profile.md`](docs/decisions/0001-bpmn-extension-profile.md)
  — selected extension profile and explicitly pending behavior
- [BPMN 2.0 specification](https://www.omg.org/spec/BPMN/2.0/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
