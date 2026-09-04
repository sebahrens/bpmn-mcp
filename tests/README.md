# MCP-BPMN Tests

Jest picks up `**/tests/**/*.test.ts` and `**/tests/**/*.spec.ts` (see
`jest.config.js`). Everything below `tests/` is source-level: suites import from
`src/`, not from `dist/`, except the end-to-end suite, which deliberately runs
the compiled server.

`tests/README.md` describes the layout. The contributor command table lives in
[CONTRIBUTING.md](../CONTRIBUTING.md#checks-and-tests) and is not duplicated
here.

## Layout

| Directory | What lives there |
| --- | --- |
| `unit/` | Component-level tests mirroring `src/`: `config/`, `converters/`, `core/`, `layout/`, `utils/`. |
| `integration/` | Behavior across module boundaries: MCP handlers, persistence, layout state, Mermaid conversion, dialect compatibility, tool inventory, and the browser-backed SVG export. |
| `contracts/` | The reviewed public surface: `engine-contract.test.ts` parses exported XML with `bpmn-moddle`; `tool-annotations.test.ts` pins the advertised MCP tool annotations. |
| `security/` | Adversarial input: BPMN import, request validation, resource exhaustion, workspace containment, XML serialization. |
| `property/` | Seeded property/fuzz suites over the real entry points (see below). |
| `performance/` | Large-diagram work and time bounds (see below). |
| `e2e/` | Spawns the compiled MCP server from `dist/` over stdio, with fixture servers under `e2e/fixtures/`. Requires a build first. |
| `helpers/` | Shared test utilities: `tempDiagrams.ts` (isolated diagram directories), `bpmnGeometry.ts` (geometry assertions, itself covered by `bpmnGeometry.test.ts`), `seededRandom.ts` (deterministic generators). |
| `fixtures/` | BPMN documents and layout corpora used as input, including files exported by real modelers under `fixtures/real-tools/`. |
| `mocks/` | `puppeteer.cjs`, the mock browser launcher that keeps source-level suites off a real Chrome. |

`install-agent-integrations.test.sh` sits at the top level: it is a shell suite
for the Make-based client installer, run by `npm run test:installer`, not by
Jest.

## Running them

```bash
npm test            # source-level Jest suites plus the renderer suite
npm run test:unit   # tests/unit only
npm run test:watch  # re-run on change
npm run test:coverage
npm test -- IdGenerator.test.ts   # one file by name

npm run test:evaluations  # integration/agent-evaluations.test.ts on its own:
                          # the agent skill and eval fixtures under evals/
```

`npm test` excludes two paths that need special handling:

- `tests/e2e/` needs compiled output. `npm run test:e2e` cleans, builds, and then
  runs `npm run test:e2e:compiled`; running the compiled suite on a stale `dist/`
  is what `test:e2e` exists to prevent.
- `tests/integration/svg-export.test.ts` needs a real browser. It runs under
  `jest.puppeteer.config.js` through `npm run test:renderer`, which drops the
  puppeteer mock. That requires a downloadable or preinstalled Chrome and a
  machine that can launch it (see the browser download note in the
  [README](../README.md)); `npm run test:contract` runs it alongside the engine
  contract.

`npm run test:all` is the full gate: clean, build, Jest with coverage and the
layout comparison matrix enabled, e2e against the compiled server, renderer,
installer, and the ralph-loop shell tests.

### Opt-in suites

Two suites are skipped unless their environment flag is set, so a normal run
stays fast:

| Flag | Script | Suite |
| --- | --- | --- |
| `MCP_BPMN_LAYOUT_CANDIDATES=1` | `npm run test:layout-candidates` | `integration/layout-candidates.test.ts` compares the shipped layout engine against dev-only alternatives. Included in `npm run test:all`. |
| `MCP_BPMN_PERF=1` | `npm run test:performance` | The 2,000-element benchmark in `performance/large-diagram.performance.test.ts`. The work bounds in that file always run; only the wall-clock benchmark is gated. |

### Property and fuzz suites

`property/` uses `helpers/seededRandom.ts` rather than a fuzzing dependency, so
the generators are deterministic: each suite pins a seed constant and derives a
stream per case, and a CI failure replays exactly from the reported case index.
Inputs go through the real entry points — `MermaidParser.parse`,
`MermaidConverter.convert`, and `SimpleBpmnEngine.importXml`/`exportXml` — and
every artifact is written to a per-run temp directory that is removed afterward.

When a property fails, the suites report an array of offending cases instead of
stopping at the first one, because `expect(value, message)` is not supported by
Jest.

## Writing new tests

1. Put a test next to its peers: component tests in `unit/`, cross-module
   behavior in `integration/`, adversarial input in `security/`, public-surface
   pins in `contracts/`.
2. Never write into the working tree. The server's default diagram directory is
   the launch directory, which during a test run is the checkout itself, so
   construct the engine with an isolated directory or use
   `helpers/tempDiagrams.ts`, and clean up in `afterEach`/`afterAll`.
3. Keep the default `npm test` fast. A suite that is inherently slow belongs
   behind an environment flag with its own npm script, following
   `layout-candidates.test.ts`.
4. Prefer bounding work — element counts, serialized bytes, call counts — over
   wall-clock assertions; a byte count does not flake on a loaded runner.
5. `npm run test:all` enforces the per-file coverage thresholds in
   `jest.config.js`. Nothing is excluded from the coverage report, and an ignore
   entry must never be used to hide a module that still ships.

## Retired wrapper test migration

The deleted `BpmnEngine` suite exercised a pass-through wrapper around
`SimpleBpmnEngine`. Its useful public behavior now has stronger coverage at the
live ownership boundaries:

- `contracts/engine-contract.test.ts` parses exported XML with `bpmn-moddle` to
  verify process/collaboration creation, element and connection semantics,
  labels, DI, formatted and compact exports, imports, and file persistence.
- `integration/handlers.test.ts` verifies MCP-facing results and negative cases,
  including missing elements, handler file operations, and persisted labels.
- Malformed BPMN is rejected without installing partial state instead of being
  accepted as an empty process.

Assertions about wrapper-owned maps and compatibility stubs were implementation
details of removed code. `PositionCalculator` tests were also removed with that
orphan utility; layout behavior is covered through the live layout engine and
adapter suites.
