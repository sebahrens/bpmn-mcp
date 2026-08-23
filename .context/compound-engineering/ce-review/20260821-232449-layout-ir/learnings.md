## Institutional Learnings Search Results

### Search Context

- **Feature/Task**: Define and integrate a canonical typed layout IR across Mermaid adaptation, deterministic layout, BPMN generation, and mutable ProcessContext/BpmnDocument adaptation without exposing XML through layout APIs.
- **Keywords Used**: layout, LayoutModel, layout IR, intermediate representation, adapter, Mermaid, BPMN, ProcessContext, BpmnDocument, deterministic, ordering, graph, routing, waypoint, segment, container, ownership, TypeScript, contract, validation, normalization
- **Files Scanned**: 0 solution documents
- **Relevant Matches**: 0 files

### Critical Patterns (Always Check)

No `critical-patterns.md` file exists in the repository. The expected path `docs/solutions/patterns/critical-patterns.md` is absent, and a repository-wide filename search found no alternative critical-patterns document.

### Relevant Learnings

No durable institutional learnings were available. The repository does not contain a `docs/solutions/` directory, so there were no frontmatter candidates to pre-filter, rank, or read for layout IR, adapters, deterministic graph handling, routing, or TypeScript contract patterns.

### Recommendations

- Treat the current bead's implementation and focused tests as the source of truth; there is no documented prior solution to constrain the design.
- Make determinism requirements explicit for cycles, disconnected components, gateway branch ordering, nested containers, and all supported directions because no institutional ordering convention is documented.
- Define one authoritative representation for duplicated geometry such as aggregate edge waypoints versus virtual segments and BPMN node bounds versus container bounds.
- Validate typed boundary inputs structurally and numerically before mutation or serialization, including finite coordinates, positive dimensions, ownership references, container membership, ports, labels, and semantic connectivity.
- Document the chosen adapter invariants and failure-atomic apply behavior in a future `docs/solutions/` entry after the layout work is verified, so subsequent routing and layout beads do not rediscover the same cross-path constraints.

### No Matches

No relevant learnings were found because both the solution knowledge base and critical-patterns index are absent from this repository.
