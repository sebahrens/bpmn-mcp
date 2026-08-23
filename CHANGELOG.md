# Changelog

Notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the
pre-1.0 policy described in [CONTRIBUTING.md](CONTRIBUTING.md#versioning-changelog-and-releases).

## Unreleased

No version has been assigned to these changes. The package-facing entries in
this section are traceable to
[`eab3fb6`](https://github.com/oisee/mcp-bpmn/commit/eab3fb68735b998c3e358c0636a3fdf7d709675a).

### Added

- Replaced the legacy string-template engine with a typed, moddle-backed BPMN
  document model that preserves imported semantics and diagram interchange
  data through later edits and XML export.
- Added modeled support for collaborations, participants, lanes, nested
  subprocesses, boundary and typed events, conditional/default flows, data
  objects, text annotations, associations, multi-instance activities, and
  portable or Camunda 7 extension profiles.
- Added deterministic automatic layout for authored and Mermaid-derived
  diagrams, plus browser-backed `bpmn-js` SVG export.
- Added syntax, semantic, and full BPMN validation levels and expanded contract,
  security, unit, integration, renderer, and end-to-end coverage.

### Changed

- MCP tool arguments are now validated against strict, bounded schemas before
  dispatch. Invalid, unknown, oversized, non-finite, or out-of-range values
  that were previously passed to handlers are rejected without mutating the
  active diagram.
- The public tool surface now includes `add_data_object`,
  `add_text_annotation`, and `add_association`. Existing lane,
  event-definition, flow-condition, and collaboration parameters now affect
  serialized BPMN instead of being ignored or reported as unimplemented.
- `new_bpmn`, `new_from_mermaid`, and `open_mermaid_file` now accept an
  `extensionProfile` of `portable` (the default) or `camunda7`.
- **Compatibility:** `list_elements` now returns a pagination envelope with an
  `elements` field instead of a bare array. `list_diagrams` retains its existing
  `count`, `diagrams`, and `path` fields while adding pagination metadata and
  returning only the requested page. Clients must follow `hasMore`, `offset`,
  and `limit` when reading either listing.
- **Compatibility:** `add_lane` now requires a non-empty, unique `flowNodeIds`
  array naming the pool-process nodes assigned to the new lane.
- Diagram mutations use transactional persistence with rollback, and query
  results use deterministic bounded pagination where listings can grow large.
- Mermaid conversion now uses documented flowchart semantics, preserves labels
  and scoped ownership, and reports structured conversion diagnostics.
- The supported runtime baseline is Node.js 22.12.0. Contributor and CI checks
  now cover type-checking, linting, a clean build, all test suites, packed
  package entry points, and production dependency auditing.
- The published server executable now resolves to `dist/server/index.js`, the
  packed-file allowlist excludes development-only files, startup no longer
  depends on Node's experimental specifier-resolution flag, and the MCP server
  reports the version from `package.json` instead of a separate hard-coded
  value.

### Fixed

- Corrected XML serialization, process ownership and flow scope, BPMN type
  fallbacks, imported extension round-tripping, layout state synchronization,
  and autosave consistency across mutation paths.

### Security

- Added strict request and property-payload validation, bounded BPMN/Mermaid
  imports and renderer/layout work, XML injection protection, safe diagram-file
  containment, no-clobber writes, and production dependency audit gates.

### Developer tooling

- Added Beads-backed project task tracking and agent workflow instructions
  ([`b65d269`](https://github.com/oisee/mcp-bpmn/commit/b65d269ce23dedb419420d023c45696f2d473f32)).
- Added an opt-in Ralph implementation loop with filtered agent output,
  timeouts, and reliable process-tree interruption
  ([`c41e537`](https://github.com/oisee/mcp-bpmn/commit/c41e537154e54d1b0e4704d85f062df63580c78d)).

## Untagged repository history

This repository currently has no Git tags. Although `package.json` declares
version `0.2.0`, there is no matching tag from which trustworthy release notes
can be reconstructed, so this changelog does not invent a `0.2.0` release.

The following development milestones are traceable to commits, but are not
presented as releases:

- 2025-06-22: Refactored BPMN tool calls and their tests
  ([`fcab559`](https://github.com/oisee/mcp-bpmn/commit/fcab5592654a8d668c6c787f2a05e0e11bc094f2)).
- 2025-06-22: Added Mermaid parsing and Mermaid-to-BPMN conversion
  ([`d08010a`](https://github.com/oisee/mcp-bpmn/commit/d08010a57bb57a57bb8307aa2a11746c3d5b0994)).
- 2025-06-22: Added the implementation guide
  ([`3863408`](https://github.com/oisee/mcp-bpmn/commit/3863408a4541e3e8e58e1b164e41034b3b6f3381)).
- 2025-06-21: Added and refined automatic process layout
  ([`149c84e`](https://github.com/oisee/mcp-bpmn/commit/149c84eda4ae845014d10dfabc34dfc126a8fbe4),
  [`b081d5e`](https://github.com/oisee/mcp-bpmn/commit/b081d5e2a199327cff7dd128ada01d8b249c735b),
  [`15bf9e9`](https://github.com/oisee/mcp-bpmn/commit/15bf9e96e92e3109966e1f24de82bd62b689610e)).
- 2025-06-21: Introduced the direct XML `SimpleBpmnEngine`
  ([`2eefd6e`](https://github.com/oisee/mcp-bpmn/commit/2eefd6eb9af09a73ec33028ac9dd20b841c60ec3)).
- 2025-06-21: Added diagram file-management operations
  ([`0cd835f`](https://github.com/oisee/mcp-bpmn/commit/0cd835fb19184b23b10b668649d44bd69d99ee9c)).
- 2025-06-21: Added the initial unit, integration, and end-to-end test suites
  ([`6e573d2`](https://github.com/oisee/mcp-bpmn/commit/6e573d247265dd6494dcbe6818ce223802435db0),
  [`2293506`](https://github.com/oisee/mcp-bpmn/commit/2293506d5be58a05ad924eb21e3fec2776ccbb28)).

When maintainers create the first release tag, they will replace or supersede
this historical summary with a dated, tagged release entry.
