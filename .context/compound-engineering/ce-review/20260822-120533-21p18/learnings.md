## Institutional Learnings Search Results

### Search Context

- **Feature/Task**: Review dedicated unit behavior matrices and per-file Jest coverage thresholds for `SimpleBpmnEngine`, `SimpleBpmnGenerator`, `MermaidParser`, `MermaidConverter`, and `FileManager`; assess whether legacy `AutoLayout`/`LayoutEngine` code is dead and should be excluded from coverage claims.
- **Keywords Used**: test, coverage, Jest, BPMN, engine, generator, Mermaid, parser, converter, file manager, layout, dead code, unused code
- **Files Scanned**: 0
- **Relevant Matches**: 0

### Critical Patterns (Always Check)

`docs/solutions/patterns/critical-patterns.md` does not exist because this repository has no `docs/solutions/` directory. No critical institutional patterns were available to apply.

### Relevant Learnings

No relevant learning documents were found.

### Recommendations

- Treat the requested behavior matrices and per-file thresholds as review evidence that must stand on the current tests and configuration; there is no repository learning that validates their completeness.
- Verify coverage claims against executable, imported production paths. Legacy `AutoLayout`/`LayoutEngine` files should not improve the stated coverage story merely by remaining in scope; first determine reachability and intended support, then either test retained behavior or remove/exclude genuinely dead code with an explicit rationale.
- Check that each named module's matrix covers observable success, validation/error, edge-case, and state/side-effect behavior rather than only mapping test names to implementation methods.

### No Matches

The institutional knowledge search could not find candidates because `docs/solutions/` is absent. These recommendations are review heuristics derived from the task scope, not previously documented project learnings.
