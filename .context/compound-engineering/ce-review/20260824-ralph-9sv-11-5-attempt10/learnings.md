## Institutional Learnings Search Results

### Search Context

- **Feature/Task**: `mcp-bpmn-9sv.11.5` — add the destructive `update_connection` mutation while preserving connection identity and ensuring validated endpoint rewiring, snapping, revision checks, rollback, and atomic autosave.
- **Keywords Used**: BPMN connection mutation, optimistic revision, atomic rollback, geometry snapping, serialization; broader related terms: connection, revision, rollback, snap, serialization.
- **Files Scanned**: 0 (`docs/solutions/` does not exist in this checkout).
- **Relevant Matches**: 0.

### Critical Patterns (Always Check)

`docs/solutions/patterns/critical-patterns.md` is not present, so there are no repository-level critical patterns to apply from the institutional learning corpus.

### Relevant Learnings

No matching solution documents exist. No prior institutional guidance was available for BPMN connection semantic mutation, optimistic/document revision guards, atomic rollback, waypoint snapping, or serialization.

### Recommendations

- Treat the issue acceptance criteria as the governing safeguards: validate every proposed semantic and endpoint change before mutating the in-memory model or file.
- Keep semantic update, geometry validation/snapping, serialization, autosave, and returned revision within one rollback boundary; failures, including stale expected revisions, must leave both document state and file unchanged.
- Preserve the connection ID and untouched DI/semantics, and make snapping explicit in returned geometry diagnostics rather than silently retaining detached waypoints.
- Add coverage for stale semantic and document revisions, invalid scope/default/condition/direction/type combinations, serialization/autosave failure, rollback, and reopen persistence.
