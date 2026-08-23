import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const projectRoot = process.cwd();
const fixturePath = join(projectRoot, 'evals', 'bpmn-modeler', 'cases.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

function usage() {
  return [
    'Usage: node scripts/run-agent-evals.mjs --client codex|claude [--case <id>] [--dry-run]',
    '',
    'Model runs are opt-in. Each run uses a temporary workspace and an isolated',
    'MCP_BPMN_DIAGRAMS_PATH; normal CI should use --dry-run.'
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') parsed.dryRun = true;
    else if (argument === '--client') parsed.client = argv[++index];
    else if (argument === '--case') parsed.caseId = argv[++index];
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function selectedCases(caseId) {
  if (!caseId) return fixture.cases;
  const selected = fixture.cases.filter(testCase => testCase.id === caseId);
  if (selected.length !== 1) throw new Error(`Unknown evaluation case: ${caseId}`);
  return selected;
}

function adapterPlan(client, cases) {
  return {
    schemaVersion: fixture.schemaVersion,
    client,
    skill: fixture.skill,
    cases: cases.map(testCase => ({
      id: testCase.id,
      tags: testCase.tags,
      prompt: testCase.prompt,
      setup: testCase.setup ?? null,
      expectedSemanticSteps: testCase.expect.semanticSteps,
      expected: testCase.expect
    }))
  };
}

function prepareDiagramStore(root, cases) {
  const diagrams = join(root, 'diagrams');
  mkdirSync(diagrams, { recursive: true });
  for (const testCase of cases) {
    for (const file of testCase.setup?.files ?? []) {
      const source = resolve(projectRoot, file.source);
      const target = resolve(diagrams, file.target);
      if (!source.startsWith(`${resolve(projectRoot)}/`) || !target.startsWith(`${resolve(diagrams)}/`)) {
        throw new Error(`Evaluation setup path escapes its allowed root: ${testCase.id}`);
      }
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
  }
  return diagrams;
}

function criterionText(testCase) {
  const expected = testCase.expect;
  const toolSequence = expected.orderedTools
    .map(group => group.length === 1 ? group[0] : `one or more of: ${group.join(', ')}`)
    .join(' -> ');
  return [
    '# Grading criteria',
    '',
    'Grade the complete response and tool trace, not exact prose. Award a pass only when every applicable condition holds.',
    '',
    `- Activation: ${expected.activation}.`,
    `- Expected semantic steps, in order: ${expected.semanticSteps.join(' -> ')}.`,
    `- Ordered tool sequence: ${toolSequence || 'no BPMN tool calls expected'}.`,
    `- Required tools: ${expected.requiredTools.join(', ') || 'none'}.`,
    `- Forbidden tools: ${expected.forbiddenTools.join(', ') || 'none'}.`,
    `- Final response meaning: ${expected.finalMustMention.join('; ')}.`,
    `- Final response patterns (case-insensitive): ${expected.finalMustMatch.join('; ')}.`,
    expected.minimumToolCalls
      ? `- Minimum tool call counts: ${Object.entries(expected.minimumToolCalls).map(([name, count]) => `${name}=${count}`).join(', ')}.`
      : '',
    '- Tool namespace prefixes are client-specific and must be ignored when comparing semantic tool names.',
    '- Do not award credit for inventing IDs, fabricating unsupported behavior, mutating a review-only request, or claiming a file/resource that the tool did not return.'
  ].filter(Boolean).join('\n');
}

function runClaude(cases) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-claude-evals-'));
  try {
    const pluginRoot = join(temporaryRoot, 'plugin');
    const diagrams = prepareDiagramStore(temporaryRoot, cases);
    for (const path of ['.claude-plugin', 'skills', 'dist', 'package.json']) {
      cpSync(join(projectRoot, path), join(pluginRoot, path), { recursive: true });
    }
    symlinkSync(join(projectRoot, 'node_modules'), join(pluginRoot, 'node_modules'), 'dir');
    for (const testCase of cases) {
      const caseRoot = join(pluginRoot, 'evals', 'bpmn-modeler', testCase.id);
      mkdirSync(join(caseRoot, 'graders'), { recursive: true });
      writeFileSync(join(caseRoot, 'prompt.md'), `${testCase.prompt}\n`);
      writeFileSync(join(caseRoot, 'graders', 'criteria.md'), `${criterionText(testCase)}\n`);
    }

    const args = [
      'plugin', 'eval', pluginRoot,
      '--no-publish', '--runs', '1', '--threshold', '1',
      '--allow-tools', 'mcp__mcp-bpmn__*'
    ];
    execFileSync('claude', args, {
      cwd: temporaryRoot,
      env: { ...process.env, MCP_BPMN_DIAGRAMS_PATH: diagrams },
      stdio: 'inherit'
    });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function normalizeToolName(rawName) {
  if (typeof rawName !== 'string') return undefined;
  const segments = rawName.split('__');
  return segments[segments.length - 1];
}

function toolCallsFromCodexJsonl(output) {
  const calls = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'item.completed' || event.item?.type !== 'mcp_tool_call') continue;
    const name = normalizeToolName(event.item.tool ?? event.item.name);
    if (name) calls.push(name);
  }
  return calls;
}

function assertCodexResult(testCase, calls, finalResponse) {
  const expected = testCase.expect;
  for (const tool of expected.requiredTools) {
    if (!calls.includes(tool)) throw new Error(`${testCase.id}: required tool not called: ${tool}`);
  }
  for (const tool of expected.forbiddenTools) {
    if (calls.includes(tool)) throw new Error(`${testCase.id}: forbidden tool called: ${tool}`);
  }
  for (const [tool, minimum] of Object.entries(expected.minimumToolCalls ?? {})) {
    const count = calls.filter(call => call === tool).length;
    if (count < minimum) throw new Error(`${testCase.id}: ${tool} called ${count} times; expected at least ${minimum}`);
  }
  let cursor = 0;
  for (const group of expected.orderedTools) {
    const match = calls.findIndex((call, index) => index >= cursor && group.includes(call));
    if (match < 0) {
      throw new Error(`${testCase.id}: missing ordered tool group [${group.join(', ')}] after call ${cursor}`);
    }
    cursor = match + 1;
  }
  if (!finalResponse.trim()) throw new Error(`${testCase.id}: Codex returned an empty final response`);
  for (const pattern of expected.finalMustMatch) {
    if (!new RegExp(pattern, 'i').test(finalResponse)) {
      throw new Error(`${testCase.id}: final response did not match /${pattern}/i`);
    }
  }
}

function tomlString(value) {
  return JSON.stringify(value);
}

function runCodex(cases) {
  if (!existsSync(join(projectRoot, 'dist', 'server', 'index.js'))) {
    throw new Error('dist/server/index.js is missing; run npm run build before the opt-in eval');
  }
  for (const testCase of cases) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), `mcp-bpmn-codex-${testCase.id}-`));
    try {
      const diagrams = prepareDiagramStore(temporaryRoot, [testCase]);
      const skillTarget = join(temporaryRoot, '.agents', 'skills', 'bpmn-modeler');
      mkdirSync(dirname(skillTarget), { recursive: true });
      cpSync(join(projectRoot, 'skills', 'bpmn-modeler'), skillTarget, { recursive: true });
      const finalPath = join(temporaryRoot, 'final.txt');
      const serverPath = join(projectRoot, 'dist', 'server', 'index.js');
      const output = execFileSync('codex', [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check',
        '--sandbox', 'workspace-write', '--cd', temporaryRoot,
        '--output-last-message', finalPath,
        '-c', `mcp_servers.mcp-bpmn.command=${tomlString(process.execPath)}`,
        '-c', `mcp_servers.mcp-bpmn.args=[${tomlString(serverPath)}]`,
        '-c', `mcp_servers.mcp-bpmn.env={MCP_BPMN_DIAGRAMS_PATH=${tomlString(diagrams)}}`,
        testCase.prompt
      ], { cwd: temporaryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      const calls = toolCallsFromCodexJsonl(output);
      const finalResponse = readFileSync(finalPath, 'utf8');
      assertCodexResult(testCase, calls, finalResponse);
      process.stdout.write(`${testCase.id}: pass (${calls.join(' -> ') || 'no BPMN tools'})\n`);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!['codex', 'claude'].includes(args.client)) throw new Error('--client must be codex or claude');
  const cases = selectedCases(args.caseId);
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify(adapterPlan(args.client, cases), null, 2)}\n`);
  } else if (args.client === 'codex') {
    runCodex(cases);
  } else {
    runClaude(cases);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
