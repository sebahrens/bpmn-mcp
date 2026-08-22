# ADR 0001: Portable BPMN with an opt-in Camunda 7 profile

- Status: accepted
- Date: 2026-08-22
- Bead: `mcp-bpmn-9sv.7`

## Decision

MCP-BPMN will support two explicit document profiles:

1. `portable` is the default. Authored XML uses BPMN 2.0 namespaces and
   constructs only. Vendor-only task fields are rejected in this profile; they
   are never accepted and silently omitted.
2. `camunda7` is the only executable extension profile. It uses the Camunda
   Platform 7 namespace `http://camunda.org/schema/1.0/bpmn`, represented by
   `camunda-bpmn-moddle@7.0.1` and tested with `bpmn-moddle@9.0.2`.

The implementation bead `mcp-bpmn-g7s` will add the profile selector and the
following allowlisted fields on `bpmn:UserTask` only:

| API field | Create value | Update value | Camunda 7 XML |
| --- | --- | --- | --- |
| `assignee` | non-empty string | string or `null` to remove | `camunda:assignee` |
| `candidateGroups` | non-empty string array | array or `null` to remove | `camunda:candidateGroups`, comma-separated |
| `dueDate` | non-empty string | string or `null` to remove | `camunda:dueDate` |

The values may contain Camunda expressions. Serialization must XML-escape them;
group entries must reject commas so the typed array has an unambiguous
round-trip. These fields are invalid on other activity types. The API will not
accept namespace names, qualified attribute names, raw XML, or arbitrary
extension maps.

Authored documents default to `portable`; `new_bpmn`, `new_from_mermaid`, and
`open_mermaid_file` will each accept an optional
`extensionProfile: "portable" | "camunda7"`. `open_bpmn` instead detects the
imported profile and does not accept an override. Import binds a document to
`camunda7` only when the parsed model actually uses an attribute or element
whose resolved namespace URI is exactly
`http://camunda.org/schema/1.0/bpmn` **and** the complete document reparses with
the Camunda descriptor without warnings. An unused namespace declaration does
not select a profile. Other foreign namespaces remain opaque; a document that
contains both recognized Camunda 7 content and opaque foreign content is
`camunda7`, with the other content retained but not editable. The detected
profile cannot be overridden during import. All authored/open results and the
`current` tool must report `extensionProfile` so an MCP client can rediscover
the active contract at any point in the stateful workflow.

## Portability and imported extensions

Portable assignment can be represented with BPMN `humanPerformer` and
`potentialOwner`, but there is no portable BPMN due-date field and execution
engines do not agree on assignment-expression conventions. The initial API
therefore does not translate the three executable fields into those core
constructs. This avoids claiming execution semantics that a target engine may
interpret differently.

Unknown imported attributes and `extensionElements` are accepted only when
`bpmn-moddle` parses the document with zero warnings. They remain opaque: the
API does not expose them as editable arbitrary properties and does not infer an
execution profile from them. Existing retained-graph serialization must
preserve them across unrelated mutations, save, and reopen. The guarantee is
semantic, not byte-for-byte; namespace prefixes, attribute ordering, and XML
formatting may be normalized. Imports with parser warnings or unresolved
references remain rejected.

Portable exports authored from scratch contain no vendor namespace or vendor
attributes. A portable modeler may display a Camunda 7 document's BPMN core,
but only Camunda-aware tooling is guaranteed to understand its execution
metadata.

The compatibility guarantee is deliberately parser-scoped: the two fixtures
parse and retain their semantics with the exact package versions below. It is
not a deployment, runtime-execution, or visual-rendering guarantee for any
Camunda Platform or Camunda Modeler release. The `bpmn-moddle` package range in
`package.json` is not itself a tested-version promise; any lockfile upgrade must
rerun the fixture suite before changing the recorded baseline.

## Evidence

The fixtures in `tests/fixtures/dialects/` and
`tests/integration/dialect-compatibility.test.ts` were run on Node 25.9.0 with
these exact parsers:

- `portable-user-task.bpmn`: `bpmn-moddle@9.0.2` imported the BPMN
  `humanPerformer` and `potentialOwner` structures with zero warnings and
  retained them after an unrelated MCP-BPMN mutation. It has no due-date
  representation.
- `camunda7-user-task.bpmn`: `bpmn-moddle@9.0.2` plus
  `camunda-bpmn-moddle@7.0.1` imported `assignee`, `candidateGroups`, and
  `dueDate` as typed Camunda descriptor properties with zero warnings. All
  three survived descriptor serialization and an unrelated MCP-BPMN mutation.
- Core `bpmn-moddle@9.0.2` also imported the Camunda fixture with zero warnings
  and retained the foreign attributes in `$attrs`. This proves the current
  opaque-import path while the property implementation remains a separate
  bead.

Camunda 7 was selected because the repository already names Camunda Modeler as
a consumer, the retired serializer attempted these same three `camunda:*`
attributes, and the official descriptor models all three as direct typed
properties on user-task-like elements. It therefore fits the existing API
shape with one maintained descriptor and less projection logic than Zeebe's
nested extension elements. The evidence establishes a parser target, not a
specific engine deployment requirement.

## Rejected alternatives

- **Portable-only metadata:** rejected because BPMN 2.0 has no portable due
  date and assignment-expression execution is not interoperable enough to back
  the advertised fields.
- **Camunda 8 / Zeebe:** rejected for the first profile. Its stable namespace is
  `http://camunda.org/schema/zeebe/1.0`, but assignment and scheduling use
  nested `zeebe:assignmentDefinition` and `zeebe:taskSchedule` extension
  elements. Supporting `zeebe-bpmn-moddle@1.18.0` would add a second lifecycle
  and different execution semantics without a current target requirement.
- **Flowable / Activiti:** rejected for the first profile. Flowable uses
  `http://flowable.org/bpmn` and similar attributes, while Activiti uses
  `http://activiti.org/bpmn`; namespace and engine-family differences would
  make a shared profile misleading, and there is no maintained official JS
  moddle descriptor in this project.
- **Multi-profile authoring:** rejected until a concrete consumer justifies the
  dependency, fixtures, validation rules, and compatibility promises for each
  additional dialect.

## Compatibility impact

This decision does not itself make the currently advertised arbitrary
`properties` payload executable. `mcp-bpmn-g7s`, which already depends on this
decision, owns the schema, serializer, import projection, add/update/remove,
and portable-mode implementation. Existing imported foreign content continues
to follow the opaque preservation policy above.
