import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolNames, tools } from '../../src/server/tools.js';

/**
 * `npm run test:package` is the only gate that used to compare the README tool
 * inventory and the reviewed MCP wire contract against the advertised tools, and
 * it only runs after a full pack/install cycle. This suite runs the same checks
 * in-process so `npm test` catches the drift immediately.
 */

const projectRoot = process.cwd();
const readme = readFileSync(resolve(projectRoot, 'README.md'), 'utf8');
const toolContract = JSON.parse(
  readFileSync(resolve(projectRoot, 'scripts/tool-contract.json'), 'utf8')
) as {
  toolNames: string[];
  contractFingerprint: string;
  schemaFingerprints: Record<string, { input: string; output: string }>;
};

const REFRESH_COMMAND = 'npm run contract:update';

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeSchema(child)])
  );
}

function schemaFingerprint(schema: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSchema(schema)))
    .digest('hex');
}

describe('advertised tool inventory', () => {
  it('documents every advertised tool under its own README heading, in order', () => {
    const documentedToolNames = [...readme.matchAll(/^#### `([^`]+)`$/gm)]
      .map(([, name]) => name);

    // A combined heading such as "#### `save_svg` and `save_png`" documents two
    // tools but matches neither name, which is exactly how the inventory silently
    // fell out of date. Each tool therefore needs its own heading.
    expect(documentedToolNames).toEqual([...toolNames]);
  });

  it('keeps the reviewed tool contract in step with the advertised tools', () => {
    expect({
      names: toolContract.toolNames,
      hint: REFRESH_COMMAND
    }).toEqual({ names: [...toolNames], hint: REFRESH_COMMAND });

    expect({
      fingerprints: toolContract.schemaFingerprints,
      hint: REFRESH_COMMAND
    }).toEqual({
      fingerprints: Object.fromEntries(tools.map(tool => [
        tool.name,
        {
          input: schemaFingerprint(tool.inputSchema),
          output: schemaFingerprint(tool.outputSchema)
        }
      ])),
      hint: REFRESH_COMMAND
    });

    expect({
      fingerprint: toolContract.contractFingerprint,
      hint: REFRESH_COMMAND
    }).toEqual({
      fingerprint: schemaFingerprint(tools.map(tool => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema
      }))),
      hint: REFRESH_COMMAND
    });
  });
});
