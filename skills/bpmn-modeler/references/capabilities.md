# Supported capabilities

This is a routing guide, not a copy of the API. Use the live MCP tool schemas for arguments, defaults, limits, and result fields.

## Tool families

The server exposes these semantic tool families:

| Purpose | Tools |
| --- | --- |
| Select a workspace | `get_workspace`, `select_workspace` |
| Establish or change context | `new_bpmn`, `new_from_mermaid`, `open_bpmn`, `open_mermaid_file`, `close`, `current` |
| Persist and locate files | `save`, `save_as`, `save_svg`, `save_png`, `list_diagrams`, `delete_diagram_file`, `get_diagrams_path` |
| Create BPMN content | `add_event`, `add_activity`, `add_gateway`, `add_data_object`, `add_text_annotation`, `add_pool`, `add_lane` |
| Relate BPMN content | `connect`, `add_association` |
| Inspect | `list_elements`, `get_element`, `list_connections`, `get_connection` |
| Edit semantics | `update_element`, `update_connection`, `delete_element` |
| Inspect or edit geometry | `analyze_geometry`, `update_element_geometry`, `update_connection_geometry`, `apply_geometry_patch`, `route_connection`, `auto_layout` |
| Check and deliver | `validate`, `export` |

Host applications may prefix these names. Select the exposed tool whose base semantic name matches; do not encode a host-specific prefix in instructions or examples.

## Typed BPMN subset

| Area | Supported authoring surface |
| --- | --- |
| Roots | Process and collaboration |
| Collaboration | White-box or black-box pools; top-level lanes in white-box pools; message flows between legal cross-participant endpoints |
| Activities | Task, user, service, script, business-rule, manual, receive, and send tasks; expanded/collapsed subprocess, transaction, and call activity |
| Gateways | Exclusive, parallel, inclusive, event-based, and complex |
| Events | Start, end, intermediate throw/catch, and attached boundary events |
| Event definitions | Message, timer, error, signal, conditional, escalation, compensation, cancel, and terminate, subject to BPMN-legal event combinations |
| Data and artifacts | Data object references with backing data objects; text annotations; directed or undirected associations |
| Flow semantics | Sequence and message flows; labels; formal conditions; activity/gateway default flows |
| Structure | Pool ownership, process/subprocess scope, boundary attachment, lane membership, and multi-instance activity characteristics |
| Inspection | Paginated stable-order listings plus element, lane, association, and connection detail |
| Output | BPMN XML and rendered SVG export; managed SVG/PNG artifacts; syntax, semantic, and full validation; deterministic horizontal layout |

The server, not this guide, decides whether a specific event definition, endpoint pair, scope, property, or default/conditional flow combination is BPMN-legal.

For an existing relationship, use `get_connection` before `update_connection` and carry its `semanticRevision` into `expectedSemanticRevision`. Rewiring either endpoint also requires the explicit `snap-to-boundary` endpoint policy so the server can preserve endpoint geometry invariants. If the revision is stale, refresh the connection, reassess the requested mutation, and retry against the new semantic revision rather than overwriting blindly.

For a local edge obstruction, use `route_connection` before replacing geometry
by hand. It proposes without mutation by default and returns an
`apply_geometry_patch`-compatible patch. Inspect its score and diagnostics,
then apply that patch or repeat with explicit avoid lists and clearance. Use
`apply: true` only when the proposal may be selected and committed atomically.

## Extension profiles

- `portable` is the default. It authors BPMN 2.0 constructs without vendor attributes.
- `camunda7` is the only editable vendor profile. Its typed user-task fields are assignee, candidate groups, and due date.
- Portable multi-instance loop characteristics are supported. Expression bodies are preserved as opaque text and are not executed by the server.
- `open_bpmn` detects the imported profile. Unknown imported extensions may be retained opaquely when the parser accepts them, but the typed tools do not make them editable.
- Camunda 8/Zeebe, Flowable, Activiti, and arbitrary namespace-qualified properties or raw extension XML are not authoring profiles.

Do not imply runtime-engine compatibility from successful parsing or export. Ask for the intended engine/profile when execution metadata is material.

## Mermaid bootstrap subset

Use Mermaid only when its compact syntax reduces work without losing requested BPMN meaning.

Supported input is a `graph` or `flowchart` (or recognizable declaration-less flowchart) with direction `TD`, `TB`, `LR`, `RL`, or `BT`. It supports:

- word-like node IDs;
- ordinary task nodes, exclusive decisions, subprocess-shaped nodes, data-object nodes, and terminator-shaped event nodes;
- `-->` and `-.->` edges with optional labels; dotted styling is not retained;
- one level of non-nested subgraphs.

Start/end labels and endpoint position can infer start and end events. Other terminator nodes become intermediate throw events. Without subgraphs the result is a process. With subgraphs, each subgraph becomes a white-box pool, every node must belong to one subgraph, internal edges become sequence flows, and cross-subgraph edges become message flows.

Use typed tools instead when the request needs activity subtypes, non-exclusive gateways, event definitions, boundary attachment, conditions/default flows, lanes, black-box pools, annotations/associations, multi-instance settings, or Camunda 7 user-task fields. Mermaid directives, CSS classes, and edge styles can be ignored with warnings; nested subgraphs and unsupported diagram syntax fail. A data-object node cannot be a sequence/message-flow endpoint.

## Unsupported or non-editable areas

The authoring surface does not cover every BPMN 2.0 construct. In particular, do not silently stand in choreography or conversation diagrams, data stores, groups, signals/messages as free-standing modeled artifacts, arbitrary extension elements, or an unlisted event/activity type with a vaguely similar supported shape. Do not use plain Mermaid output as a substitute when the user asked for BPMN.

When a gap appears:

1. State the unsupported construct or profile precisely.
2. Explain the semantic loss of the closest supported representation.
3. Offer to model only the supported portion or an explicitly labeled approximation.
4. Continue only if the user accepts that tradeoff.
