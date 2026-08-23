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
- **XML and SVG export**: XML is generated in-process; SVG is rendered through
  Puppeteer and `bpmn-js`
- **Portable and Camunda 7 profiles**: Vendor-free output by default, with three
  typed Camunda 7 user-task fields when explicitly selected

## 🚀 Quick Start

### Requirements

- Node.js 22.12.0 or newer
- npm with lockfile support
- Chrome or Chromium for `export({ format: "svg" })`; the normal Puppeteer
  install downloads a compatible browser

XML authoring, validation, layout, persistence, and XML export do not launch a
browser. SVG export does. If the Puppeteer browser download is intentionally
skipped, set `PUPPETEER_EXECUTABLE_PATH` to a compatible Chrome or Chromium
executable before starting the server. SVG rendering is headless, limited to
one concurrent render per server instance, and has a ten-second render timeout.

### Run from a source checkout

```bash
git clone https://github.com/oisee/mcp-bpmn.git
cd mcp-bpmn
npm ci
npm run build
npm start
```

`npm run build` emits the canonical ESM executable at
`dist/server/index.js`. The server uses stdio, so it normally appears idle when
started in a terminal and is intended to be launched by an MCP client.

### Configuration

#### For Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-bpmn": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-bpmn/dist/server/index.js"]
    }
  }
}
```

#### For other MCP clients

Use the same ESM entrypoint with an absolute path:

```bash
node /absolute/path/to/mcp-bpmn/dist/server/index.js
```

### Install a packed release artifact

This repository currently documents an npm tarball install rather than assuming
that `mcp-bpmn-server` is available from the public npm registry. A release
producer can build the canonical CLI-only artifact from a source checkout:

```bash
artifact_dir=$(mktemp -d)
npm pack --pack-destination "$artifact_dir"
```

Install that tarball into a dedicated consumer directory and run its packaged
executable:

```bash
consumer_dir=$(mktemp -d)
npm install --prefix "$consumer_dir" "$artifact_dir"/mcp-bpmn-server-*.tgz
"$consumer_dir/node_modules/.bin/mcp-bpmn-server"
```

For an MCP client, use the absolute value of
`$consumer_dir/node_modules/.bin/mcp-bpmn-server` as `command` and an empty
`args` array. The package is a CLI, not an importable JavaScript library.

### Develop the Codex plugin locally

The release artifact is also a Codex plugin. Its manifest discovers the
canonical `skills/bpmn-modeler` skill and starts one `mcp-bpmn` stdio server
through a launcher copied into the plugin cache. The launcher uses the stable
private release installed by `make install-codex`; it does not execute
TypeScript or depend on the checkout after installation.

Build the release artifact, add this checkout as a temporary repo marketplace,
and install the plugin with:

```bash
npm ci
npm run build
make install-codex
codex plugin marketplace add .
codex plugin list --available
codex plugin add mcp-bpmn@mcp-bpmn-local
```

Start a new Codex conversation after installation so the skill and MCP tools
are loaded. The bundled server defaults to `writes` approval mode: tools marked
read-only can run automatically, while diagram mutations remain visible for
approval. Remove the development installation with:

```bash
codex plugin remove mcp-bpmn@mcp-bpmn-local
codex plugin marketplace remove mcp-bpmn-local
```

Run the isolated marketplace, cache, discovery, MCP startup, and removal smoke
without changing the real Codex configuration:

```bash
npm run test:codex-plugin
```

### Develop the Claude Code plugin locally

The release artifact is also a Claude Code plugin. Claude discovers the
canonical `skills/bpmn-modeler/SKILL.md` as the namespaced
`/mcp-bpmn:bpmn-modeler` skill and starts the inline `mcp-bpmn` server from the
plugin cache. The plugin uses `skills/`; it does not carry a legacy `commands/`
copy.

From a source checkout, install dependencies, build, validate, and load the
plugin for one development session:

```bash
npm ci
npm run build
claude plugin validate .
claude --plugin-dir .
```

Inside Claude Code, use `/mcp` to confirm the plugin-provided server, invoke
`/mcp-bpmn:bpmn-modeler` to inspect the skill, and run `/reload-plugins` after
changing the manifest or MCP configuration. The checkout contains a root
`CLAUDE.md` for repository contributors, so source validation reports that it
is not plugin context; the command still succeeds. The packed plugin excludes
that repository-only file and passes strict validation.

Run the complete local marketplace smoke with:

```bash
npm run test:claude-plugin
```

That check uses a temporary Claude home and marketplace. It installs a copied
release artifact, checks Claude's component inventory, launches the cached MCP
server, exercises a reload, and then disables, enables, and removes the plugin.
It does not change the developer's real Claude configuration.

Diagrams are never written into `${CLAUDE_PLUGIN_ROOT}`. They remain in
`MCP_BPMN_DIAGRAMS_PATH` when set, or in `~/mcp-bpmn` by default, so plugin
reloads, updates, disablement, and removal do not delete them. Before switching
from a manual Claude MCP registration to the plugin, inspect `claude mcp list`
and remove the old `mcp-bpmn` registration if its command differs from the
plugin endpoint; Claude only deduplicates plugin and user servers that resolve
to the same command.

### Evaluate agent workflows

The canonical machine-readable corpus is
`evals/bpmn-modeler/cases.json`. Both client adapters consume those exact
prompts and semantic expectations. The deterministic check is safe for normal
development and CI: it verifies activation boundaries, skill metadata, tool
names, client parity, and the create/mutate/validate/layout/validate/export
sequence without calling a model:

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
| Relationships | `connect`, `add_association` | Direct `connect` authors sequence flows; Mermaid subgraphs can also produce message flows; associations are artifact relationships |
| Query/mutation | `list_elements`, `get_element`, `update_element`, `delete_element` | Paginated queries and the documented typed mutation fields |
| Export/quality | `export`, `validate`, `auto_layout` | XML or browser-backed SVG; layered structural validation; horizontal layout only |
| Stored files | `list_diagrams`, `delete_diagram_file`, `get_diagrams_path` | Sandboxed access inside the configured diagrams directory |

### Creation Tools

#### `new_bpmn`
Create a new BPMN process or collaboration diagram and set it as the current context.

```javascript
{
  name: "Order Processing",
  type: "process" // or "collaboration" (optional, defaults to "process")
}
```

#### `new_from_mermaid`
Create a new BPMN diagram from Mermaid code and set it as the current context.

```javascript
{
  name: "My Process",
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
  filename: "my-flowchart.mmd"
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
active. Later mutations update only the new file; the previous file remains an
unchanged snapshot.

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
Connect two elements with a sequence flow in the current diagram.

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
or complex gateways. A default flow cannot also have a condition.

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

The response is `{ count, returnedCount, offset, limit, hasMore, elements }`.
Compatibility note: the pagination envelope replaces the earlier bare-array
response; clients written against that contract must now read `elements`. The
existing element fields retain their meanings; additional metadata fields and
lane entries may be present.

#### `get_element`
Get details of a specific element or association.

```javascript
{
  elementId: "UserTask_1"
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

#### `auto_layout`
Apply automatic layout to position elements in the current diagram.

```javascript
{
  algorithm: "horizontal" // currently only horizontal is supported
}
```

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
Get the storage path for diagrams.

```javascript
{}
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

// Step 2: Add elements (all operations apply to current diagram)
await add_event({ eventType: "start", name: "Request Received" });
await add_activity({ activityType: "userTask", name: "Review Request" });
await add_gateway({ gatewayType: "exclusive", name: "Approved?" });
await add_activity({ activityType: "serviceTask", name: "Process Approval" });
await add_activity({ activityType: "userTask", name: "Handle Rejection" });
await add_event({ eventType: "end", name: "Complete" });

// Step 3: Connect elements
await connect({ sourceId: "StartEvent_1", targetId: "UserTask_1" });
await connect({ sourceId: "UserTask_1", targetId: "ExclusiveGateway_1" });
await connect({ sourceId: "ExclusiveGateway_1", targetId: "ServiceTask_1", label: "Yes" });
await connect({ sourceId: "ExclusiveGateway_1", targetId: "UserTask_2", label: "No" });
await connect({ sourceId: "ServiceTask_1", targetId: "EndEvent_1" });
await connect({ sourceId: "UserTask_2", targetId: "EndEvent_1" });

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

// Step 3: Make additional edits if needed
await update_element({ 
  elementId: "UserTask_1", 
  properties: { assignee: "reviewer" }
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

BPMN diagrams are automatically saved to your local filesystem:

- **Unix/Linux/Mac**: `~/mcp-bpmn/`
- **Windows**: `%USERPROFILE%\mcp-bpmn\`

Custom path via environment variable:
```bash
export MCP_BPMN_DIAGRAMS_PATH=/custom/path
```

Resource limits can be tuned with `MCP_BPMN_MAX_IMPORT_BYTES`,
`MCP_BPMN_MAX_MERMAID_BYTES`, `MCP_BPMN_MAX_LAYOUT_ELEMENTS`,
`MCP_BPMN_MAX_LAYOUT_CONNECTIONS`, `MCP_BPMN_MAX_LAYOUT_DENSITY`,
`MCP_BPMN_MAX_LAYOUT_BYTES`, `MCP_BPMN_MAX_CONCURRENT_LAYOUTS`,
`MCP_BPMN_MAX_LISTING_ITEMS`, `MCP_BPMN_MAX_LISTING_METADATA_BYTES`, and
`MCP_BPMN_LAYOUT_TIMEOUT_MS`. The graceful shutdown deadline can be overridden
with `MCP_BPMN_SHUTDOWN_TIMEOUT_MS`. Defaults are 5 MiB per imported/layout input and
per listing metadata page, 2,000 layout elements/connections, density 10, two concurrent layout
subprocesses, 10,000 listing candidates, and 5,000 ms. The layout defaults
come from local sparse/dense benchmarks: 2,000/1,999 completed in about 1.4s,
25/300 took about 4.8s, and 26/325 exceeded five seconds.

On SIGINT, SIGTERM, or stdin EOF, the server stops accepting tool calls and
allows accepted operations and their atomic persistence to finish before it
closes renderer/layout subprocesses and the stdio transport. Graceful shutdown
has a hard 15-second deadline; exceeding it forces a nonzero exit.

New diagrams start with the filename `{ProcessId}_{ProcessName}.bpmn`. Each
diagram has exactly one active filename: opening adopts the opened filename and
`save_as` switches it after the new file is written successfully. Add, update,
delete, connect, and layout operations serialize and atomically autosave the
active file; failed serialization or writes leave both memory and disk at the
last successful state.

## 🏗️ Architecture

### Technology Stack
- **TypeScript** - Type-safe development
- **Node.js** - Runtime environment  
- **MCP SDK** - Model Context Protocol implementation
- **Jest** - Testing framework

### Key Components
- `SimpleBpmnEngine` - Canonical BPMN document mutation, persistence, and XML export
- `BpmnSvgRenderer` - Isolated, browser-backed `bpmn-js` SVG rendering
- `DiagramContext` - Stateful context management for current diagram
- `BpmnAutoLayoutV2Adapter` - BPMN auto-layout integration
- `BpmnRequestHandler` - MCP request processing
- `MermaidConverter` - Mermaid to BPMN conversion
- `TypeMappings` - BPMN element type conversions
- `IdGenerator` - Consistent ID generation

### Project Structure

```
mcp-bpmn/
├── src/
│   ├── core/           # Core BPMN engine
│   ├── server/         # MCP server implementation
│   ├── utils/          # Utilities (layout, ID generation)
│   ├── types/          # TypeScript type definitions
│   └── config/         # Configuration
├── tests/
│   ├── unit/          # Unit tests
│   ├── integration/   # Integration tests
│   └── e2e/           # End-to-end tests
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
npm test            # Run source-level tests (no build output required)
npm run test:all    # Clean, build, and run every test including e2e
npm run test:unit   # Run unit tests only
npm run test:integration # Run integration tests only
npm run test:e2e    # Run end-to-end tests
npm run lint        # Run ESLint
npm run dev         # Development mode with hot reload
npm start           # Start the MCP server
```

### Testing

The project includes comprehensive test coverage. Source-level commands do not
read `dist/`, so an old build cannot affect their result:
- **Unit Tests**: Core functionality testing
- **Integration Tests**: Handler and tool testing
- **E2E Tests**: Full MCP protocol testing

Run tests with:
```bash
npm test                    # Source-level tests
npm run test:all            # Clean build plus all tests
npm run check               # Complete clean contributor/CI quality gate
npm run test:coverage       # Source-level tests with coverage
npm run test:watch          # Source-level tests in watch mode
```

## 📈 Performance

The canonical release artifact was measured on 2026-08-22 with Node 25.9.0 and
npm 11.12.1 using:

```bash
npm pack --dry-run --json
```

That command reported approximately `195 kB` compressed and `1104270` unpacked bytes.
These figures describe the npm tarball,
not an installed server: the tarball bundles no production dependencies, while
installation resolves the nine direct runtime dependencies in `package.json`
and their transitive dependencies. Puppeteer's managed Chrome download is also
outside the tarball measurement. Re-run the command for the current artifact
instead of treating this dated snapshot as a permanent size guarantee.

The optional CommonJS bundle is not the release artifact and has no size claim.
Layout input limits and the dated benchmark observations used to choose their
defaults are documented under [File Storage](#-file-storage).

## 🐛 Known Limitations

- The authoring API is a focused BPMN 2.0 subset, not complete BPMN 2.0
  coverage. Unsupported imported constructs can be rejected rather than edited
  losslessly.
- `connect` does not expose direct message-flow authoring. The Mermaid
  collaboration subset can create message flows between subgraphs.
- `add_lane` authors top-level lanes in white-box pools; it cannot extend an
  imported nested lane hierarchy.
- Auto-layout supports horizontal layout only. Vertical and radial algorithms
  are not advertised.
- Validation provides the documented syntax, semantic, and full guidance
  levels; it is not BPMN XSD certification or validation against a deployment
  engine.
- The Camunda 7 authoring profile is limited to `assignee`, `candidateGroups`,
  and `dueDate` on user tasks. It is not general Camunda modeler coverage.
- SVG export requires Chrome/Chromium through Puppeteer and permits only one
  concurrent render per server instance. XML workflows remain browser-free.
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

SVG export uses `bpmn-js@17.11.1`. Every exported SVG includes a visible
"Powered by bpmn.io" logo linked to `https://bpmn.io`; clients should not crop,
cover, or remove that attribution. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the dependency's license terms and
[ADR 0002](docs/decisions/0002-bpmn-js-svg-attribution.md) for the release
decision.

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/oisee/mcp-bpmn/issues)
- **Documentation**: See `/docs` folder for detailed guides

## 🙏 Acknowledgments

- Built on the [Model Context Protocol](https://modelcontextprotocol.io/) specification
- Inspired by [bpmn-js](https://github.com/bpmn-io/bpmn-js) for BPMN standards
- Thanks to the Anthropic team for MCP development
