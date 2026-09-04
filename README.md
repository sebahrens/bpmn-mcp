# MCP-BPMN Server

A Model Context Protocol (MCP) server for a tested BPMN 2.0 authoring subset,
including Mermaid conversion, local persistence, layout, validation, and XML or
SVG export.

## 🎯 Overview

MCP-BPMN provides a stateful interface for AI assistants to work with one
business process diagram at a time. It authors well-formed BPMN 2.0 XML for the
constructs listed below; it is not a complete BPMN 2.0 editor, execution engine,
or deployment client. Portable BPMN core is the default authoring contract,
with an opt-in typed Camunda 7 profile documented in
[ADR 0001](docs/decisions/0001-bpmn-extension-profile.md).

### Key Features

- **Focused BPMN authoring**: Supported events, activities, gateways, data
  objects, annotations, pools, top-level lanes, sequence flows, and associations
- **Mermaid conversion**: Bootstrap diagrams from the documented flowchart subset
- **Horizontal auto-layout**: Deterministic process and collaboration placement
- **Local persistence**: Atomically save and reopen diagrams in a configured directory
- **XML/SVG export and rendered artifacts**: XML is generated in-process; SVG
  export and managed SVG/PNG artifacts are rendered through Puppeteer and
  `bpmn-js`
- **Portable and Camunda 7 profiles**: Vendor-free output by default, with three
  typed Camunda 7 user-task fields when explicitly selected

## 🚀 Quick Start

### Requirements

- Node.js 22.12.0 or newer
- npm with lockfile support; `make` is additionally required for the
  Codex/Claude installer
- macOS, Linux, or WSL2 with Linux-native Node.js, npm, and agent clients
- Chrome or Chromium for `export({ format: "svg" })`, `save_svg`, and
  `save_png`; the normal Puppeteer install downloads a compatible browser

XML authoring, validation, layout, persistence, and XML export do not launch a
browser. SVG export and managed SVG/PNG artifact rendering do. Rendering is
headless, limited to one concurrent render per server instance, and has a
twenty-second timeout.

### Browser download

`npm ci` in this checkout runs Puppeteer's install step, which downloads Chrome
for Testing and the headless shell into a shared, machine-wide cache at
`~/.cache/puppeteer`. That download needs network access and about **650 MB** of
disk (measured on Linux with `puppeteer@25.8.0`: 391 MB for `chrome`, 261 MB for
`chrome-headless-shell`). The cache is shared across projects, so a machine that
already has it pays nothing extra.

To skip it, install with `PUPPETEER_SKIP_DOWNLOAD=1`. Everything except SVG/PNG
rendering then works unchanged; those three calls fail until you point the
server at an existing browser:

```bash
export PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome"
```

`make install` never downloads a browser: the installer runs its private
`npm install` with `PUPPETEER_SKIP_DOWNLOAD=true`, so the installed server
renders only if this checkout's `npm ci` already filled the shared cache, a
system Chrome/Chromium is on `PATH`, or `PUPPETEER_EXECUTABLE_PATH` is set.
`make doctor` reports which of those applies as `SVG browser readiness`.

Chrome refuses to start as root, and container, devcontainer, CI, and cloud
sandbox images commonly run the server as uid 0. The server therefore launches
Chrome with `--no-sandbox --disable-setuid-sandbox` when `process.getuid()` is
`0`. Set `MCP_BPMN_BROWSER_ARGS` to a space-separated argument list to replace
that default anywhere else the sandbox cannot start — for example on hosts that
restrict unprivileged user namespaces — or to an empty string to launch Chrome
with no extra arguments at all.

### Install for Codex and Claude Code

```bash
git clone https://github.com/sebahrens/bpmn-mcp.git
cd mcp-bpmn
npm ci
make install
make doctor
```

`make install` builds a private release, registers every supported client found
on `PATH`, and copies the `bpmn-modeler` skill into each detected client. Start
a new client session, then ask it to create a small BPMN process and export XML.
Each stdio session uses its canonical launch directory as the managed workspace
by default, so the same registration follows Codex or Claude Code across
repositories.

See [agent client installation and operation](docs/agent-client-installation.md)
for targeted installs, custom paths, updates, verification, the first safe BPMN
workflow, and generic MCP-only setup. See
[installation troubleshooting](docs/agent-client-troubleshooting.md) for WSL,
browser, registration-conflict, and recovery guidance.

`make uninstall` removes installer-owned program files, registrations, and skill
copies but **preserves diagrams by default**.

### Generic stdio setup

Clients other than Codex and Claude Code can launch the source checkout directly:

```bash
npm run build
npm start
```

`npm run build` emits the canonical ESM executable at
`dist/server/index.js`. For a generic MCP client, configure `command` as the
absolute result of `command -v node` and `args` as the absolute checkout path to
`dist/server/index.js`. The server uses stdio, so it normally appears idle when
started in a terminal.

To use the stable executable created by `make install` instead, obtain its
absolute path from `make doctor` and configure it as `command` with an empty
`args` array. Generic MCP clients receive the server's built-in workflow
instructions but do not automatically discover the optional Agent Skill.

### Install a packed release artifact

This repository currently documents an npm tarball install rather than assuming
that `bpmn-mcp` is available from the public npm registry. A release
producer can build the canonical CLI-only artifact from a source checkout:

```bash
artifact_dir=$(mktemp -d)
npm pack --pack-destination "$artifact_dir"
```

Install that tarball into a dedicated consumer directory and run its packaged
executable:

```bash
consumer_dir=$(mktemp -d)
npm install --prefix "$consumer_dir" "$artifact_dir"/bpmn-mcp-*.tgz
"$consumer_dir/node_modules/.bin/bpmn-mcp"
```

For an MCP client, use the absolute value of
`$consumer_dir/node_modules/.bin/bpmn-mcp` as `command` and an empty
`args` array. The package is a CLI, not an importable JavaScript library.

### Agent plugins and evaluations

The checkout contains Codex and Claude Code plugin metadata for development and
release validation. Public marketplace installation is a later distribution
path; no public marketplace entry is claimed here. Do not combine a development
plugin with a same-named user MCP registration without first following the
[conflict checks](docs/agent-client-troubleshooting.md#stale-or-conflicting-registrations).

The deterministic cross-client workflow evaluation is safe for development and
CI:

```bash
npm run test:evaluations
```

Authenticated model runs are opt-in. Build first, then select one bounded case
while iterating:

```bash
npm run build
npm run eval:codex -- --case direct-process-svg
npm run eval:claude -- --case direct-process-svg
```

The Codex adapter runs `codex exec` in a temporary project containing the
canonical skill and a project-scoped stdio MCP configuration. The Claude
adapter materializes the same cases as native `claude plugin eval` cases in a
temporary plugin copy. Both set `MCP_BPMN_DIAGRAMS_PATH` to a temporary
directory, copy only declared setup fixtures there, and remove the directory
afterward; they never read, overwrite, or delete diagrams from the user's real
store. Omit `--case` to run the complete corpus. These commands can consume
model quota and are intentionally excluded from `npm run check` and CI.

### Optional CommonJS bundle

The CommonJS bundle is a separate source-checkout build and is not produced by
`npm run build` or included in the canonical npm tarball:

```bash
npm run build:bundle
npm run start:bundle
```

## 📚 API Reference

### Stateful Context Management

MCP-BPMN uses a stateful API design where you work with one diagram at a time. All operations apply to the current diagram context, eliminating the need for processId parameters.

### Advertised tool matrix

The headings in this API reference enumerate every tool returned by
`tools/list`. The executable parity baseline is
`tests/contracts/engine-contract.test.ts`, with focused behavior in the unit,
integration, and end-to-end suites.

Each advertised tool also includes the standard MCP `readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint` annotations. These
annotations describe observable server behavior: authoring calls auto-save,
replacement and deletion calls may destroy existing state, and all operations
stay within the configured local diagram store. MCP annotations are advisory
hints, not an authorization boundary; clients must still apply their own trust
and approval policies.

| Area | Advertised tools | Tested scope and boundary |
| --- | --- | --- |
| Context creation/import | `new_bpmn`, `new_from_mermaid`, `open_bpmn`, `open_mermaid_file` | Process or collaboration roots; documented Mermaid subset; imports must fit the server's canonical model |
| Context lifecycle | `save`, `save_as`, `close`, `current` | One active diagram and filename; local atomic persistence |
| Authoring | `add_event`, `add_activity`, `add_gateway`, `add_data_object`, `add_text_annotation`, `add_pool`, `add_lane` | The explicit schema enums and typed properties below, not arbitrary BPMN elements or extension attributes |
| Relationships | `connect`, `add_association` | `connect` authors a sequence flow within one process, or a message flow across participants of a collaboration; associations are artifact relationships |
| Query/mutation | `list_elements`, `get_element`, `list_connections`, `get_connection`, `update_element`, `update_connection`, `update_element_geometry`, `update_connection_geometry`, `apply_geometry_patch`, `route_connection`, `delete_element` | Paginated queries, typed semantic updates, guarded BPMNShape/BPMNEdge geometry updates, and proposal-first local rerouting |
| Bulk authoring | `build_process` | Many nodes and the flows between them in one atomic call, using caller-chosen `ref` names; the same per-element validation applies |
| Export/quality | `export`, `save_svg`, `save_png`, `validate`, `analyze_geometry`, `auto_layout` | XML or browser-backed SVG export; managed SVG/PNG artifact persistence; structural and geometry diagnostics; left-to-right or top-to-bottom layout |
| Workspace and stored files | `get_workspace`, `select_workspace`, `list_diagrams`, `delete_diagram_file`, `get_diagrams_path` | Per-session repository discovery and sandboxed access inside the selected workspace; rendered artifacts remain separate from managed BPMN listings; `get_diagrams_path` is a compatibility alias |

### Creation Tools

#### `new_bpmn`
Create a new BPMN process or collaboration diagram and set it as the current context.

```javascript
{
  name: "Order Processing",
  filename: "order-processing.bpmn", // optional; see Diagram filenames
  type: "process" // or "collaboration" (optional, defaults to "process")
}
```

Omitting `filename` is safe: the server generates a placeholder name for
autosave and `save_as` removes it when you pick a real one. See
[Diagram filenames](#diagram-filenames).

#### `new_from_mermaid`
Create a new BPMN diagram from Mermaid code and set it as the current context.

```javascript
{
  name: "My Process",
  filename: "my-process.bpmn", // optional; see Diagram filenames
  mermaidCode: "graph TD\n  A[Start] --> B[Task] --> C[End]"
}
```

Mermaid conversion intentionally supports a focused flowchart subset:

| Mermaid construct | BPMN mapping |
| --- | --- |
| `[Task]` | Task (the exact labels `Start`/`Begin` and `End`/`Stop`/`Finish` become events) |
| `((Event))` | Start/end event when topology identifies one; otherwise intermediate throw event |
| `{Decision}` | Exclusive gateway |
| `[/Subprocess/]` | Subprocess |
| `[[Data]]` | Standalone data object reference linked to a backing data object |
| `-->|Label|` | Sequence/message-flow display name; labels are not condition expressions |
| `subgraph id[Name]` | Participant with its own process; cross-subgraph edges become message flows |

When any subgraph is present, every node must belong to exactly one top-level
subgraph. Nested subgraphs and sequence-flow connections to data nodes are
rejected before BPMN export. Styling, click handlers, CSS classes, and dotted
edge appearance are not represented in BPMN; accepted lossy syntax returns a
conversion warning. Text labels and subgraph names are XML-escaped and
round-trip through BPMN unchanged.

#### `preview_mermaid`
Dry-run the same conversion and report what each node and edge became, without
creating a diagram, writing a file, or replacing the current context. Use it to
check an ambiguous node before committing to `new_from_mermaid`.

```javascript
{
  mermaidCode: "flowchart TD\n  A((Start)) --> B[Review] --> C{Approved?}"
}
```

The result lists every node as `{ mermaidId, elementId, type, name, ownerId }`,
every edge as `{ connectionId, type, sourceId, targetId, label }` with its
sequence- or message-flow classification, the pools each subgraph produced, and
the conversion warnings. Layout is skipped: the preview answers what each node
became, not where it will sit.

Mermaid has no form for parallel or inclusive gateways, user or service tasks,
or message and timer events. Import first, then create or adjust those with
`add_gateway`, `add_activity`, and `add_event`.

### File Operations

#### `open_bpmn`
Open an existing BPMN file and set it as the current context.

```javascript
{
  filename: "my-process.bpmn"
}
```

#### `open_mermaid_file`
Open and convert a Mermaid file to BPMN, setting it as the current context.

```javascript
{
  filename: "my-flowchart.mmd",
  bpmnFilename: "my-flowchart.bpmn" // optional; names the converted diagram
}
```

#### `save`
Atomically save the current diagram to its active file. New and opened diagrams
already have an active filename, and successful mutations autosave to that same
file.

```javascript
{}
```

#### `save_as`
Atomically save the current diagram with a new filename and make that filename
active. Later mutations update only the new file.

If the previous filename was a server-generated placeholder, it is deleted so
the diagram does not exist twice; the result reports `previousFilename` and
`removedPreviousFile`. A filename you chose yourself is kept as an unchanged
snapshot. See [Diagram filenames](#diagram-filenames).

```javascript
{
  filename: "my-process.bpmn"
}
```

#### `close`
Close the current diagram and clear the context.

```javascript
{}
```

#### `current`
Get information about the current diagram.

```javascript
{}
```

### Element Manipulation Tools

#### `add_event`
Add events (start, end, intermediate, boundary) to the current diagram.

```javascript
{
  eventType: "start", // start, end, intermediate-throw, intermediate-catch, boundary
  name: "Order Received",
  eventDefinition: "message", // optional; only BPMN-legal event kind/definition pairs are accepted
  eventDefinitionPayload: {
    reference: { name: "Order received" } // root ID is generated when omitted
  },
  position: { x: 100, y: 200 } // optional
}
```

Timer definitions require `timer: { type: "timeDate" | "timeDuration" |
"timeCycle", expression, language? }`; conditional definitions require
`condition: { expression, language? }`. Error and escalation references may
also include `code`. Compensation throws may include `activityRef` and
`waitForCompletion`; compensation boundary events are non-interrupting.

#### `add_activity`
Add activities (tasks, subprocesses) to the current diagram.

```javascript
{
  activityType: "userTask", // task, userTask, serviceTask, scriptTask, etc.
  name: "Review Order",
  position: { x: 250, y: 200 }, // optional
  properties: { // optional; Camunda 7 profile only on userTask
    assignee: "reviewer",
    candidateGroups: ["operations", "approvers"],
    dueDate: "${dueDate}"
  }
}
```

New BPMN and Mermaid-authored documents accept `extensionProfile: "portable" |
"camunda7"`; the default is `portable`. Portable mode rejects the three vendor
fields and emits no vendor namespace. Camunda updates accept `null` for any of
them to remove the corresponding XML attribute. Candidate group entries cannot
contain commas. Imported BPMN detects actual Camunda namespace use and preserves
other warning-free extensions opaquely.

Call activities serialize as `bpmn:callActivity`. Their optional
`properties.calledElement` is a lexical BPMN QName identifying the callable
element; it is not required to match a process ID in the current diagram.

Activities may use standard BPMN multi-instance loop characteristics. Set
`isSequential` to `false` for parallel instances or `true` for sequential
instances:

```javascript
{
  activityType: "serviceTask",
  name: "Process Batch",
  properties: {
    multiInstance: {
      isSequential: false,
      loopCardinality: {
        body: "requestedInstanceCount",
        language: "urn:example:expression-language"
      },
      completionCondition: {
        body: "completedInstanceCount >= requiredInstanceCount",
        language: "urn:example:expression-language"
      },
      loopDataInputRef: "DataObjectReference_Input",  // optional ItemAwareElement ID
      loopDataOutputRef: "DataObjectReference_Output" // optional ItemAwareElement ID
    }
  }
}
```

The server preserves expression bodies exactly and serializes them as BPMN
`FormalExpression` values. It does not parse or evaluate them, so choose a
language/profile supported by the BPMN engine that will execute the exported
diagram. The loop data references must identify existing BPMN
`ItemAwareElement` instances; the portable schema does not emit a
vendor-specific `collection` attribute.
Vendor-specific binding or version attributes are not emitted by the portable
BPMN dialect.

```javascript
{
  activityType: "callActivity",
  name: "Invoke fulfillment",
  properties: { calledElement: "FulfillmentProcess" }
}
```

#### `add_gateway`
Add gateways for branching logic to the current diagram.

```javascript
{
  gatewayType: "exclusive", // exclusive, parallel, inclusive, eventBased, complex
  name: "Payment Check",
  position: { x: 400, y: 200 } // optional
}
```

#### `add_data_object`
Add a visible `bpmn:dataObjectReference` and its linked, non-rendered
`bpmn:dataObject`. Collection state belongs to the backing object. An optional
`itemSubjectRef` must identify an existing `bpmn:itemDefinition`, such as one
loaded from an imported diagram.

```javascript
{
  name: "Order records",
  position: { x: 400, y: 320 }, // optional reference position
  isCollection: true, // optional, defaults to false
  itemSubjectRef: "ItemDefinition_Order" // optional existing definition ID
}
```

Data input/output associations are activity-owned BPMN constructs and are not
created by `add_association`, which remains the generic artifact association.

#### `add_text_annotation`
Add a BPMN text annotation. Text is preserved exactly, including line breaks
and XML metacharacters. `textFormat` defaults to BPMN's `text/plain`; position
and size default to the engine's annotation geometry. Supplying
`associatedElementId` also creates a separate, undirected BPMN association from
the annotation to that element.

```javascript
{
  text: "Review the exception path\nbefore approval",
  textFormat: "text/markdown", // optional
  position: { x: 400, y: 320 }, // optional
  size: { width: 220, height: 80 }, // optional
  associatedElementId: "UserTask_1" // optional
}
```

#### `connect`
Connect two elements in the current diagram. Endpoints in the same process and
scope get a sequence flow; endpoints belonging to different participants of a
collaboration, black-box pools included, get a message flow. The connection type
follows from the endpoints, so there is no type argument.

```javascript
{
  sourceId: "ExclusiveGateway_1",
  targetId: "UserTask_1",
  label: "Start Flow", // optional
  condition: "amount > 1000", // optional, for conditional sequence flows
  conditionLanguage: "FEEL", // optional
  conditionType: "bpmn:FormalExpression", // optional
  isDefault: false // optional; default flows cannot have conditions
}
```

Conditions and defaults are supported for activities and exclusive, inclusive,
or complex gateways. A default flow cannot also have a condition, and neither
applies to a message flow. The result reports the `connectionType` that was
created, so a caller can confirm which kind it got.

#### `add_association`
Add a BPMN association artifact between two BaseElements in a compatible
process or collaboration scope. This is distinct from sequence and message
flows. `associationDirection` defaults to BPMN's `None` value.

```javascript
{
  sourceId: "TextAnnotation_1",
  targetId: "UserTask_1",
  associationDirection: "One" // None, One, or Both
}
```

#### `add_pool`
Add a pool (participant) to a collaboration diagram.

```javascript
{
  name: "Customer",
  position: { x: 100, y: 100 }, // optional
  size: { width: 600, height: 250 }, // optional
  blackBox: false // optional; true creates a participant without an owned process
}
```

#### `add_lane`
Add a lane to a white-box pool and assign direct process flow nodes to it. Nodes
already assigned to another lane are moved to the new lane.

```javascript
{
  poolId: "Participant_1",
  name: "Sales Department",
  flowNodeIds: ["StartEvent_1", "UserTask_1"],
  position: "bottom" // optional
}
```

### Query and Manipulation Tools

#### `list_elements`
List a stable, ID-ordered page of elements and association artifacts in the
current diagram. Filter with `elementType: "bpmn:Association"` to list only
associations.

```javascript
{
  elementType: "bpmn:Task", // optional filter
  limit: 100, // optional, defaults to 100; maximum 500
  offset: 0 // optional, defaults to 0
}
```

The response is `{ count, returnedCount, offset, limit, hasMore, elements, revision }`.
Compatibility note: the pagination envelope replaces the earlier bare-array
response; clients written against that contract must now read `elements`. The
existing element fields retain their meanings. Rendered elements also expose
`shapeId`, `bounds`, and optional `labelBounds`; additional metadata fields and
lane entries may be present.

#### `get_element`
Get details of a specific element or association.

```javascript
{
  elementId: "UserTask_1"
}
```

#### `list_connections`
List a stable, ID-ordered page of SequenceFlow, MessageFlow, and Association
connections. Optional filters select a connection type, endpoint, owner, or
scope. Each result includes semantic fields, BPMN DI waypoints, and the current
semantic, geometry, and document revisions.

```javascript
{
  connectionType: "bpmn:MessageFlow", // optional
  sourceId: "SendTask_1", // optional
  limit: 100,
  offset: 0
}
```

#### `get_connection`
Get the complete semantic and rendered geometry state for one SequenceFlow,
MessageFlow, or Association. Use the returned revisions as compare-and-set
guards for connection mutations and routing.

```javascript
{
  connectionId: "Flow_1"
}
```

#### `update_element`
Update element properties.

```javascript
{
  elementId: "UserTask_1",
  name: "Updated Task Name",
  properties: { assignee: "john.doe", candidateGroups: ["reviewers"] },
  defaultFlow: "Flow_2" // outgoing flow ID, or null to clear
}
```

#### `update_connection`
Update SequenceFlow, MessageFlow, or Association semantics without replacing
the connection ID. Labels may be cleared with `null`; SequenceFlow conditions
may be replaced or cleared, default ownership may be toggled, and Association
direction may be changed. Supply either the `semanticRevision` returned by
`get_connection` or the current document revision. Changing either endpoint
requires explicit `snap-to-boundary`, which validates and attaches the retained
route to the new endpoint shapes before the atomic autosave.

```javascript
{
  connectionId: "Flow_1",
  targetId: "Task_3", // optional
  label: "Approved", // optional; null clears
  condition: { body: "${approved}", language: "FEEL" }, // null clears
  isDefault: false, // SequenceFlow only
  endpointPolicy: "snap-to-boundary", // required when an endpoint changes
  expectedSemanticRevision: "sha256:...",
  collisionPolicy: "reject-new" // or "warn" / "allow"
}
```

#### `update_element_geometry`
Move or resize one rendered element with atomic autosave. Connected shapes
require `incidentConnectionPolicy`; use `snap-endpoints` to keep incident edges
attached or `reject` to refuse the change. Newly introduced collisions are
rejected unless `collisionPolicy: "allow"` is explicit. Use `dryRun` to receive
the proposed before/after geometry and diagnostics without changing the file.

```javascript
{
  elementId: "UserTask_1",
  bounds: { x: 420, y: 180, width: 120, height: 90 },
  labelBounds: { x: 430, y: 275, width: 100, height: 20 }, // optional; null clears
  expectedBounds: { x: 300, y: 180, width: 100, height: 80 }, // optional CAS guard
  expectedRevision: "sha256:...:v4", // optional optimistic-concurrency guard
  collisionPolicy: "reject", // or "allow"; defaults to "reject"
  incidentConnectionPolicy: "snap-endpoints", // required for connected moves/resizes
  dryRun: false
}
```

#### `update_connection_geometry`
Replace all waypoints for one rendered connection with atomic autosave. Exact
endpoints must already attach to the source and target boundaries;
`snap-to-boundary` adjusts both endpoints while preserving interior waypoints.
Omitting `labelBounds` preserves the edge label and `null` clears it. Use either
`expectedWaypoints` or the `geometryRevision` returned by `get_connection` as a
compare-and-set guard. Newly introduced error diagnostics are rejected by
default; `warn` and `allow` apply while returning the resulting diagnostics.

```javascript
{
  connectionId: "Flow_1",
  waypoints: [{ x: 200, y: 140 }, { x: 300, y: 140 }, { x: 400, y: 140 }],
  labelBounds: null, // optional; omission preserves the current BPMNLabel
  expectedGeometryRevision: "sha256:...", // optional geometry CAS guard
  expectedRevision: "sha256:...:v5", // optional document CAS guard
  endpointPolicy: "exact", // or "snap-to-boundary"; defaults to "exact"
  collisionPolicy: "reject-new", // or "warn" / "allow"
  dryRun: false
}
```

#### `apply_geometry_patch`
Update up to 256 rendered elements and connections in one atomic commit. The
server applies every shape, label, and route update to a private candidate,
then evaluates diagnostics against that complete final geometry. Supply either
`expectedRevision` for the whole patch or per-object before guards. Any stale
guard, invalid final geometry, rejected diagnostic, or save failure leaves both
memory and disk unchanged.

```javascript
{
  expectedRevision: "sha256:...:v6",
  elementUpdates: [{
    elementId: "UserTask_1",
    bounds: { x: 500, y: 180, width: 120, height: 90 },
    labelBounds: { x: 510, y: 275, width: 100, height: 20 }
  }],
  connectionUpdates: [{
    connectionId: "Flow_1",
    waypoints: [{ x: 200, y: 140 }, { x: 500, y: 225 }],
    endpointPolicy: "exact"
  }],
  collisionPolicy: "reject-new", // or "warn" / "allow"
  dryRun: false
}
```

#### `route_connection`
Generate ranked orthogonal routing candidates for one SequenceFlow,
MessageFlow, or Association. The default is proposal-only: memory, disk, and
the document revision remain unchanged. The returned `geometryPatch` can be
passed directly to `apply_geometry_patch`. Set `apply: true` to commit the best
collision-free candidate in one atomic autosave. The router scores shape and
label collisions, clearance failures, crossings with existing connections,
bends, and length while preserving every unrelated DI object.

```javascript
{
  connectionId: "Flow_1",
  avoidElementIds: ["Task_Obstacle"],
  avoidConnectionIds: ["Flow_Existing"],
  clearance: 20,
  preserveOtherGeometry: true,
  expectedGeometryRevision: "sha256:...", // optional geometry CAS guard
  apply: false // proposal-only by default
}
```

If no acceptable route exists, the tool returns a `routing_failed` error with
ranked candidate geometry, score breakdowns, and diagnostics without mutation.

#### `build_process`
Create many elements and the flows between them in one atomic call. Each node
carries a caller-chosen `ref` that flows in the same request use to name it; the
server assigns the real BPMN IDs and returns the mapping. A flow endpoint that is
not a `ref` is treated as the ID of an element already in the diagram. The same
validation applies as for the individual `add_*` and `connect` tools, and nothing
is written unless every step succeeds. Run `auto_layout` afterwards to place the
result.

```javascript
{
  nodes: [
    { kind: "event", ref: "start", eventType: "start", name: "Request received" },
    { kind: "activity", ref: "review", activityType: "userTask", name: "Review" },
    { kind: "gateway", ref: "decide", gatewayType: "exclusive", name: "Approved?" },
    { kind: "activity", ref: "pay", activityType: "serviceTask", name: "Pay" },
    { kind: "event", ref: "done", eventType: "end", name: "Done" }
  ],
  flows: [
    { source: "start", target: "review" },
    { source: "review", target: "decide" },
    { source: "decide", target: "pay", label: "yes", condition: "${approved}" },
    { source: "decide", target: "done", label: "no", isDefault: true },
    { source: "pay", target: "done" }
  ]
}
```

Returns `elements` (each with its `ref`, assigned `elementId` and BPMN `type`),
`connections`, and the usual revision fields.

#### `delete_element`
Delete an element and its incident connections. Passing an association ID
deletes only that association and leaves its endpoints intact; deleting an
endpoint, including a text annotation, cascades to its associations.

```javascript
{
  elementId: "Task_1"
}
```

### Utility Tools

#### `export`
Export the current diagram as BPMN 2.0 XML or a rendered SVG.

```javascript
{
  format: "xml", // "xml" or "svg"; defaults to "xml"
  formatted: true // optional; applies to XML and defaults to true
}
```

XML export returns text and does not launch a browser. SVG export launches a
headless browser through Puppeteer, renders with `bpmn-js`, sanitizes the
result, and returns an embedded `image/svg+xml` resource. It requires an
available Chrome/Chromium executable and retains the visible bpmn.io
attribution described under [License](#-license).

#### `save_svg`
Render the current diagram and atomically persist a separate SVG artifact in the
managed workspace. The required filename must use the `.svg` extension. Existing
files are preserved unless `overwrite` is explicitly true.

```javascript
{
  filename: "order-review.svg",
  overwrite: false // optional; defaults to false
}
```

SVG artifacts use the same sanitization and visible bpmn.io attribution as
`export`.

#### `save_png`
Render the current diagram and atomically persist a separate PNG artifact in the
managed workspace. The required filename must use the `.png` extension. Existing
files are preserved unless `overwrite` is explicitly true.

```javascript
{
  filename: "order-review.png",
  overwrite: false, // optional; defaults to false
  scale: 1 // optional pixel density, 1 to 4; defaults to 1
}
```

PNG is rasterized from the same sanitized SVG that `save_svg` writes. `scale`
becomes the browser's device pixel ratio, so text and strokes are resampled
rather than stretched. The result reports `width`, `height`, `scale`, and
`downscaled`; a diagram whose raster would exceed 4,096 px on a side or
16 million pixels is reduced below the requested scale and says so instead of
shrinking silently.

Both tools render from the active BPMN snapshot without changing its XML,
revision, or active `.bpmn` filename. Rendered output is capped at 5 MiB by
default and can be configured with `MCP_BPMN_MAX_ARTIFACT_BYTES`. Filenames are
basename-only and traversal-safe. `list_diagrams` and `delete_diagram_file`
continue to operate only on BPMN XML files, keeping diagram and
rendered-artifact operations explicit.

#### `validate`
Validate the current diagram structure.

```javascript
{
  level: "full" // "syntax", "semantic", or "full"; defaults to "full"
}
```

Validation levels are cumulative. `syntax` parses XML and resolves references;
`semantic` adds owner-aware event, flow, subprocess, lane, and collaboration
rules; `full` also adds executable-profile start/end/connectivity guidance.

#### `analyze_geometry`
Inspect the whole diagram or selected element and connection IDs for missing DI,
endpoint gaps, overlaps, crossings, containment failures, minimum clearance,
and optional non-orthogonal routes. The response includes stable severity-coded
diagnostics, a summary, and the relevant shapes, edges, and labels.

```javascript
{
  elementIds: ["DataObjectReference_1"], // optional
  connectionIds: ["MessageFlow_1"], // optional
  clearance: 5,
  tolerance: 1,
  requireOrthogonal: true
}
```

#### `auto_layout`
Apply automatic layout to position elements in the current diagram.

```javascript
{
  algorithm: "horizontal", // currently only horizontal is supported
  direction: "left-to-right" // or "top-to-bottom"
}
```

`direction` chooses the reading direction. `top-to-bottom` reflects the ranked
layout across the diagonal: flows run downward, pools become vertical bands,
and edge endpoints are re-docked onto the borders they now face. There are no
spacing, subset, or pinned-element controls yet, so every coordinate the layout
touches is replaced.

A layout that reproduces the geometry the diagram already has is not committed.
The call returns `changed: false`, leaves the revision alone, and does not
rewrite the file, so running `auto_layout` twice is free the second time.

Layout runs in a killable subprocess with a default five-second budget. A
benchmark-derived preflight accepts at most 2,000 elements, 2,000 connections,
and 10 connections per element; inputs over any limit reject before layout.
For collaborations, each participant process is ranked independently, so
message flows do not change its sequence-flow order. Auto-layout replaces
manual node and container coordinates, but requested/imported participant and
lane dimensions remain lower bounds. Pools are then stacked without overlap;
lanes and owned nodes remain contained, and message flows are routed only after
the final pool placement. Disconnected nodes are packed deterministically in
their owner process, nested subprocesses retain semantic containment, and
black-box participants keep their requested minimum size without fabricated
process content.

### File Management Tools

#### `list_diagrams`
List a stable, filename-ordered page of saved BPMN diagrams.

```javascript
{
  limit: 100, // optional, defaults to 100; maximum 500
  offset: 0 // optional, defaults to 0
}
```

The existing `{ count, diagrams, path }` response fields remain available;
`returnedCount`, `offset`, `limit`, and `hasMore` describe the selected page.
Only files on the selected page are read for embedded BPMN metadata, and the
aggregate metadata read is capped at 5 MiB by default.

#### `delete_diagram_file`
Delete a saved diagram file.

```javascript
{
  filename: "old-process.bpmn"
}
```

#### `get_diagrams_path`
Get the current workspace path. This compatibility alias predates the richer
workspace discovery response.

```javascript
{}
```

#### `get_workspace`
Report the canonical launch cwd, immutable startup boundary, current workspace,
and whether it came from the environment, repository config, launch cwd, or a
session selection.

```javascript
{}
```

#### `select_workspace`
Select another workspace below the startup boundary for this stdio session.
Changing workspaces closes the active diagram; successful prior mutations are
already autosaved.

```javascript
{
  path: "wiki/processes/assets"
}
```

## 🔄 Context Management

The MCP-BPMN server uses a stateful design where you work with one diagram at a time:

1. **Create or Open**: Start by creating a new diagram (`new_bpmn`, `new_from_mermaid`) or opening an existing one (`open_bpmn`, `open_mermaid_file`)
2. **Manipulate**: All operations (`add_event`, `connect`, etc.) apply to the current diagram
3. **Save**: Save your work with `save` or `save_as`
4. **Close**: Close the current diagram with `close`

If you try to perform operations without a current context, you'll get a helpful error message:
```
No current context. Please create a diagram first with:
  - new_bpmn(name) to create a new BPMN diagram
  - new_from_mermaid(name, mermaidCode) to convert from Mermaid
  - open_bpmn(filename) to open an existing BPMN file
  - open_mermaid_file(filename) to convert a Mermaid file
```

## 💡 Examples

### Example 1: Creating an Approval Process from Scratch

```javascript
// Step 1: Create a new process (sets it as current context)
await new_bpmn({ name: "Approval Workflow" });

// Step 2: Add elements. Every add_* result carries the generated `elementId`;
// keep it instead of guessing. IDs come from per-type session counters, and a
// rejected call still consumes a number, so "StartEvent_1" only holds on a
// server that has never failed a call.
const start = await add_event({ eventType: "start", name: "Request Received" });
const review = await add_activity({ activityType: "userTask", name: "Review Request" });
const decision = await add_gateway({ gatewayType: "exclusive", name: "Approved?" });
const approve = await add_activity({ activityType: "serviceTask", name: "Process Approval" });
const reject = await add_activity({ activityType: "userTask", name: "Handle Rejection" });
const complete = await add_event({ eventType: "end", name: "Complete" });

// Step 3: Connect elements using the returned IDs
await connect({ sourceId: start.elementId, targetId: review.elementId });
await connect({ sourceId: review.elementId, targetId: decision.elementId });
await connect({ sourceId: decision.elementId, targetId: approve.elementId, label: "Yes" });
await connect({ sourceId: decision.elementId, targetId: reject.elementId, label: "No" });
await connect({ sourceId: approve.elementId, targetId: complete.elementId });
await connect({ sourceId: reject.elementId, targetId: complete.elementId });

// Step 4: Apply auto-layout for proper positioning
await auto_layout();

// Step 5: Save and export the diagram
await save_as({ filename: "approval-workflow.bpmn" });
const xml = await export();
```

### Example 2: Bootstrap from Mermaid (Recommended for Lower Token Usage)

```javascript
// Step 1: Create from Mermaid syntax (much more concise!)
await new_from_mermaid({ 
  name: "Approval Workflow",
  extensionProfile: "camunda7",
  mermaidCode: `
    graph TD
      A((Request Received)) --> B[Review Request]
      B --> C{Approved?}
      C -->|Yes| D[Process Approval]
      C -->|No| E[Handle Rejection]
      D --> F((Complete))
      E --> F
  `
});

// Step 2: Apply auto-layout (Mermaid conversion includes basic layout)
await auto_layout();

// Step 3: Look up the imported IDs before editing. Mermaid node keys become the
// ID suffix, and every Mermaid box becomes a plain `bpmn:Task`, so this import
// yields StartEvent_A, Task_B, Gateway_C, Task_D, Task_E, and EndEvent_F.
const { elements } = await list_elements({});
const review = elements.find(element => element.name === "Review Request");

// `assignee` is rejected on `bpmn:Task` ("assignee is only valid on
// bpmn:UserTask"), so rename here and add a real user task with add_activity
// when you need user-task properties.
await update_element({
  elementId: review.id,
  name: "Review Request (SLA 2 days)"
});

// Step 4: Save and export
await save_as({ filename: "approval-workflow.bpmn" });
const xml = await export();
```

### Example 3: Working with Multiple Diagrams

```javascript
// Create first diagram
await new_bpmn({ name: "Process A" });
await add_event({ eventType: "start" });
await add_activity({ activityType: "task", name: "Task A" });
await save_as({ filename: "process-a.bpmn" });

// Create second diagram (automatically closes the first)
await new_bpmn({ name: "Process B" });
await add_event({ eventType: "start" });
await add_activity({ activityType: "task", name: "Task B" });
await save_as({ filename: "process-b.bpmn" });

// Go back to first diagram
await open_bpmn({ filename: "process-a.bpmn" });
await add_event({ eventType: "end" });
await save();

// Check current diagram info
const info = await current();
console.log(info); // Shows: { name: "Process A", filename: "process-a.bpmn", ... }
```

## 🗂️ File Storage

BPMN diagrams are automatically saved in the canonical directory from which
the MCP client launched the stdio child. A repository may narrow storage to a
relative descendant with `.mcp-bpmn.json`:

```json
{
  "path": "wiki/processes/assets"
}
```

Dot segments, absolute repository-config paths, and symlink traversal are
rejected. Use `get_workspace` to inspect the launch cwd, immutable startup
boundary, current workspace, and resolution source. `select_workspace` may
narrow the current session to another relative descendant and closes the active
diagram when the workspace changes; it never changes the Node process cwd.

An explicit absolute environment override remains available for clients that
do not propagate the intended repository cwd:

```bash
export MCP_BPMN_DIAGRAMS_PATH=/custom/path
```

`src/config/index.ts` defines every other supported variable. This is the
complete set the **server** reads at runtime (`MCP_BPMN_LAYOUT_CANDIDATES`,
listed under [Development](#-development), is a test-suite flag and has no
effect on the server):

| Variable | Effect | Default |
| --- | --- | --- |
| `MCP_BPMN_DIAGRAMS_PATH` | Absolute workspace override; must have no dot segments | launch cwd |
| `MCP_BPMN_MAX_IMPORT_BYTES` | Largest accepted BPMN import | 5 MiB |
| `MCP_BPMN_MAX_IMPORT_ELEMENTS` | Elements accepted per import | 10,000 |
| `MCP_BPMN_MAX_IMPORT_FLOWS` | Flows accepted per import | 20,000 |
| `MCP_BPMN_MAX_IMPORT_DI_ELEMENTS` | DI elements accepted per import | 30,000 |
| `MCP_BPMN_MAX_MERMAID_BYTES` | Largest accepted Mermaid input | 5 MiB |
| `MCP_BPMN_MAX_ARTIFACT_BYTES` | Largest rendered SVG/PNG written by `save_svg`/`save_png` | 5 MiB |
| `MCP_BPMN_MAX_LAYOUT_ELEMENTS` | Elements accepted per layout | 2,000 |
| `MCP_BPMN_MAX_LAYOUT_CONNECTIONS` | Connections accepted per layout | 2,000 |
| `MCP_BPMN_MAX_LAYOUT_DENSITY` | Connections per element accepted per layout | 10 |
| `MCP_BPMN_MAX_LAYOUT_BYTES` | Largest XML handed to the layout subprocess | 5 MiB |
| `MCP_BPMN_MAX_CONCURRENT_LAYOUTS` | Simultaneous layout subprocesses | 2 |
| `MCP_BPMN_MAX_LISTING_ITEMS` | Directory entries scanned by `list_diagrams` | 10,000 |
| `MCP_BPMN_MAX_LISTING_METADATA_BYTES` | Total diagram bytes read for listing metadata | 5 MiB |
| `MCP_BPMN_LAYOUT_TIMEOUT_MS` | Layout subprocess deadline | 5,000 ms |
| `MCP_BPMN_SHUTDOWN_TIMEOUT_MS` | Graceful shutdown deadline | 15,000 ms |
| `MCP_BPMN_BROWSER_ARGS` | Space-separated list that replaces the Chrome command line used for SVG/PNG rendering | `--no-sandbox --disable-setuid-sandbox` under uid 0, otherwise none |

A numeric variable that is not a positive number — a typo, `0`, or a negative
value — is ignored and the default applies, so a malformed override can never
disable a limit. Read the defaults from
`src/config/index.ts` rather than pinning them in deployment documentation. The
layout defaults come from local sparse/dense benchmarks recorded in that file:
2,000/1,999 completed in about 1.4s, 25/300 took about 4.8s, and 26/325 exceeded
five seconds.

On SIGINT, SIGTERM, or stdin EOF, the server stops accepting tool calls and
allows accepted operations and their atomic persistence to finish before it
closes renderer/layout subprocesses and the stdio transport. Graceful shutdown
has a hard 15-second deadline; exceeding it forces a nonzero exit.

### Diagram filenames

Each diagram has exactly one active filename, and every successful mutation
serializes and atomically autosaves to it. A failed serialization or write
leaves both memory and disk at the last successful state.

`new_bpmn`, `new_from_mermaid`, and `open_mermaid_file` all accept an optional
filename (`filename`, or `bpmnFilename` on `open_mermaid_file`). Pass one and
that name is the active filename from the first autosave; a name with no
extension gets `.bpmn` appended.

Omit it and the server generates a **placeholder** name instead, so that
autosave has somewhere to write before you have chosen a name. The placeholder
is not meant to be read by a human:

```text
mcp-bpmn-v1_<base64url of ["<processId>","<name>","<uuid>"]>.bpmn
```

Encoding the metadata is what lets `list_diagrams` report the exact process ID
and name without opening the file. If that encoded name would exceed 200 bytes,
the server falls back to `{processId}_{sanitizedName}_{uuid}.bpmn`; the 200-byte
ceiling leaves room for the atomic-write suffix inside one 255-byte filesystem
component.

`save_as` adopts the name you give it and **deletes the placeholder** it
replaces, so a diagram that started unnamed does not leave an orphan duplicate
behind. Its result reports `previousFilename` and `removedPreviousFile`. A
filename you chose yourself is never deleted on your behalf: calling `save_as`
on a named diagram leaves the previous file in place as an unchanged snapshot.
Opening a file adopts that file's name, which is likewise never a placeholder.

## 🏗️ Architecture

### Technology Stack
- **TypeScript** - Type-safe development
- **Node.js** - Runtime environment  
- **MCP SDK** - Model Context Protocol implementation
- **Jest** - Testing framework

### Key Components
- `SimpleBpmnEngine` (`src/core/`) - Canonical BPMN document mutation, persistence, and XML export
- `BpmnDocument` (`src/core/`) - Typed, moddle-backed model and XML serialization
- `BpmnValidator` (`src/core/`) - Syntax, semantic, and full validation levels
- `BpmnSvgRenderer` (`src/core/`) - Isolated, browser-backed `bpmn-js` SVG rendering
- `DiagramContext` (`src/core/`) - Stateful context management for current diagram
- `BpmnAutoLayoutV2Adapter` (`src/core/layout/`) - The one layout path; runs `bpmn-auto-layout` in a bounded subprocess
- `BpmnRequestHandler` (`src/server/`) - MCP request validation and dispatch
- `MermaidConverter` / `MermaidParser` (`src/converters/`) - Mermaid to BPMN conversion
- `WorkspaceSession` (`src/config/`) - Launch cwd, startup boundary, and workspace selection
- `FileManager` / `SafeFileStore` (`src/utils/`) - Bounded, atomic, root-pinned file operations

### Project Structure

```
mcp-bpmn/
├── src/
│   ├── core/           # BPMN engine, document model, validator, renderer
│   │   └── layout/     # Layout model, adapters, connection routing
│   ├── converters/     # Mermaid parsing and conversion
│   ├── server/         # MCP server, tool schemas, request handlers
│   ├── utils/          # IDs, type mappings, safe file access
│   ├── types/          # TypeScript type definitions
│   └── config/         # Configuration and workspace resolution
├── tests/
│   ├── unit/          # Component tests grouped by source area
│   ├── integration/   # Cross-component behavior
│   ├── contracts/     # Engine and tool-annotation contracts
│   ├── security/      # Adversarial boundary and resource tests
│   ├── e2e/           # Built MCP server protocol tests
│   ├── fixtures/      # BPMN, Mermaid, dialect, and layout inputs
│   ├── helpers/       # Shared test helpers
│   └── mocks/         # Jest/runtime mocks
├── dist/              # Compiled output
└── docs/              # Documentation
```

## 🧪 Development

### Available Scripts

```bash
npm run build        # Build TypeScript
npm run build:bundle # Build CommonJS bundle
npm run build:watch  # Build with watch mode
npm run check        # Complete clean contributor/CI quality gate
npm test             # Source-level tests, then the renderer suite
npm run test:all     # Clean, build, and run every suite including e2e and the loop tests
npm run test:unit    # Unit tests only
npm run test:integration # Integration tests, then the renderer suite
npm run test:e2e     # Clean, build, and run the compiled MCP server tests
npm run test:package # Pack, install, and initialize the published entry points
npm run lint         # Run ESLint
npm run dev          # Development mode with hot reload
npm start            # Start the MCP server
```

Two suites are excluded from the everyday loop and run only when asked for, or
as part of `npm run test:all`:

```bash
npm run test:layout-candidates # Compare the shipped layout against the dev-only alternatives
npm run test:ralph             # Integration tests for ralph-loop/loop.sh
```

`npm test` still exercises the shipped layout path across the whole fixture
corpus; only the third-party comparison candidates, which cost roughly 54 extra
Node subprocesses, are gated behind `test:layout-candidates`.

### Testing

Source-level commands do not read `dist/`, so an old build cannot affect their
result. The suites are:

- **Unit** (`tests/unit/`) - component tests grouped by source area
- **Integration** (`tests/integration/`) - cross-component behavior
- **Contracts** (`tests/contracts/`) - the engine and tool-annotation contracts
- **Security** (`tests/security/`) - adversarial boundary and resource tests
- **E2E** (`tests/e2e/`) - the built MCP server over the protocol
- **Renderer** (`npm run test:renderer`) - real Puppeteer/Chrome rendering

Run tests with:
```bash
npm test                    # Source-level tests
npm run test:all            # Clean build plus all tests
npm run check               # Complete clean contributor/CI quality gate
npm run test:coverage       # Source-level tests with coverage
npm run test:watch          # Source-level tests in watch mode
```

## 📈 Performance

The canonical release artifact was last measured on 2026-09-04 with Node 22.22.2
and npm 10.9.7 using:

```bash
npm pack --dry-run --json
```

That command reported approximately **410 kB** compressed, **2,353,180** unpacked
bytes, and **153** files. Most of the unpacked size is not executable code:
`.js` accounts for about 811 kB, TypeScript declarations for about 354 kB, and
source maps (`.js.map` plus `.d.ts.map`) for about 798 kB together, all emitted
because `tsconfig.json` compiles the whole of `src/**/*`.

Measure it after a build: `npm pack` reports only the files that exist, so
running it against a cleaned `dist/` reports a fraction of the real artifact.

These figures describe the npm tarball, not an installed server: the tarball
bundles no production dependencies, while installation resolves the nine direct
runtime dependencies in `package.json` and their transitive dependencies.
Puppeteer's managed browser download (see [Browser
download](#browser-download)) is also outside the tarball measurement, and it is
far larger than the tarball itself. Re-run the command for the current artifact
instead of treating this dated snapshot as a permanent size guarantee.

The optional CommonJS bundle is not the release artifact and has no size claim.
Layout input limits and the dated benchmark observations used to choose their
defaults are documented under [File Storage](#-file-storage).

## 🐛 Known Limitations

- The authoring API is a focused BPMN 2.0 subset, not complete BPMN 2.0
  coverage. Unsupported imported constructs can be rejected rather than edited
  losslessly.
- `connect` infers the connection type from its endpoints rather than taking
  one. There is no way to ask for a message flow between two nodes that a
  collaboration would otherwise join with a sequence flow.
- `add_lane` authors top-level lanes in white-box pools; it cannot extend an
  imported nested lane hierarchy.
- Auto-layout ranks left to right, optionally reflected top to bottom. There
  are no spacing, subset, or pinned-element controls, and radial algorithms are
  not advertised.
- Validation provides the documented syntax, semantic, and full guidance
  levels; it is not BPMN XSD certification or validation against a deployment
  engine.
- The Camunda 7 authoring profile is limited to `assignee`, `candidateGroups`,
  and `dueDate` on user tasks. It is not general Camunda modeler coverage.
- SVG export and managed SVG/PNG artifact rendering require Chrome/Chromium
  through Puppeteer and permit only one concurrent render per server instance.
  XML workflows remain browser-free.
- The server does not execute, simulate, or deploy BPMN processes.

## 🚧 Roadmap

Planned work and known gaps are tracked as Beads issues rather than promised as
implemented features in this release document.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run the complete quality gate (`npm run check`)
4. Commit your changes (`git commit -m 'Add amazing feature'`)
5. Push to the branch (`git push origin feature/amazing-feature`)
6. Open a Pull Request

### Code Style

- TypeScript with strict mode
- ESLint configuration provided
- Jest for testing
- Conventional commits

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

SVG export and saved SVG/PNG artifacts use `bpmn-js@17.11.1`. Every exported or
saved artifact includes the visible
"Powered by bpmn.io" logo linked to `https://bpmn.io`; clients should not crop,
cover, or remove that attribution. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the dependency's license terms and
[ADR 0002](docs/decisions/0002-bpmn-js-svg-attribution.md) for the release
decision.

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/sebahrens/bpmn-mcp/issues)
- **Documentation**: See `/docs` folder for detailed guides

## 🙏 Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/) specification
- Inspired by [bpmn-js](https://github.com/bpmn-io/bpmn-js) for BPMN standards
- Thanks to the Anthropic team for MCP development
