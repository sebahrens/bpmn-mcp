import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Keeps `tests/README.md` describing the test tree that actually exists
 * (mcp-bpmn-5e7.14). The previous README documented `unit/utils/` and a "core
 * component tests would go here" placeholder long after `security/`,
 * `contracts/`, `e2e/`, `helpers/`, the renderer suite and the compiled e2e
 * path had shipped, so a contributor reading it looked for suites in the wrong
 * places. Drift is only visible if something checks, so this suite is that
 * check.
 */
const root = process.cwd();
const testsDirectory = join(root, 'tests');
const readme = readFileSync(join(testsDirectory, 'README.md'), 'utf8');
const contributing = readFileSync(join(root, 'CONTRIBUTING.md'), 'utf8');

/** README text with fenced code blocks removed, so only prose claims are read. */
const prose = readme.replace(/```[\s\S]*?```/g, '');

/** Inline `code` spans in the prose. */
const inlineTokens = Array.from(prose.matchAll(/`([^`\n]+)`/g), match => match[1]);

const DOCUMENTABLE_EXTENSIONS = new Set(['ts', 'js', 'cjs', 'mjs', 'sh', 'md', 'json']);

function listFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFilesUnder(entryPath));
    } else {
      found.push(entryPath);
    }
  }
  return found;
}

describe('tests/README.md describes the real test tree', () => {
  it('documents every directory directly under tests/', () => {
    const directories = readdirSync(testsDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);

    const undocumented = directories.filter(name => !readme.includes(`\`${name}/\``));

    expect(undocumented).toEqual([]);
  });

  it('references only files that exist', () => {
    const allTestFiles = listFilesUnder(testsDirectory);
    const offenders: string[] = [];

    for (const token of inlineTokens) {
      if (!/^[\w./-]+\.[a-z]+$/.test(token)) continue;
      const extension = token.slice(token.lastIndexOf('.') + 1);
      if (!DOCUMENTABLE_EXTENSIONS.has(extension)) continue;

      const resolvesDirectly = existsSync(resolve(root, token))
        || existsSync(resolve(testsDirectory, token));
      const resolvesBySuffix = allTestFiles.some(file => file.endsWith(`/${token}`));
      if (!resolvesDirectly && !resolvesBySuffix) offenders.push(token);
    }

    expect(offenders).toEqual([]);
  });

  it('names every environment flag that gates a suite', () => {
    const gates = new Set<string>();
    for (const file of listFilesUnder(testsDirectory)) {
      if (!file.endsWith('.test.ts')) continue;
      const source = readFileSync(file, 'utf8');
      for (const [, flag] of source.matchAll(/process\.env\.(MCP_BPMN_[A-Z_]+)\s*===\s*'1'/g)) {
        gates.add(flag);
      }
    }

    // A gated suite that nobody documents is a suite that never runs.
    const undocumented = Array.from(gates).filter(flag => !readme.includes(flag)).sort();

    expect(gates.size).toBeGreaterThan(0);
    expect(undocumented).toEqual([]);
  });

  it('documents every npm script that runs Jest', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const scripts: Record<string, string> = packageJson.scripts;
    const jestScripts = Object.entries(scripts)
      .filter(([, command]) => /\bjest\b/.test(command))
      .map(([name]) => name);

    const undocumented = jestScripts
      .filter(name => !readme.includes(name) && !contributing.includes(name))
      .sort();

    expect(undocumented).toEqual([]);
  });

  it('links the contributor command table instead of duplicating it', () => {
    expect(readme).toContain('CONTRIBUTING.md#checks-and-tests');
    expect(contributing).toContain('## Checks and tests');
  });

  it('no longer claims core component tests are missing', () => {
    const coreTests = readdirSync(join(testsDirectory, 'unit', 'core'));

    expect(coreTests.length).toBeGreaterThan(0);
    expect(readme).not.toContain('would go here');
    expect(statSync(join(testsDirectory, 'unit', 'core')).isDirectory()).toBe(true);
  });
});
