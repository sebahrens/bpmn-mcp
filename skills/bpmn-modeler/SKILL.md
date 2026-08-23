---
name: bpmn-modeler
description: Create, open, inspect, edit, review, validate, lay out, save, or export BPMN process and collaboration diagrams through an available mcp-bpmn MCP server. Use for requests to model or change a business process, workflow, pool/lane collaboration, BPMN XML, or BPMN/SVG diagram output, including indirect requests that clearly need a BPMN artifact. Do not use for Mermaid-only diagrams, workflow automation code, or conceptual BPMN questions that do not require inspecting or operating on a diagram.
---

# BPMN modeler

Use the tools exposed by the `mcp-bpmn` server. Refer to tools by their semantic names below; the host may display an MCP namespace prefix. Treat each live tool description and input schema as authoritative.

## Route the request

1. Determine whether the requested artifact is a single process or a collaboration.
   - Use a process for one participant's control flow when pools and lanes are unnecessary.
   - Use a collaboration for pools or lanes, and when distinct participants or organizations exchange messages. Model each participant as a pool; use lanes only inside white-box pools.
   - Ask a focused question when participant boundaries, ownership, execution profile, or destructive file intent would materially change the model. Otherwise state a small assumption and proceed.
2. Choose the authoring path.
   - Prefer typed tools for edits, collaborations requiring precise ownership, specialized activity/event types, conditions, lanes, data, annotations, or extension-profile fields.
   - Use `new_from_mermaid` or `open_mermaid_file` only to bootstrap a diagram that fits the supported flowchart subset. Read [references/capabilities.md](references/capabilities.md) before choosing Mermaid.
3. Default to the `portable` extension profile. Use `camunda7` only when the user requests its supported execution metadata. Do not translate unsupported profiles into Camunda 7 or portable fields.

## Operate on the diagram

1. Establish context with `current`, `new_bpmn`, `new_from_mermaid`, `open_bpmn`, or `open_mermaid_file`. If a diagram may already be current, inspect it before switching unless the request clearly authorizes the replacement.
2. For an existing diagram, inspect with `list_elements` and `get_element` before editing. Follow pagination until `hasMore` is false when the complete model matters.
3. Create owners before their contents: collaboration, pools, then pool-owned elements. Create all required elements before relationships. Retain every returned `processId`, `elementId`, `laneId`, `connectionId`, `associationId`, and generated filename; never invent or reconstruct server IDs.
4. In collaborations, pass the returned pool `processId` as `ownerId` and normally `scopeId` for its flow nodes. Connect nodes within one scope as sequence flow and across participants as message flow. Let server validation reject illegal endpoints rather than forcing an approximation.
5. Add lanes only after their flow nodes exist. Add sequence flows, message flows, conditions/defaults, and associations only after both endpoints exist.
6. Run `validate` at meaningful semantic checkpoints, including after the main control-flow skeleton and after substantial edits. Resolve errors before continuing; report warnings that require user judgment.
7. For creation or edit deliverables, apply `auto_layout` near the end, after semantic construction, unless the user asks to preserve manual geometry. It replaces coordinates and autosaves. Run `validate` again at `full` level after layout. Do not mutate a review-only request.
8. Use `export` in the requested `xml` or `svg` format. Report the active BPMN filename returned by the tools, the export format, validation result, and any warnings. For SVG, return or identify the embedded resource/URI; do not claim that a separate SVG file was saved.

## Preserve intent and fidelity

- Successful create and mutation tools autosave the active BPMN file. Do not call `save` after every edit.
- Require explicit user intent before `save_as`, `delete_diagram_file`, or any destructive current-context replacement through a create/open action. Confirm the exact filename before deletion. Read [references/state-and-safety.md](references/state-and-safety.md) for file and mutation semantics.
- `delete_element` cascades incident connections, lane assignment can move nodes, and auto-layout replaces geometry. Inspect affected objects and keep these effects within the requested change.
- Never bypass MCP validation, edit managed diagram files directly, or generate BPMN XML as a substitute for unsupported tool behavior.
- If a requested BPMN construct or execution profile is unsupported, name the gap and offer supported alternatives. Approximate only after the user explicitly accepts the semantic loss.

## References

- Read [references/capabilities.md](references/capabilities.md) when selecting tools, constructs, Mermaid syntax, or an extension profile.
- Read [references/state-and-safety.md](references/state-and-safety.md) before switching diagrams, renaming, saving explicitly, deleting, or coordinating multiple operations.
- Read [references/workflows.md](references/workflows.md) when creating or substantially restructuring a process or collaboration.
- Read [references/evaluation-cases.md](references/evaluation-cases.md) only when evaluating skill activation or workflow compliance.
