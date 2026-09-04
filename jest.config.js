/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^puppeteer$': '<rootDir>/tests/mocks/puppeteer.cjs',
  },
  transform: {
    '^.+\\.m?tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'esnext',
          target: 'es2022',
          isolatedModules: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(bpmn-moddle|moddle|moddle-xml|min-dash|min-dom|tiny-svg)/)',
  ],
  testMatch: [
    '**/tests/**/*.test.ts',
    '**/tests/**/*.spec.ts',
  ],
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/mermaid-2-bpmn/',
    '/tests/integration/svg-export.test.ts',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  // Nothing is excluded from coverage. The two layout barrels that used to be
  // listed here were deleted with the dead re-export layer (mcp-bpmn-iqa.5),
  // and an ignore entry must never be used to hide a module that still ships.
  coveragePathIgnorePatterns: [],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // These thresholds are deliberately scoped to production-reachable modules
  // covered by mcp-bpmn-21p. Nothing is excluded from the report, so a floor
  // here always describes shipping code.
  coverageThreshold: {
    // The MCP request surface is the contract agents actually call. Floors sit a
    // few points under the measured numbers so an unrelated refactor does not
    // fail the gate, while a real regression still does. `npm run check` and CI
    // enforce them through `npm run test:all`, which now collects coverage.
    './src/server/tools.ts': {
      statements: 60,
      branches: 33,
      functions: 85,
      lines: 58,
    },
    './src/server/handlers.ts': {
      statements: 90,
      branches: 78,
      functions: 92,
      lines: 90,
    },
    './src/core/SimpleBpmnEngine.ts': {
      statements: 60,
      branches: 60,
      functions: 65,
      lines: 60,
    },
    './src/core/SimpleBpmnGenerator.ts': {
      statements: 80,
      branches: 65,
      functions: 85,
      lines: 80,
    },
    // Eleven of the validator's rules had no test at all (mcp-bpmn-5e7.6), which
    // is how a cross-scope false positive shipped. Every rule now has a
    // triggering case and a legal twin; this floor keeps a newly added rule from
    // arriving unexercised. Measured 94.69/87.37/100/94.71.
    './src/core/BpmnValidator.ts': {
      statements: 90,
      branches: 82,
      functions: 95,
      lines: 90,
    },
    './src/converters/MermaidParser.ts': {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
    './src/converters/MermaidConverter.ts': {
      statements: 80,
      branches: 50,
      functions: 85,
      lines: 85,
    },
    './src/utils/FileManager.ts': {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70,
    },
  },
};
