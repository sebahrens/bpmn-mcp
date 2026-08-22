# Changelog

Notable changes to this project are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with the
pre-1.0 policy described in [CONTRIBUTING.md](CONTRIBUTING.md#versioning-changelog-and-releases).

## Unreleased

No changes have been assigned to a release yet.

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
