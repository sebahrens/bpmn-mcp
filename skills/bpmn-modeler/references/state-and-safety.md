# State, autosave, and safety

## One current diagram

One server instance has one current diagram shared by its tool calls. Creation and open tools set that current diagram; `close` clears it. Use `current` whenever the active context is not established by the immediately preceding call.

Creating or opening another diagram replaces the in-memory current context. Successful prior mutations are already persisted, and `close` does not delete the saved file, but switching can still make later edits target the wrong diagram. Do not interleave workflows for multiple diagrams on one server instance. Before an unexpected switch, report the active filename and obtain explicit intent.

For an existing file workflow, use `list_diagrams` if the filename is unknown, `open_bpmn` to make it current, then `list_elements`/`get_element` to rediscover IDs. Never carry IDs from a different current diagram.

## Autosave and failure behavior

New and converted diagrams receive a BPMN filename and are written when created. Every successful model mutation—including add, update, delete, lane assignment, relationship creation, and auto-layout—serializes and atomically saves the active BPMN file before committing the new in-memory state. A failed mutation leaves the previous model and file state active.

Consequences:

- Do not call `save` after each mutation. It explicitly rewrites the active file but adds no checkpoint beyond autosave.
- `save_as` writes the current model to a new named file and makes that filename active; it does not delete the former file. Use it only when the user explicitly asks for that new active filename.
- `export` is read-only. XML is returned as text; SVG is returned as an embedded resource. Export does not create a second diagram file.
- `save_svg` and `save_png` render the current snapshot into separate managed artifacts. They do not change diagram XML, revision, or the active BPMN filename; an existing artifact is replaced only with `overwrite: true`.
- `auto_layout` is a mutation: it replaces current coordinates and autosaves them.

## Explicit-intent operations

| Operation | Required guard |
| --- | --- |
| Create/open while another diagram is current | The request must clearly authorize switching/replacement; otherwise inspect `current` and ask. |
| `save_as` | Confirm the intended new filename and that changing the active filename matches the request. Do not invent a filename when naming is material. |
| `save_svg` / `save_png` with `overwrite: true` | Confirm the exact artifact filename and explicit replacement intent. Without overwrite, an existing artifact is preserved. |
| `delete_diagram_file` | Require an exact filename and explicit deletion intent. Use `list_diagrams` to resolve ambiguity. Report whether deleting it also closed the current diagram. |
| `delete_element` | Inspect the element/connection first. Tell the user when deleting an element will cascade incident connections. |
| `add_lane` with existing assignments | Remember that assigning a flow node moves it out of its previous lane. Do not treat lane assignment as additive-only. |
| `auto_layout` | Apply near the end because it replaces manual geometry. Preserve manual layout when the user requests it. |

Do not infer deletion from requests such as “clean up,” “start over,” or “remove clutter.” Clarify the exact target and effect. A clearly worded request such as “delete `draft.bpmn`” or “save this as `approved.bpmn`” already supplies intent; do not add redundant confirmation unless the resolved target conflicts with current state.

## File boundaries

Use only MCP file tools for managed diagrams. Filenames are resolved within the configured diagrams directory and checked by the server. Do not bypass those checks with shell/file tools, do not edit serialized BPMN behind the active context, and do not claim a filesystem path unless `get_diagrams_path` or a tool result returned it.

After completion, report the active BPMN filename from the latest structured result. If `export` returned SVG, identify its resource/URI without presenting it as a saved file. If `save_svg` or `save_png` succeeded, report the separate managed artifact filename.
