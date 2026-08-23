## Agent-Native Architecture Review

### Summary

PASS. This is an MCP-native server with no separate UI action surface in scope. The change improves agent context parity directly at the capability boundary: every one of the 27 tools carries an explicit standard behavior tuple in `tools/list`, sourced from the same definition that owns its schema and description.

### Assessment

- **Action parity:** 27/27 advertised BPMN capabilities remain directly agent-callable; the change adds no human-only workflow or orphan feature.
- **Context parity:** Agents receive exact `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` values during standard MCP discovery. The exhaustive `ToolName` table prevents a newly added tool from silently lacking a reviewed tuple.
- **Behavior fidelity:** Focused probes cover read-only persistence, repeated idempotent writes, destructive deletion, repeated Mermaid import, and `add_lane` reassignment. The corrected Mermaid and lane classifications expose retry risk that agents need for safe orchestration.
- **Packaged discoverability:** The package smoke test performs a real `tools/list` request against the source executable, optional bundle, and installed tarball executable, then compares names and annotations with the built registry.
- **Shared workspace:** `openWorldHint: false` consistently communicates the configured local diagram store; the README correctly warns that annotations are advisory rather than authorization.

### Findings

No agent-native gaps found in the scoped changes.

### Score

- **27/27 advertised capabilities expose reviewed behavior hints**
- **Verdict:** PASS
