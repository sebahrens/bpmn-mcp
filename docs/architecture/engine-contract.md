# BPMN engine contract and candidate support matrix

This document is the parity baseline for `mcp-bpmn-iqa.1`. It describes the
observable contract advertised by `src/server/tools.ts`, the ownership boundary
in `src/server/handlers.ts`, and the support available from the live
`SimpleBpmnEngine` and the independent, pre-facade `BpmnModdleEngine` candidate.

The executable contract is
`tests/contracts/engine-contract.test.ts`. XML assertions parse with
`bpmn-moddle` and inspect `$type` plus object references such as `sourceRef`,
`targetRef`, `processRef`, and BPMN DI `bpmnElement`; string fragments are not
used as semantic evidence. The import fixtures live in
`tests/fixtures/engine-contract/`.

## Status legend

- **Full**: the advertised behavior has executable contract coverage.
- **Partial**: a useful semantic subset exists, but advertised behavior or
  integration requirements are missing.
- **Handler**: state, conversion, validation, or file behavior is owned by the
  request handler rather than by an engine method.
- **None**: the candidate has no usable implementation for the tool.
- **Gap**: advertised live behavior is intentionally not treated as parity.

## Advertised tool matrix

The candidate column evaluates the independent implementation at
`HEAD:src/core/BpmnModdleEngine.ts` (`c41e537`), before the uncommitted facade
replacement in the current workspace. That source exposes only
`createProcess`, `createElement`, `connect`, `exportXml`, `importXml`,
`getProcess`, and `clear`; it cannot be passed to `BpmnRequestHandler` without
an adapter because it lacks the file-path, persistence, mutation, and layout
surface.

| Tool | Contract / owner | Live `SimpleBpmnEngine` | Independent `BpmnModdleEngine` candidate |
|---|---|---|---|
| `new_bpmn` | C1, engine root + handler context | Full: typed process/collaboration and root DI | Partial: typed root, but no persistence or DI |
| `new_from_mermaid` | C7, converter then engine import | Full for the converter's supported Mermaid subset | Partial direct import; no handler-compatible engine surface |
| `open_bpmn` | C5, engine file load/import | Full inside configured diagram root | None: no file API |
| `open_mermaid_file` | C7, handler file read + converter + import | Full inside configured diagram root | Partial direct import; no handler-compatible engine surface |
| `save` | C6, handler/FileManager | Handler; overwrites the current filename | None as an integrated candidate: no diagram path API |
| `save_as` | C6, handler/FileManager | Handler; writes and updates context filename | None as an integrated candidate: no diagram path API |
| `close` | C6, handler context | Handler | Handler in principle, but candidate cannot construct the live handler |
| `current` | C6, handler context | Handler | Handler in principle, but candidate cannot construct the live handler |
| `add_event` | C2/C6, mapping + engine mutation | Full for advertised event types and supported definitions | Partial: flat event creation; event refs/properties and DI are incomplete |
| `add_activity` | C2/C6, mapping + engine mutation | Full for advertised semantic types; selected properties only | Partial: flat creation with no hierarchy, DI, persistence, or safe property model |
| `add_gateway` | C6, mapping + engine mutation | Full for advertised semantic types | Partial: flat creation with no DI/persistence |
| `add_text_annotation` | C2, engine artifact + optional association mutation | Full for text, format, DI, and optional association | Partial: flat artifact creation with no DI/persistence |
| `connect` | C2/C6, engine sequence flow | Full for typed sequence-flow refs and labels | Partial: flat sequence-flow refs and labels; no DI, condition, or scope rules |
| `add_pool` | C8, engine collaboration mutation | Full for white-box/black-box participant refs and DI | None: treats participant as collaboration `flowElements`, with no process ownership/DI |
| `add_lane` | G1 | Gap: handler returns “not implemented” | None |
| `list_elements` | C6, handler context projection | Handler | Partial handler behavior over candidate's flat maps only |
| `get_element` | C6, handler context projection | Handler | Partial handler behavior over candidate's flat maps only |
| `update_element` | C4/C6, engine mutation | Full for name and supported properties | None |
| `delete_element` | C4/C6, engine mutation/cascade | Full, including incident connections and nested ownership | None |
| `export` | C2/C3/C6, engine XML export | Full XML with typed semantics/refs/DI; SVG is G2 | Partial XML semantics; no DI or SVG |
| `validate` | C6/G5, handler checks | Handler; basic graph checks only | Same handler logic could inspect flat maps, but candidate cannot construct live handler |
| `auto_layout` | C4/C6/C9, engine mutation | Full for the advertised horizontal layout | None |
| `list_diagrams` | C5/G6, engine persistence | Partial: files are listed, but generated process IDs are misparsed | None |
| `delete_diagram_file` | C5, engine persistence | Full inside configured diagram root | None |
| `get_diagrams_path` | C5, engine configuration | Full | None |

## Contract cases

- **C0 — inventory:** the test fails if any advertised tool lacks an ownership
  entry.
- **C1 — roots:** process/collaboration types, escaped names, and DI plane refs.
- **C2 — semantic export:** event/activity types, sequence-flow labels and
  source/target refs, special characters, shapes, bounds, edges, and waypoints.
- **C3 — import:** nested subprocess scope, labels, source/target refs, and
  imported DI from an extension-bearing fixture.
- **C4 — mutation/layout:** update, delete cascade, and horizontal layout.
- **C5 — files:** configured path, persistence, listing, load/import, and delete;
  metadata identity is tracked separately by G6.
- **C6 — handler surface:** context, event/activity/gateway mutation, connect,
  list/get/update/delete, validation, layout, XML export, and close.
- **C7 — Mermaid:** inline and file conversion followed by live-engine import.
- **C8 — collaboration:** white-box and black-box participant/process refs and
  participant DI.
- **C9 — layout contract parity:** every advertised layout algorithm succeeds
  and reports its direction; unsupported values reject at request validation.

## Known gaps — not parity

The executable suite uses `test.todo` for these requirements rather than
asserting the current error or data loss as correct behavior:

- **G1:** `add_lane` is advertised but always returns an implementation error.
- **G2:** `export(format: "svg")` is advertised but always returns an
  implementation error.
- **G3:** unknown/custom `extensionElements` import without a parse warning but
  are dropped when the typed document is serialized after import or mutation.
- **G5:** `validate.level` is ignored, and `connect.condition` is logged but is
  not stored in the model or emitted as a BPMN condition expression.
- **G6:** `listDiagrams()` splits a generated filename such as
  `Process_1_Name.bpmn` at the first underscore and reports `processId` as
  `Process` rather than `Process_1`.
- Message flows exist in the typed engine but no advertised tool selects a
  connection type, so handler `connect` always requests a sequence flow.

These gaps must remain visible in any deletion/facade/migration decision. A
candidate is not at parity merely because it can create flat semantic elements
and serialize well-formed XML.

## Runtime dependency audit (`mcp-bpmn-iqa.3`)

Audited on 2026-08-22 after the engine and layout decisions. Every retained
direct production dependency has a live source ownership path:

| Dependency | Runtime import / ownership path |
| --- | --- |
| `@modelcontextprotocol/sdk` | `src/server/index.ts` creates the MCP server and stdio transport and registers the SDK request schemas. |
| `bpmn-auto-layout` | `src/core/layout/BpmnLayoutAdapter.ts` dynamically loads the selected layout engine behind the subprocess adapter. |
| `bpmn-moddle` | `src/core/BpmnDocument.ts` parses and serializes the canonical document; `src/core/BpmnValidator.ts` parses validation input. |
| `uuid` | `src/utils/IdGenerator.ts` generates BPMN identifiers. |
| `zod` | `src/server/tools.ts` defines the runtime tool-input schemas. |
| `zod-to-json-schema` | `src/server/tools.ts` publishes those Zod schemas through the MCP tool contract. |

`bpmn-js` had no supported runtime caller: its only source import was the
zero-reference `src/lib/bpmn-wrapper.ts`, backed by a local ambient declaration
in `src/types/bpmn-js.d.ts`. This audit removes both files and the direct
dependency. A clean install also removes its `diagram-js` and browser/modeler
transitive tree. The test mock and dead-facade test cleanup remain with
`mcp-bpmn-grl`; the other facade/builder source artifacts remain with
`mcp-bpmn-h2d`.

The production audit remained at zero known vulnerabilities while the installed
production graph fell from 130 to 110 packages. The production license scan
reported MIT (95), ISC (7), BSD-3-Clause (2), and BSD-2-Clause (1), with no
unknown or copyleft licenses. Residual ownership risks are the deliberately
pinned `bpmn-auto-layout@2.0.0-alpha.2` prerelease and the narrow local
`bpmn-moddle` declaration required because `bpmn-moddle@9.0.2` does not publish
TypeScript declarations. Both are isolated at the paths listed above.

## Disposition decision (`mcp-bpmn-uxp`)

Select the bounded cleanup in `mcp-bpmn-h2d`; do not migrate to the independent
moddle candidate. The executable contract above passes for the live engine, but
the candidate column has no full engine-owned tool entry and is missing the
persistence, DI, update/delete, layout, collaboration, and handler surfaces a
reversible switch would have to add. The package exports only the server entry
point, and the server constructs `SimpleBpmnEngine` directly, so there is no
published engine subpath that requires a compatibility facade.

The combined dependency and facade cleanup must remove these source artifacts:

- `src/core/BpmnEngine.ts`
- `src/core/ProcessBuilder.ts`
- `src/core/ElementFactory.ts`
- `src/core/BpmnModdleEngine.ts`
- `src/utils/PositionCalculator.ts`
- `src/lib/bpmn-wrapper.ts`
- `src/test-example.ts`
- `src/types/bpmn-js.d.ts`

The dependency audit owns `src/lib/bpmn-wrapper.ts` and
`src/types/bpmn-js.d.ts`. The facade cleanup owns the other source artifacts
above. It must also remove
`tests/mocks/bpmn-js.cjs` after migrating useful assertions
from `tests/integration/BpmnEngine.test.ts` into the live contract and deleting
that dead-facade test. `tests/unit/utils/PositionCalculator.test.ts` is deleted
with its implementation. Update (do not delete) `jest.config.js` to remove the
two mappings to that mock and `tests/README.md` to remove the dead suite/setup
guidance. The later SVG renderer supersedes the planned package removal, so
`package.json` and `package-lock.json` retain `bpmn-js`.

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
