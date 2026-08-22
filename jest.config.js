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
  coveragePathIgnorePatterns: [
    '<rootDir>/src/core/LayoutEngine.ts',
    '<rootDir>/src/core/layout/index.ts',
    '<rootDir>/src/core/layout/adapters/index.ts',
    '<rootDir>/src/utils/AutoLayout.ts',
    '<rootDir>/src/utils/AutoLayoutEnhanced.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  // These thresholds are deliberately scoped to production-reachable modules
  // covered by mcp-bpmn-21p. Unreachable legacy modules are ignored above so
  // their direct characterization tests cannot inflate the aggregate report.
  coverageThreshold: {
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
