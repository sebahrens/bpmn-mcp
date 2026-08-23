## Institutional Learnings Search Results

### Search Context

- **Feature/Task**: Bead `mcp-bpmn-9sv.3` retained imported BPMN graph reconciliation: moddle import/serialization, lossless round-trips, atomic state changes, and BPMN DI preservation.
- **Keywords Used**: `bpmn`, `moddle`, `round-trip`, `serialization`, `import`, `atomic`, `transaction`, `diagram interchange`, `DI`, `retain`, `preserve`.
- **Files Scanned**: 0 solution documents.
- **Relevant Matches**: 0.

### Critical Patterns (Always Check)

`docs/solutions/` does not exist in this checkout, and no `critical-patterns.md` was found under `docs/`. There are therefore no recorded critical patterns to apply.

### Relevant Learnings

No institutional-learning documents are available for this repository. The only BPMN-related documentation found outside the required solutions knowledge base was not treated as a historical solution for this pass.

### Recommendations

- Treat the existing rich import-roundtrip fixture as the current executable specification; extend it for add, connect, delete, repeated mutation, multiple diagrams, and unsupported-but-valid moddle constructs.
- After this work is settled, record the chosen retained-graph ownership and atomic-save invariants in `docs/solutions/` so later changes do not reintroduce graph or DI loss.

### No Matches

No relevant past solutions were found because the repository has no `docs/solutions/` knowledge base.
