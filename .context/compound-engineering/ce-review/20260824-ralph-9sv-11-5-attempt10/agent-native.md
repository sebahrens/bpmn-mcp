## Agent-Native Architecture Review

### Scope and triage

Reviewed Bead `mcp-bpmn-9sv.11.5` only: the new `update_connection` MCP
semantic mutation, its adjacent connection inspection contracts, documentation,
and focused tests. This is an MCP-first BPMN editor, so the MCP client/tool
surface is the user and agent action surface; there is no separate browser UI
action to map. Agent integration is real: the server advertises live tool
schemas and instructions, and the installed `bpmn-modeler` skill directs the
agent to those tools.

The implementation is a sound composable primitive, not a workflow wrapper.
It accepts raw semantic fields and endpoint IDs, leaves the agent to choose
what to change, and confines its own logic to BPMN validity, compare-and-set,
geometry attachment, diagnostics, and atomic persistence. It supports
SequenceFlow, MessageFlow, and Association through one shared operation.

### Capability Map

| User/MCP action | Location | Agent Tool | In Prompt/Skill? | Priority | Status |
|---|---|---|---|---|---|
| Inspect a connection and obtain its semantic revision before a change | `src/server/handlers.ts` connection query projection | `list_connections`, `get_connection` | Server tells clients listings are paginated, but the skill tells agents to inspect only elements | Must have | Partial |
| Change a connection label, condition, default ownership, association direction, or legal endpoint without replacing its ID | `src/server/tools.ts:1209`, `src/core/SimpleBpmnEngine.ts:1092` | `update_connection` | Live MCP description is clear; installed capability routing does not list the tool | Must have | Partial |
| Verify an update, detect a concurrent edit, and recover | `src/server/handlers.ts:1010`, output schema in `src/server/tools.ts` | `update_connection`, then `get_connection` if needed | Live output is structured; no skill workflow explains the revision/verification loop | Must have | Partial |

### Findings

#### Critical (Must Fix)

None.

#### Warnings (Should Fix)

1. **The installed agent routing guide hides the new connection mutation and its required inspection/revision workflow** -- `skills/bpmn-modeler/SKILL.md:24`, `skills/bpmn-modeler/references/capabilities.md:7-16` -- The skill instructs an agent editing an existing diagram to inspect only with `list_elements`/`get_element`. Its tool-family table still says there are 27 tools and omits `list_connections`, `get_connection`, `update_connection`, and the geometry tools, despite the server now advertising them. A tool-list-aware host can eventually discover `update_connection`, but an activated skill is the main capability map and creates context starvation for a core mutation: the agent is not taught to fetch `semanticRevision`, preserve an ID, use `snap-to-boundary` for rewiring, or inspect/retry on conflict. Recommendation: update the skill and capability reference with a concise “connection edit” loop: `get_connection` (or a complete `list_connections` page) -> call `update_connection` with the returned `semanticRevision` -> inspect the result/diagnostics and, after rewiring or a conflict, refresh with `get_connection`. State which fields apply to each of the three connection types and that endpoint changes need explicit snapping.

#### Observations

1. **Rewiring success is verifiable, but not self-contained** -- `src/server/handlers.ts:1016-1028`, `src/core/SimpleBpmnEngine.ts:1230-1270` -- An endpoint update safely snaps and validates BPMNEdge waypoints, but the semantic mutation result returns only semantic `before`/`after`, revisions, and diagnostics. It omits the resulting `waypoints` and `geometryRevision`, so an agent that must prove the new attachment needs a follow-up `get_connection`. This meets the stated semantic-output contract and is not a blocker; consider including a compact `geometry` before/after projection (or at least resulting `geometryRevision` plus waypoints when endpoints changed) to make mutation verification one round trip.

### What's Working Well

- `update_connection` is directly discoverable through the live MCP tool list and has a specific description, strict schema, destructive-update annotation, and structured output. Its input exposes data rather than a higher-level business decision (`src/server/tools.ts:1209-1256`).
- The primitive preserves composability: label, condition, default ownership, direction, and source/target IDs are explicit fields; type/scope/default-flow invariants are enforcement rather than hidden orchestration (`src/core/SimpleBpmnEngine.ts:1130-1228`).
- The output supports agent verification and recovery: it returns semantic before/after states, geometry diagnostics, introduced diagnostics, filename, and document revisions (`src/server/handlers.ts:1010-1028`). Semantic CAS conflicts are structured with a refresh/retry recovery message.
- Endpoint rewiring shares the active diagram model and autosave transaction. It updates the connection and its BPMNEdge in the same candidate state, snaps both boundary points, validates before/after geometry, and commits atomically (`src/core/SimpleBpmnEngine.ts:1230-1272`). This is shared-workspace behavior, not an agent-only side channel.
- Focused integration coverage exercises SequenceFlow semantic/default/endpoint changes, MessageFlow endpoint changes, Association direction changes, stale semantic revisions, rejected scopes, persistence rollback, and reopen behavior (`tests/integration/handlers.test.ts:980-1190`, `tests/integration/persistence.test.ts:210-244`).

### Score

- **3/3 high-priority capabilities are agent-accessible through the live MCP surface.**
- **Verdict: NEEDS WORK** -- The implementation preserves action/context/shared-workspace parity, but the packaged agent skill must advertise and teach the new core connection-editing capability so agents can reliably select it and supply its required semantic revision.
