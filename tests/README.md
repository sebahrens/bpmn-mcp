# MCP-BPMN Tests

## Test Structure

- `unit/` - Unit tests for individual components
  - `utils/` - Tests for utility functions (IdGenerator, FileManager, TypeMappings)
  - Core component tests would go here

- `integration/` - Integration tests
  - Live engine behavior is covered by `contracts/engine-contract.test.ts` and focused core tests
  - `handlers.test.ts` - Tests for MCP request handlers

- `fixtures/` - Test data
  - Sample BPMN files for testing

- `mocks/` - Mock implementations
  - `puppeteer.cjs` - Mock browser launcher for source-level tests

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- IdGenerator.test.ts
```

## Writing New Tests

1. Place unit tests in `tests/unit/`
2. Place integration tests in `tests/integration/`
3. Follow the existing patterns for test structure
4. Use the renderer suite for real browser-backed SVG behavior

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
