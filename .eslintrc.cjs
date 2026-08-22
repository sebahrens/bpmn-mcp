module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  // These recommended rules currently conflict with established source and
  // fixture patterns. Keep the initial lint rollout focused and non-disruptive.
  rules: {
    'no-regex-spaces': 'off',
    'no-useless-escape': 'off',
    'prefer-const': 'off',
  },
  ignorePatterns: [
    'coverage/',
    'dist/',
    'node_modules/',
    '.beads/',
    '.context/',
    'tests/fixtures/lint/invalid.ts',
  ],
  overrides: [
    {
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        // Type-aware checks belong to `npm run type-check`; keeping ESLint
        // project-free lets the same command lint src and tests.
        project: false,
      },
      plugins: ['@typescript-eslint'],
      extends: ['plugin:@typescript-eslint/recommended'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-expressions': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            caughtErrors: 'none',
            varsIgnorePattern: '^_',
          },
        ],
        'prefer-const': 'off',
      },
    },
    {
      files: ['tests/**/*.{ts,js,cjs,mjs}'],
      env: {
        jest: true,
      },
    },
    {
      files: ['tests/**/*.{js,cjs,mjs}'],
      rules: {
        'no-unused-vars': ['error', { args: 'none' }],
      },
    },
  ],
};
