## Agent-Native Architecture Review

### Summary

This is an MCP BPMN editor rather than a UI application, so MCP tool metadata is the agent-facing integration and there is no server-side LLM system prompt to inspect. The retained-document workflow is broadly agent-accessible in the same diagrams directory and shared `DiagramContext`: agents can discover files, open BPMN, inspect typed elements, mutate them, save, and export the complete XML for verification. No parity regression was found in the bead's lossless import/export path. One pre-existing tool contract prevents an agent from reliably creating a conditional sequence flow even though the tool schema advertises that input.

### Capability Map

| UI Action | Location | Agent Tool | In Prompt? | Priority | Status |
|---|---|---|---|---|---|
| Open an imported BPMN document | `src/server/handlers.ts:140-154` | `open_bpmn` | N/A — MCP schema/description | Must have | Accessible; installs the same engine context used by subsequent mutations |
| Discover available BPMN documents | `src/server/handlers.ts:580-594` | `list_diagrams` | N/A — MCP schema/description | Should have | Accessible; returns filenames and shared diagrams path |
| Inspect imported typed elements | `src/server/handlers.ts:430-489` | `list_elements`, `get_element` | N/A — MCP schema/description | Must have | Accessible |
| Inspect retained extensions, conditions, lanes, labels, and DI | `src/server/handlers.ts:523-541` | `export` | N/A — MCP schema/description | Must have | Accessible through complete BPMN XML |
| Add/update/delete imported typed elements | `src/server/handlers.ts:274-353,492-520` | `add_event`, `add_activity`, `add_gateway`, `update_element`, `delete_element` | N/A — MCP schema/description | Must have | Accessible |
| Create a conditional sequence flow | `src/server/handlers.ts:355-374` | `connect` | N/A — MCP schema/description | Must have | Blocked: accepted `condition` input is silently discarded |
| Save or verify an imported document | `src/server/handlers.ts:192-229,523-541` | `save`, `save_as`, `export` | N/A — MCP schema/description | Must have | Accessible |

### Findings

#### Critical (Must Fix)

None in the lossless imported-document open/update/export path.

#### Warnings (Should Fix)

1. **`connect.condition` is an accepted but non-functional agent input** -- `src/server/tools.ts:249-252`, `src/server/handlers.ts:355-374` -- The tool schema describes a condition expression, but the handler calls `engine.connect` without it and only writes a console message saying it will be added in a future version. The success response omits that omission. An agent can therefore request a conditional flow, receive an apparent success, and export XML with no condition expression. This is a pre-existing limitation, but it is directly relevant to retained condition semantics. Recommendation: either persist `condition` as a typed sequence-flow property and serialize it as `conditionExpression`, returning the created connection details, or remove the input from the public MCP schema until the operation is supported.

#### Observations

1. **No dynamic system prompt is present by design** -- `src/server/index.ts:1-64` exposes an MCP server rather than an embedded LLM runtime. The tool schemas and responses provide discoverability, and `list_diagrams`, `current`, `list_elements`, and `export` give agents runtime state. No change is required for this architecture.
2. **Full retained semantics are inspectable as XML, not a structured query model** -- `src/server/handlers.ts:430-489,523-541`. This is sufficient for the bead's preservation contract, but agent consumers must parse `export` output to reason about lanes, extension elements, conditions, and DI because `list_elements` intentionally exposes only the typed mutation index.

### What's Working Well

- `open_bpmn` loads into the same `SimpleBpmnEngine` and singleton `DiagramContext` consumed by every mutation handler, rather than an agent-only copy (`src/server/handlers.ts:140-145`).
- Agents can enumerate files before opening them, and the response includes the shared diagrams path (`src/server/handlers.ts:580-594`).
- `export` returns the complete serialized BPMN XML, giving an agent a direct verification primitive for retained semantic and DI content (`src/server/handlers.ts:523-541`).
- Mutations are exposed as composable primitives rather than a special "preserve import" workflow; the retained serializer is invoked through ordinary update/add/delete/save operations.

### Score

- **5/6 high-priority retained-document capabilities are agent-accessible** (the exception is creating a condition through the advertised `connect.condition` input).
- **Verdict:** NEEDS WORK
