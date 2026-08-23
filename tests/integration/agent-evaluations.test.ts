import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toolNames } from '../../src/server/tools.js';

type EvaluationCase = {
  id: string;
  tags: string[];
  prompt: string;
  expect: {
    activation: 'activate' | 'do-not-activate';
    semanticSteps: string[];
    orderedTools: string[][];
    requiredTools: string[];
    forbiddenTools: string[];
    minimumToolCalls?: Record<string, number>;
    finalMustMention: string[];
    finalMustMatch: string[];
  };
};

type EvaluationFixture = {
  schemaVersion: number;
  skill: { name: string; descriptionMustInclude: string[] };
  cases: EvaluationCase[];
};

const projectRoot = resolve(process.cwd());
const fixture = JSON.parse(readFileSync(
  resolve(projectRoot, 'evals/bpmn-modeler/cases.json'),
  'utf8'
)) as EvaluationFixture;
const skillSource = readFileSync(resolve(projectRoot, 'skills/bpmn-modeler/SKILL.md'), 'utf8');

function dryRun(client: 'codex' | 'claude'): any {
  return JSON.parse(execFileSync(process.execPath, [
    'scripts/run-agent-evals.mjs', '--client', client, '--dry-run'
  ], { cwd: projectRoot, encoding: 'utf8' }));
}

describe('cross-client BPMN agent evaluations', () => {
  it('pins the canonical skill identity and positive/negative trigger boundary', () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.skill.name).toBe('bpmn-modeler');
    expect(skillSource).toMatch(/^---\nname: bpmn-modeler\n/m);
    for (const phrase of fixture.skill.descriptionMustInclude) {
      expect(skillSource).toContain(phrase);
    }
  });

  it('covers the required activation, authoring, pagination, safety, and output matrix', () => {
    const tags = new Set(fixture.cases.flatMap(testCase => testCase.tags));
    for (const requiredTag of [
      'activation', 'non-activation', 'process', 'collaboration', 'indirect',
      'clarification', 'existing-file', 'pagination', 'typed', 'mermaid-bootstrap',
      'review-only', 'destructive', 'unsupported', 'workflow', 'svg'
    ]) {
      expect(tags).toContain(requiredTag);
    }
    expect(new Set(fixture.cases.map(testCase => testCase.id)).size).toBe(fixture.cases.length);
    expect(fixture.cases.every(testCase => testCase.prompt.trim().length > 0)).toBe(true);
    expect(fixture.cases.every(testCase => testCase.expect.semanticSteps.length > 0)).toBe(true);
    expect(fixture.cases.every(testCase => testCase.expect.finalMustMatch.length > 0)).toBe(true);
    for (const testCase of fixture.cases) {
      for (const pattern of testCase.expect.finalMustMatch) expect(() => new RegExp(pattern)).not.toThrow();
    }
  });

  it('uses the exact same prompts and semantic expectations for both client adapters', () => {
    const codex = dryRun('codex');
    const claude = dryRun('claude');
    delete codex.client;
    delete claude.client;
    expect(codex).toEqual(claude);
  });

  it('references only advertised tools and pins the core delivery sequence', () => {
    const advertised = new Set<string>(toolNames);
    for (const testCase of fixture.cases) {
      const referenced = [
        ...testCase.expect.requiredTools,
        ...testCase.expect.forbiddenTools,
        ...testCase.expect.orderedTools.flat(),
        ...Object.keys(testCase.expect.minimumToolCalls ?? {})
      ];
      for (const tool of referenced) expect(advertised).toContain(tool);
    }

    const processCase = fixture.cases.find(testCase => testCase.id === 'direct-process-svg')!;
    expect(processCase.expect.semanticSteps).toEqual(expect.arrayContaining([
      'create', 'mutate', 'validate', 'auto_layout', 'export_svg'
    ]));
    const workflow = processCase.expect.orderedTools.map(group => group[0]);
    expect(workflow).toEqual([
      'new_bpmn', 'add_event', 'validate', 'auto_layout', 'validate', 'export'
    ]);
    expect(skillSource.indexOf('Run `validate` at meaningful semantic checkpoints'))
      .toBeLessThan(skillSource.indexOf('apply `auto_layout` near the end'));
    expect(skillSource.indexOf('apply `auto_layout` near the end'))
      .toBeLessThan(skillSource.indexOf('Run `validate` again at `full` level after layout'));
    expect(skillSource.indexOf('Run `validate` again at `full` level after layout'))
      .toBeLessThan(skillSource.indexOf('Use `export` in the requested'));
  });
});
