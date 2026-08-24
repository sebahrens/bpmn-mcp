PASS — no agent-native parity findings in the selected prerelease artifact/check changes.

The shared `snapshotReleaseArtifact` path is used by the package smoke and by both the Codex and Claude plugin validators, so both client lifecycles now copy, verify, and consume the same caller-supplied release candidate before installation or extraction. Digest-only input fails closed in the shared JavaScript path and in the installer before `npm pack`, with focused coverage for both implementations.

Codex and Claude retain the same high-priority agent capabilities: both receive the canonical `bpmn-modeler` skill from the release artifact, both discover one `mcp-bpmn` server backed by that artifact, both execute a state-changing `new_bpmn` workflow against an isolated external diagram store, and the deterministic evaluation check continues to feed both adapters identical prompts and semantic expectations. The client-specific lifecycle differences are appropriate platform mechanics rather than capability gaps: Codex validates marketplace/cache discovery and write-approval annotations, while Claude validates native plugin discovery plus reload/disable/enable/uninstall persistence. The WSL2 release procedure passes the same tarball and SHA-256 to the installer and to both plugin checks and explicitly requires both artifact-backed MCP adapters.

Score: 4/4 selected high-priority parity capabilities retained. Verdict: PASS.

Verification: `git diff --check` passed; `tests/integration/release-artifact.test.ts` and `tests/integration/agent-evaluations.test.ts` passed (10 tests total). Review was limited to the requested package/plugin validators, installer artifact inputs, workflow validation, and related tests/docs; unrelated dirty review artifacts were excluded.
