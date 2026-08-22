import baseConfig from './jest.config.js';

const moduleNameMapper = { ...baseConfig.moduleNameMapper };
delete moduleNameMapper['^puppeteer$'];

export default {
  ...baseConfig,
  moduleNameMapper,
  testMatch: ['**/tests/integration/svg-export.test.ts'],
  testPathIgnorePatterns: baseConfig.testPathIgnorePatterns.filter(
    pattern => pattern !== '/tests/integration/svg-export.test.ts'
  ),
  maxWorkers: 1,
};
