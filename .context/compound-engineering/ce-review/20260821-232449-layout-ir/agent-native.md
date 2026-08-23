## Agent-Native Architecture Review

### Summary

This is an MCP-first BPMN server: agent integration exists through the tool registry in `src/server/tools.ts`, and handlers operate on the same current `ProcessContext` and persisted BPMN files as direct engine callers. The new canonical layout IR, however, stops at the TypeScript engine boundary. Agents can trigger Mermaid conversion and the legacy `auto_layout` workflow, but they cannot discover, inspect, validate, or apply the new `LayoutModel`; conversion handlers also discard the structured geometry and warnings that would let an agent verify the result. The feature therefore lacks agent parity and context parity within the selected bead's layout scope.

### Capability Map

| User/Library Action | Location | Agent Tool | In Tool Discovery? | Priority | Status |
|---|---|---|---|---|---|
| Convert Mermaid through the new layout path | `src/converters/MermaidConverter.ts:67` | `new_from_mermaid`, `open_mermaid_file` | Yes | Must have | Partial: action exists, layout and warnings are hidden |
| Read canonical layout for a mutable document | `src/core/SimpleBpmnEngine.ts:422` | None | No | Must have | Missing |
| Apply canonical layout to a mutable document | `src/core/SimpleBpmnEngine.ts:429` | None | No | Must have | Missing |
| Validate layout IDs/connectivity/segments | `src/core/layout/LayoutModel.ts:284` | None (`validate` checks BPMN semantics only) | No | Must have | Missing |
| Trigger automatic layout | `src/core/SimpleBpmnEngine.ts:407` | `auto_layout` | Yes, `src/server/tools.ts:419` | Must have | Partial: bypasses the canonical IR surface |
| Inspect nodes, ownership, and basic bounds | `src/server/handlers.ts:433` | `list_elements`, `get_element` | Yes | Should have | Partial: no edges, containers, labels, ports, segments, direction, or layout warnings |
| Verify Mermaid conversion diagnostics | `src/core/SimpleBpmnGenerator.ts:184` | None in conversion response | No | Should have | Missing |

### Findings

#### Critical (Must Fix)

1. **Canonical layout APIs are orphaned from MCP** -- `src/core/SimpleBpmnEngine.ts:422` -- The bead adds public `getLayoutModel` and `applyLayoutModel` capabilities for the live mutable path, but `BpmnRequestHandler.handleRequest` has no corresponding cases and `src/server/tools.ts` advertises no layout read/apply primitives. A direct TypeScript caller can inspect and modify direction, containers, ports, waypoints, virtual segments, labels, and warnings; an MCP agent cannot perform any of those actions. This is the central agent-parity gap for the new feature. Fix: add composable `get_layout` and `apply_layout` tools (or equivalent resource/tool pair) using the JSON-safe normalized model, expose validation errors before mutation, and document stable semantic-ID behavior in their tool descriptions.

#### Warnings (Should Fix)

1. **Mermaid tools hide layout results and diagnostics** -- `src/server/handlers.ts:121` -- `new_from_mermaid` and `open_mermaid_file` consume `ConversionResult.layout` and structured layout warnings internally, then return only node/flow counts. The agent cannot see whether pools, labels, ownership, waypoints, or warnings survived conversion, even though a direct converter caller receives that context. Recommendation: include warnings and a compact normalized layout summary in the tool result, with an opt-in detail mode or separate `get_layout` call for the complete IR.

2. **`auto_layout` bypasses the new canonical capability** -- `src/server/handlers.ts:623` -- The existing tool still calls `SimpleBpmnEngine.applyAutoLayout`, which uses the legacy `AutoLayout` path, rather than composing `getLayoutModel`, routing/layout, validation, and `applyLayoutModel`. The response reports only counts and cannot surface IR validation errors or routing warnings. An agent invoking the advertised layout action therefore does not exercise the canonical contract introduced by this bead. Recommendation: route the handler through the canonical layout pipeline and return direction, normalized bounds, warning codes, and validation status sufficient to verify the mutation.

3. **Existing query tools provide incomplete layout context** -- `src/server/handlers.ts:451` -- `list_elements` and `get_element` expose element position and size, but omit connection waypoints, containers and their hierarchy, labels, ports, virtual segments, diagram bounds, direction, and layout warnings. Raw XML is available through `export`, but it cannot represent all IR concepts and forces the agent to reconstruct relationships the server already knows. Recommendation: make `get_layout` the authoritative structured read primitive and keep element queries as lightweight semantic projections.

### Observations

1. `normalizeLayoutModel` already provides the deterministic, array-based representation suitable for MCP JSON. Raw `LayoutModel` contains `Map` objects and should not be returned directly from a tool because standard JSON serialization empties them.

2. There is no separate server-side system prompt; discoverability depends on the MCP tool registry and its descriptions. New layout nouns such as semantic IDs, containers, ports, segments, direction, and warnings must therefore be explained in tool descriptions or an MCP resource.

3. A single full-model `apply_layout` mutation is still a useful primitive if it validates atomically and returns a post-apply normalized snapshot. The agent should choose geometry; the tool should enforce structural invariants and persistence.

### What's Working Well

- Mermaid creation is already agent-accessible and operates on the same current diagram and persisted files as the mutable engine path.
- Existing mutation, save, export, and element-query tools share `diagramContext`, so there is no separate agent sandbox.
- Stable semantic IDs and normalized ordering are good foundations for agent-readable results once exposed through MCP.

### Score

- **1/5 high-priority canonical layout capabilities are fully agent-accessible**
- **Verdict:** NEEDS WORK
