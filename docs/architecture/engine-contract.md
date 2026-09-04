# BPMN engine contract and support matrix

This document is the parity baseline for `mcp-bpmn-iqa.1`. It describes the
observable contract advertised by `src/server/tools.ts`, the ownership boundary
in `src/server/handlers.ts`, and the support available from the live
`SimpleBpmnEngine`.

The executable contract is
`tests/contracts/engine-contract.test.ts`. XML assertions parse with
`bpmn-moddle` and inspect `$type` plus object references such as `sourceRef`,
`targetRef`, `processRef`, and BPMN DI `bpmnElement`; string fragments are not
used as semantic evidence. The import fixtures live in
`tests/fixtures/engine-contract/`.

The table below must stay consistent with the `TOOL_CONTRACTS` map at the top of
that test: case `C0` fails if an advertised tool has no ownership entry, so no
tool can be added without one. Verify a claim here against the named test, not
against this prose.

## Status legend

Owner:

- **engine** — behavior belongs to a `SimpleBpmnEngine` method.
- **handler** — context, conversion, validation, or file behavior belongs to
  `BpmnRequestHandler`.

Coverage names the suite that asserts the behavior:

- **contract** — an executing assertion in
  `tests/contracts/engine-contract.test.ts` drives the tool through the handler.
- **contract (engine API)** — the same suite drives the underlying engine method
  rather than the tool name.
- Any other value names the suite that owns the assertions. Every advertised
  tool additionally passes through `tests/security/request-validation.test.ts`
  for argument validation and `tests/e2e/server.test.ts` over the wire.

There is no **Gap** row left. The cases that were once gaps are recorded under
[Resolved gaps](#resolved-gaps) with the assertion that now covers each one.

## Advertised tool matrix

Rows are in `tools/list` order. `Case` names the contract case that owns the
row.

| Tool | Case | Owner | Coverage | Live `SimpleBpmnEngine` behavior |
|---|---|---|---|---|
| `new_bpmn` | C1 | engine | contract | Typed process/collaboration root with root DI and an autosave filename |
| `new_from_mermaid` | C7 | converter + engine | contract | The converter's documented Mermaid subset, imported through the live engine |
| `open_bpmn` | C5 | engine | contract (engine API) | Load and import inside the selected workspace |
| `open_mermaid_file` | C7 | converter + engine | contract | File read, conversion, then live-engine import |
| `save` | C6 | handler | integration/persistence | Atomic write of the active filename |
| `save_as` | C6 | handler | integration/persistence | Writes, adopts the new filename, and deletes a superseded server-generated placeholder |
| `close` | C6 | handler | contract | Clears the current context |
| `current` | C6 | handler | contract | Reports the current context |
| `add_event` | C2 | engine | contract | Advertised event types and supported event definitions |
| `add_activity` | C2 | engine | contract | Advertised semantic types and the profile's typed properties |
| `add_gateway` | C6 | engine | contract | Advertised semantic types |
| `add_data_object` | C6 | engine | contract | Data objects and their references |
| `add_text_annotation` | C2 | engine | contract | Text, format, DI, and the optional association |
| `connect` | C2 | engine | contract | Typed sequence-flow refs, labels, conditions, and default ownership |
| `add_association` | C2 | engine | integration/handlers | Artifact associations and direction |
| `add_pool` | C8 | engine | contract | White-box and black-box participant refs with participant DI |
| `add_lane` | G1 | engine | contract | `bpmn:LaneSet`/`bpmn:Lane` with `flowNodeRef` entries and lane DI |
| `list_elements` | C6 | handler | contract | Paginated projection of the current context |
| `get_element` | C6 | handler | contract | Single-element projection |
| `list_connections` | C6 | handler | contract | Filtered, paginated, stable ID order |
| `get_connection` | C6 | handler | contract | Single-connection projection |
| `update_element` | C4 | engine | contract | Name and supported typed properties |
| `update_connection` | C4 | engine | integration/handlers | Endpoints, labels, conditions, default ownership, association direction; ID preserved |
| `update_element_geometry` | C4 | engine | integration/handlers | Guarded `BPMNShape` bounds |
| `update_connection_geometry` | C4 | engine | integration/handlers | Guarded `BPMNEdge` waypoints |
| `apply_geometry_patch` | C4 | engine | integration/geometry-concurrency | Batched compare-and-set geometry updates |
| `route_connection` | C4 | engine | integration/handlers | Proposal-first ranked orthogonal routes; no mutation unless `apply` |
| `build_process` | C1/C2 | engine | integration/handlers | Atomic multi-node and multi-flow authoring with caller `ref` mapping |
| `delete_element` | C4 | engine | contract | Cascades incident connections and nested ownership |
| `export` | C2/G2 | engine | contract | XML with typed semantics, refs, and DI; SVG is renderer-owned |
| `save_svg` / `save_png` | G2 | handler | integration/artifact-persistence, renderer | Renderer-owned output, managed-root atomic writes, explicit overwrite and byte limits |
| `validate` | C6/G5 | handler | contract | Advertised `syntax`, `semantic`, and `full` levels |
| `analyze_geometry` | C6 | handler | e2e | Geometry diagnostics over the current context |
| `auto_layout` | C4/C6/G4 | engine | contract | The advertised horizontal layout |
| `list_diagrams` | C5 | engine | contract (engine API) | Paged listing with exact BPMN metadata |
| `delete_diagram_file` | C5 | engine | contract (engine API) | Delete inside the selected workspace |
| `get_diagrams_path` | C5 | engine | contract (engine API) | Compatibility alias for `get_workspace` |
| `get_workspace` | C6 | handler | e2e | Launch cwd, startup boundary, workspace, and resolution source |
| `select_workspace` | C6 | handler | unit/config/WorkspaceSession | Narrows the session to a descendant of the startup boundary |

## Contract cases

- **C0 — inventory:** the test fails if any advertised tool lacks an ownership
  entry.
- **C1 — roots:** process/collaboration types, escaped names, and DI plane refs.
- **C2 — semantic export:** event/activity types, sequence-flow labels and
  source/target refs, special characters, shapes, bounds, edges, and waypoints,
  plus the compact export variant.
- **C3 — import:** nested subprocess scope, labels, source/target refs, and
  imported DI from an extension-bearing fixture.
- **C4 — mutation/layout:** update, delete cascade, and horizontal layout.
- **C5 — files:** configured path, persistence, listing, load/import, and delete.
- **C6 — handler surface:** context, event/activity/gateway mutation, connect,
  list/get/update/delete, validation, layout, XML export, and close.
- **C7 — Mermaid:** inline and file conversion followed by live-engine import.
- **C8 — collaboration:** white-box and black-box participant/process refs and
  participant DI.

## Resolved gaps

Every case below was once a `test.todo` placeholder for advertised behavior that
did not work. Each now has an executing assertion named after the case, so the
history stays traceable. They are listed as evidence that the behavior ships,
not as outstanding work.

- **G1 — lanes:** `add_lane` creates `bpmn:LaneSet`/`bpmn:Lane` semantics with
  `flowNodeRef` entries and a lane `BPMNShape` (`addLane` in
  `src/server/handlers.ts`). Covered by *G1 add_lane creates BPMN Lane/LaneSet
  semantics through the handler*. The remaining limit is scope, not
  implementation: lanes are top-level inside a white-box pool, and an imported
  nested lane hierarchy cannot be extended.
- **G2 — SVG:** `export({ format: "svg" })`, `save_svg`, and `save_png` render
  through `src/core/BpmnSvgRenderer.ts`. They need a real browser, so they are
  covered by `tests/integration/svg-export.test.ts` and the Puppeteer renderer
  suite (`npm run test:renderer`) instead of the in-process contract suite.
- **G3 — extensions:** imported `extensionElements` survive mutation and export.
  Covered by *G3 preserves imported extensionElements through mutation and
  export*, which mutates an element of the extension-bearing fixture and
  re-parses the exported XML.
- **G4 — layout algorithms:** the advertised `algorithm` enum contains only
  values that execute; each advertised value succeeds and anything else is
  rejected at request validation. Covered by *G4 advertises only executable
  auto-layout algorithms*. This replaces the earlier C9 case.
- **G5 — validation levels and conditions:** `validate.level` selects the
  `syntax`, `semantic`, or `full` rule set (`handlers.ts` passes it to
  `BpmnValidator`), and `connect.condition` is stored on the model and
  serialized as a `bpmn:conditionExpression` carrying the requested language.
  Covered by *G5 applies validation levels and serializes sequence-flow
  conditions*.
- **G6 — listing metadata:** `listDiagrams()` reports the process ID and name
  from the diagram's own metadata — decoded from the versioned
  `mcp-bpmn-v1_<base64url>.bpmn` placeholder filename, or parsed out of the file
  — and falls back to splitting the filename only for a file it cannot read.
  Covered by *G6 lists exact BPMN metadata from versioned and legacy generated
  filenames*.

## Remaining scope limits

These are deliberate boundaries of the advertised surface, not defects:

- No advertised tool selects a connection type, so handler `connect` always
  requests a sequence flow. Message flows exist in the typed engine and are
  produced by the Mermaid collaboration subset.
- Auto-layout advertises horizontal layout only.
- The Camunda 7 profile covers `assignee`, `candidateGroups`, and `dueDate` on
  user tasks.

## Historical candidate comparison

Earlier revisions of this document carried a fourth column evaluating an
independent, pre-facade `BpmnModdleEngine` candidate at
`HEAD:src/core/BpmnModdleEngine.ts` (`c41e537`). That source exposed only
`createProcess`, `createElement`, `connect`, `exportXml`, `importXml`,
`getProcess`, and `clear`, and could not be passed to `BpmnRequestHandler`
without an adapter because it had no file-path, persistence, mutation, or layout
surface. The comparison ended in the disposition decision below and the file was
then removed from the tree, so the column is no longer reproducible from a
checkout and has been dropped. Recover it from that commit if the decision is
ever revisited.

## Runtime dependency audit (`mcp-bpmn-iqa.3`)

First audited on 2026-08-22 after the engine and layout decisions, and refreshed
for the 0.4.0 release. Every one of the nine direct production dependencies in
`package.json` has a live source ownership path:

| Dependency | Runtime import / ownership path |
| --- | --- |
| `@modelcontextprotocol/sdk` | `src/server/index.ts` creates the MCP server and stdio transport and registers the SDK request schemas. |
| `bpmn-auto-layout` | `src/core/layout/BpmnLayoutAdapter.ts` dynamically loads the selected layout engine behind the subprocess adapter. |
| `bpmn-js` | `src/core/BpmnSvgRenderer.ts` loads `bpmn-js/dist/bpmn-navigated-viewer.production.min.js` into the render page. |
| `bpmn-moddle` | `src/core/BpmnDocument.ts` parses and serializes the canonical document; `src/core/BpmnValidator.ts` parses validation input. |
| `camunda-bpmn-moddle` | `src/core/BpmnDocument.ts` imports `resources/camunda.json` as the moddle descriptor for the opt-in Camunda 7 profile. |
| `puppeteer` | `src/core/BpmnSvgRenderer.ts` launches and drives the headless browser used for SVG/PNG rendering. |
| `uuid` | `src/utils/IdGenerator.ts` generates BPMN identifiers. |
| `zod` | `src/server/tools.ts` defines the runtime tool-input schemas. |
| `zod-to-json-schema` | `src/server/tools.ts` publishes those Zod schemas through the MCP tool contract. |

The dev-only `bpmn-auto-layout-stable` and `yet-another-bpmn-auto-layout`
packages have no production importer at all. They exist solely for the opt-in
comparison matrix in `tests/integration/layout-candidates.test.ts`
(`npm run test:layout-candidates`).

History, so the table above is not misread as unchanged. On 2026-08-22 `bpmn-js`
had no supported runtime caller: its only source import was the zero-reference
`src/lib/bpmn-wrapper.ts`, backed by a local ambient declaration in
`src/types/bpmn-js.d.ts`. That audit removed both files and, at the time, the
direct dependency. The later SVG renderer reintroduced `bpmn-js` with a real
owner, `src/core/BpmnSvgRenderer.ts`, which is the entry in the table above.
Both removed files are gone from the tree today, as are every source and test
artifact listed under the disposition decision below.

The 2026-08-22 snapshot recorded zero known production vulnerabilities while the
installed production graph fell from 130 to 110 packages, with a license scan of
MIT (95), ISC (7), BSD-3-Clause (2), and BSD-2-Clause (1) and no unknown or
copyleft licenses. Those counts predate the renderer dependencies and are not
re-measured here; run `npm run audit:prod` for the current audit. The residual
ownership risks are unchanged: the deliberately pinned
`bpmn-auto-layout@2.0.0-alpha.2` prerelease and the narrow local `bpmn-moddle`
declaration required because `bpmn-moddle@9.0.2` does not publish TypeScript
declarations. Both are isolated at the paths listed above.

## Disposition decision (`mcp-bpmn-uxp`)

Select the bounded cleanup in `mcp-bpmn-h2d`; do not migrate to the independent
moddle candidate. The executable contract above passes for the live engine, but
the candidate (see [Historical candidate
comparison](#historical-candidate-comparison)) had no full engine-owned tool
entry and was missing the persistence, DI, update/delete, layout, collaboration,
and handler surfaces a reversible switch would have to add. The package exports
only the server entry point, and the server constructs `SimpleBpmnEngine`
directly, so there is no published engine subpath that requires a compatibility
facade.

The combined dependency and facade cleanup has removed these source artifacts,
all of which are absent from the tree today:

- `src/core/BpmnEngine.ts`
- `src/core/ProcessBuilder.ts`
- `src/core/ElementFactory.ts`
- `src/core/BpmnModdleEngine.ts`
- `src/utils/PositionCalculator.ts`
- `src/lib/bpmn-wrapper.ts`
- `src/test-example.ts`
- `src/types/bpmn-js.d.ts`

`mcp-bpmn-iqa.4` later removed two more prototype artifacts on the same grounds:
`src/core/LayoutEngine.ts` and `src/utils/AutoLayout.ts`, neither of which had a
production importer. Production delegates all layout to `bpmn-auto-layout`
through `BpmnAutoLayoutV2Adapter`; there is no second layout engine in the tree.

Their dead tests went with them: `tests/mocks/bpmn-js.cjs`,
`tests/integration/BpmnEngine.test.ts` (its useful assertions migrated into the
live contract first) and `tests/unit/utils/PositionCalculator.test.ts` are all
gone, and `jest.config.js` and `tests/README.md` were updated rather than
deleted. The later SVG renderer superseded the planned package removal, so
`package.json` and the lockfiles retain `bpmn-js`.

Keep the live `src/core/SimpleBpmnEngine.ts`, its canonical typed model in
`src/core/BpmnDocument.ts`, `src/core/SimpleBpmnGenerator.ts` (the live Mermaid
conversion path), and `src/types/bpmn-moddle.d.ts`. Keep the direct
`bpmn-moddle` dependency because the live document and validator use it. The
later SVG export implementation also gives the direct `bpmn-js` package a live
runtime owner: `src/core/BpmnSvgRenderer.ts` resolves its production viewer
bundle. Retain that dependency while removing the orphan modeler wrapper and
mock; layout dependencies remain governed by the separate layout decision and
do not imply an engine migration.

A clean build emits JavaScript, declarations, declaration maps, and source maps
for source artifacts solely because `tsconfig.json` includes all of `src/**/*`.
The dependency audit proves the wrapper output disappears after a clean build;
`mcp-bpmn-h2d` owns the same check for its remaining source removals. Test
cleanup is tracked by `mcp-bpmn-grl`, which depends on the selected
implementation bead instead of this decision alone. The unselected reversible
migration branch, `mcp-bpmn-iqa.2`, is superseded by `mcp-bpmn-h2d`.

Rollback has no BPMN data conversion or persisted-file impact: the live engine,
handler wiring, and XML format do not change. Before release, the cleanup can be
reverted as a source/package change; if a supported browser modeler facade is
later required, implement it as new work against an explicit package contract
rather than reviving the incompatible builder. No live engine is deleted on a
first switch because this decision performs no engine switch.
