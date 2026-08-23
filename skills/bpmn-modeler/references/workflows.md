# Representative workflows

These examples show ordering and ID flow, not complete tool schemas. Check each live schema before invoking a tool.

## Typed single-process workflow

Request: create an approval process with a decision and two outcomes.

1. Call `new_bpmn` with type `process` and the selected extension profile. Retain its `processId` and filename.
2. Add a start event, the review activity, an exclusive gateway, the approved/rejected activities, and end event(s). Retain each returned `elementId`.
3. Connect only with returned IDs. Add labels or formal conditions to decision branches if the request defines them; make a default branch only when intended.
4. Run `validate` at `semantic` or `full` level. Fix ownership, connectivity, event, or conditional-flow errors before styling or delivery.
5. Add supported data objects, annotations, or activity properties if required. Validate again after any semantic change.
6. Call `auto_layout` once the structure is stable, then call `validate` at `full` level.
7. Call `export` in the requested format. Report the validation summary and the active BPMN filename returned by the server.

There is no need to call `save` between steps: every successful mutation has already autosaved.

## Typed collaboration workflow

Request: model messages between a customer and a fulfillment team, with fulfillment lanes.

1. Call `new_bpmn` with type `collaboration`. Retain the collaboration ID and filename.
2. Call `add_pool` for each participant. Decide explicitly whether each is white-box or black-box. Retain each pool `elementId`; for every white-box pool also retain its returned `processId`.
3. Create flow nodes inside each white-box pool. Pass that pool's returned `processId` as `ownerId` and normally `scopeId`. A black-box pool has no process for internal elements.
4. After all relevant nodes exist, add lanes to white-box pools using returned pool and flow-node IDs. Remember that assigning an existing node moves it from its former lane.
5. Connect same-process, same-scope flow nodes to form sequence flows. Connect legal endpoints in different participant processes, or a supported participant endpoint, to form message flows. Do not make sequence flows cross pool or nested-scope boundaries.
6. Run `validate` at a semantic checkpoint. Resolve owner, scope, endpoint, and collaboration errors.
7. Finish remaining details, call `auto_layout`, and run `validate` at `full` level. Review layout warnings, especially for pools, lanes, and message-flow routing.
8. Call `export` and report the active BPMN filename, format, validation result, and warnings.

## Mermaid collaboration bootstrap

Use this only when the user's collaboration fits the supported Mermaid subset:

1. Represent each participant as one non-nested subgraph and put every node inside exactly one subgraph.
2. Use supported nodes and connectors only. Cross-subgraph edges become message flows; internal edges become sequence flows.
3. Call `new_from_mermaid` and retain the returned IDs, filename, and conversion warnings.
4. Inspect the converted result with `list_elements` and `get_element`. Use typed tools for any refinements Mermaid cannot express.
5. Validate the converted semantics, apply `auto_layout` only if further edits disturbed layout, validate again, and export.

If participant ownership, task/event type, lane assignment, branch semantics, or execution metadata matters, skip Mermaid and use the typed collaboration workflow.

## Existing-diagram review or edit

1. Resolve the exact file with `list_diagrams` when needed, then call `open_bpmn`.
2. Record `current` metadata and paginate through `list_elements`; use `get_element` for affected nodes and relationships.
3. For review-only requests, run `validate` at the requested level and report issues without mutating or laying out the diagram.
4. For edits, make only the requested typed mutations, using discovered IDs. Validate after the semantic edit, then auto-layout only if requested or needed for the requested deliverable.
5. Validate after layout and export/report the result. Do not use `save_as` unless the user explicitly asks for a new active filename.
