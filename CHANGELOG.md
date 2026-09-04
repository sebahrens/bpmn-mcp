# Changelog

Notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the
pre-1.0 policy described in [CONTRIBUTING.md](CONTRIBUTING.md#versioning-changelog-and-releases).

## Unreleased

No changes since 0.3.0.

## 0.3.0 - 2026-09-04

First versioned entry in this changelog. `package.json`,
`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and the lockfiles all
declare `0.3.0`; the maintainer creates the matching `v0.3.0` tag when the
release is published. Under the pre-1.0 policy in
[CONTRIBUTING.md](CONTRIBUTING.md#versioning-changelog-and-releases) the two
compatibility breaks marked below make this a minor bump rather than a patch.

The package-facing entries are traceable to
[`eab3fb6`](https://github.com/oisee/mcp-bpmn/commit/eab3fb68735b998c3e358c0636a3fdf7d709675a),
[`cc5a2ab`](https://github.com/oisee/mcp-bpmn/commit/cc5a2ab),
[`3a1c4dd`](https://github.com/oisee/mcp-bpmn/commit/3a1c4dd),
[`7de9175`](https://github.com/oisee/mcp-bpmn/commit/7de9175),
[`bf470cc`](https://github.com/oisee/mcp-bpmn/commit/bf470cc), and
[`bb8fc1b`](https://github.com/oisee/mcp-bpmn/commit/bb8fc1b).

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
- Added connection inspection and editing: `list_connections` (filtered,
  paginated, stable ID order), `get_connection`, and `update_connection`, which
  rewires endpoints, labels, conditions, default ownership, and association
  direction while preserving the connection ID.
- Added BPMN DI geometry tools: `update_element_geometry`,
  `update_connection_geometry`, `apply_geometry_patch`, `route_connection`, and
  `analyze_geometry`. They enforce containment and incident-edge policy, reject
  newly introduced collisions by default, support compare-and-set bounds,
  waypoints, and geometry revisions, and support dry runs. `route_connection`
  proposes ranked collision-free orthogonal routes without mutating by default.
- Added rendered-artifact persistence: `save_svg` and `save_png` write a
  separate sanitized SVG or rasterized PNG into the managed workspace without
  changing the diagram's XML, revision, or active `.bpmn` filename.
- Added explicit workspace resolution: `get_workspace` reports the client launch
  cwd, immutable startup boundary, active workspace, and selection source;
  `select_workspace` narrows the session to a relative descendant and closes the
  active diagram when the workspace changes. A repository `.mcp-bpmn.json` with a
  relative `path` configures the workspace; dot segments, absolute paths, and
  symlink traversal are rejected.
- Added Codex and Claude Code integration: a Make-based installer with
  `install`, `update`, `doctor`, and `uninstall` lifecycles, an
  `mcp-bpmn-server` executable, a plugin server shim, `.codex-plugin` and
  `.claude-plugin` manifests, the `bpmn-modeler` skill, and the
  `npm run test:installer` shell suite that exercises them.

### Changed

- MCP tool arguments are now validated against strict, bounded schemas before
  dispatch. Invalid, unknown, oversized, non-finite, or out-of-range values
  that were previously passed to handlers are rejected without mutating the
  active diagram.
- The public tool surface now includes `add_data_object`,
  `add_text_annotation`, `add_association`, `list_connections`,
  `get_connection`, `update_connection`, `update_element_geometry`,
  `update_connection_geometry`, `apply_geometry_patch`, `route_connection`,
  `analyze_geometry`, `save_svg`, `save_png`, `get_workspace`, and
  `select_workspace`, for 39 advertised tools in total. Existing lane,
  event-definition, flow-condition, and collaboration parameters now affect
  serialized BPMN instead of being ignored or reported as unimplemented.
- **Compatibility:** `update_connection` requires either `expectedRevision` or
  `expectedSemanticRevision`. A call that supplies neither is rejected during
  request validation and does not mutate the diagram.
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
- SVG and PNG rendering no longer fails wherever the server runs as root.
  Chrome is launched with `--no-sandbox --disable-setuid-sandbox` under uid 0,
  `MCP_BPMN_BROWSER_ARGS` overrides the launch arguments anywhere else the
  sandbox cannot start, and the launch diagnostic now names that variable
  instead of blaming a missing browser.

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
- The reviewed MCP wire contract moved into `scripts/tool-contract.json`, which
  `npm run test:package` and an in-process suite check against the advertised
  tools and the README tool inventory. Regenerate it with
  `npm run contract:update` and review the diff.
- `npm run test:all` now collects coverage, so the configured thresholds are
  enforced by `npm run check` and CI instead of being advisory, and thresholds
  were added for the MCP request surface.
- CI sets `MCP_BPMN_BROWSER_ARGS` so the renderer, e2e, and package suites can
  launch Chrome on the hosted runner images.

## Untagged repository history

The commits below predate 0.3.0 and were never released under a Git tag. No
`0.2.0` release is reconstructed for them: `package.json` carried that version
without a matching tag, so there is no artifact those notes could describe.

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

These milestones are superseded by the 0.3.0 entry above; they remain listed
only as commit-level provenance for work that predates it.
