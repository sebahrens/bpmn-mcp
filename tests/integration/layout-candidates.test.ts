import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnAutoLayoutV2Adapter } from '../../src/core/layout/BpmnLayoutAdapter.js';
import { layoutFixtures, LayoutFixture } from '../fixtures/layout/index.js';
import {
  formatGeometryDiagnostics,
  GeometryDiagnostic,
  NormalizedGeometry,
  validateBpmnGeometry
} from '../helpers/bpmnGeometry.js';

type CandidateStatus = 'pass' | 'fail' | 'unsupported';

interface LayoutCandidate {
  id: string;
  version: string;
  unsupported: Partial<Record<LayoutFixture['feature'], string>>;
  layout(xml: string): Promise<{ xml: string; warnings: string[] }>;
}

interface CandidateMatrixRow {
  candidate: string;
  version: string;
  fixture: string;
  feature: string;
  status: CandidateStatus;
  deterministic: boolean;
  warnings: string[];
  diagnostics: GeometryDiagnostic[];
  detail: string;
}

const fixtureDirectory = join(process.cwd(), 'tests', 'fixtures', 'layout');
const candidateTimeoutMs = 20_000;
const packageRunner = `
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const packageName = process.argv[1];
  const module = await import(packageName);
  const output = await module.layoutProcess(input);
  const xml = typeof output === 'string' ? output : output?.xml;
  if (typeof xml !== 'string') throw new Error(packageName + ' returned neither XML nor { xml, warnings }');
  const warnings = typeof output === 'string' ? [] : (output.warnings || []).map(warning => ({
    code: warning?.code,
    message: warning?.message || String(warning)
  }));
  process.stdout.write(JSON.stringify({ xml, warnings }));
`;

async function packageLayout(
  packageName: string,
  xml: string
): Promise<{ xml: string; warnings: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', packageRunner, packageName], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${packageName} exceeded ${candidateTimeoutMs}ms timeout`));
    }, candidateTimeoutMs);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`${packageName} exited ${code}: ${stderr.trim()}`));
        return;
      }
      try {
        const output = JSON.parse(stdout);
        resolve({
          xml: output.xml,
          warnings: (output.warnings || []).map((warning: any) =>
            [warning.code, warning.message].filter(Boolean).join(': ')
          )
        });
      } catch (error) {
        reject(new Error(`${packageName} returned invalid adapter output: ${String(error)}`));
      }
    });
    child.stdin.end(xml);
  });
}

async function currentProjectLayout(xml: string): Promise<{ xml: string; warnings: string[] }> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-candidate-'));
  try {
    const adapter = new BpmnAutoLayoutV2Adapter(
      source => packageLayout('bpmn-auto-layout', source)
    );
    const engine = new SimpleBpmnEngine(directory, undefined, adapter);
    const context = await engine.importXml(xml);
    const result = await engine.applyAutoLayout(context.id);
    return {
      xml: await engine.exportXml(context.id),
      warnings: result.warnings.map(warning =>
        [warning.code, warning.message].filter(Boolean).join(': ')
      )
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const candidates: LayoutCandidate[] = [
  {
    id: 'bpmn-auto-layout-stable',
    version: '1.3.0',
    unsupported: {
      'collaboration/message flow': '1.3.0 lays out only the first participant and does not lay out message flows'
    },
    layout: xml => packageLayout('bpmn-auto-layout-stable', xml)
  },
  {
    id: 'bpmn-auto-layout-next',
    version: '2.0.0-alpha.2',
    unsupported: {},
    layout: xml => packageLayout('bpmn-auto-layout-alpha', xml)
  },
  {
    id: 'yabal',
    version: '2.0.0',
    unsupported: {},
    layout: xml => packageLayout('yet-another-bpmn-auto-layout', xml)
  },
  {
    id: 'mcp-bpmn-final-output',
    version: 'working-tree',
    unsupported: {},
    layout: currentProjectLayout
  }
];

async function evaluateCandidate(
  candidate: LayoutCandidate,
  fixture: LayoutFixture
): Promise<CandidateMatrixRow> {
  const unsupported = candidate.unsupported[fixture.feature];
  const input = await fs.readFile(join(fixtureDirectory, fixture.filename), 'utf8');
  const attempts: Array<{
    normalized?: NormalizedGeometry;
    warnings: string[];
    diagnostics: GeometryDiagnostic[];
    failure: string;
  }> = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const output = await candidate.layout(input);
      const report = await validateBpmnGeometry(output.xml);
      attempts.push({
        normalized: report.normalized,
        warnings: output.warnings,
        diagnostics: report.diagnostics,
        failure: report.valid ? '' : formatGeometryDiagnostics(report)
      });
    } catch (error) {
      attempts.push({
        warnings: [],
        diagnostics: [],
        failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });
    }
  }

  const [first, second] = attempts;
  const deterministic = JSON.stringify({
    normalized: first.normalized,
    warnings: first.warnings,
    diagnostics: first.diagnostics,
    failure: first.failure
  }) === JSON.stringify({
    normalized: second.normalized,
    warnings: second.warnings,
    diagnostics: second.diagnostics,
    failure: second.failure
  });
  const explicitUnsupported = /unsupported|not supported|does not support/i.test(first.failure);
  const observed = first.failure || first.warnings.join('; ') || 'valid geometry';

  return {
    candidate: candidate.id,
    version: candidate.version,
    fixture: fixture.filename,
    feature: fixture.feature,
    status: unsupported || explicitUnsupported ? 'unsupported' : first.failure ? 'fail' : 'pass',
    deterministic,
    warnings: first.warnings,
    diagnostics: first.diagnostics,
    detail: unsupported ? `${unsupported}; observed: ${observed}` : observed
  };
}

function printableMatrix(rows: CandidateMatrixRow[]): string {
  const header = '| candidate | version | feature | result | detail |';
  const separator = '|---|---:|---|---|---|';
  const body = rows.map(row => {
    const detail = row.detail.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 240);
    return `| ${row.candidate} | ${row.version} | ${row.feature} | ${row.status} | ${detail} |`;
  });
  return [header, separator, ...body].join('\n');
}

describe('layout candidate corpus', () => {
  let matrix: CandidateMatrixRow[];

  beforeAll(async () => {
    matrix = [];
    for (const candidate of candidates) {
      for (const fixture of layoutFixtures) {
        matrix.push(await evaluateCandidate(candidate, fixture));
      }
    }
    console.log(`LAYOUT_CANDIDATE_MATRIX\n${printableMatrix(matrix)}`);
  }, 120_000);

  it('covers the complete decision corpus for every shortlisted candidate and final output', () => {
    expect(layoutFixtures.map(fixture => fixture.feature)).toEqual([
      'sequential',
      'branch/rejoin',
      'skip flow',
      'cycle',
      'self-loop',
      'long labels',
      'collaboration/message flow',
      'lanes',
      'subprocess/boundary event'
    ]);
    expect(matrix).toHaveLength(candidates.length * layoutFixtures.length);
    for (const candidate of candidates) {
      const rows = matrix.filter(row => row.candidate === candidate.id);
      expect(rows).toHaveLength(layoutFixtures.length);
      expect(rows.some(row => row.status === 'pass')).toBe(true);
    }
  });

  it('makes unsupported features explicit and bounded to a candidate and fixture', () => {
    const unsupported = matrix.filter(row => row.status === 'unsupported');
    expect(unsupported.length).toBeGreaterThan(0);
    for (const row of unsupported) {
      expect(row.candidate).toBeTruthy();
      expect(row.feature).toBeTruthy();
      expect(row.detail).not.toBe('');
    }
  });

  it('produces identical normalized geometry or diagnostics on repeated runs', () => {
    expect(matrix.filter(row => !row.deterministic)).toEqual([]);
  });

  it('passes the complete decision corpus through the selected project path', () => {
    const selectedRows = matrix.filter(row => row.candidate === 'mcp-bpmn-final-output');
    expect(selectedRows).toHaveLength(layoutFixtures.length);
    expect(selectedRows.map(row => ({
      feature: row.feature,
      status: row.status,
      warnings: row.warnings
    }))).toEqual(layoutFixtures.map(fixture => ({
      feature: fixture.feature,
      status: 'pass',
      warnings: []
    })));
  });

  it('uses structured diagnostics with offending IDs for geometry failures', () => {
    for (const row of matrix.filter(row => row.diagnostics.length > 0)) {
      for (const diagnostic of row.diagnostics.filter(item => item.code !== 'MISSING_DI')) {
        expect(diagnostic.ids.length).toBeGreaterThan(0);
      }
    }
  });

  it('preserves selected-candidate DI and semantics after a later mutable-engine edit', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-state-'));
    try {
      const creator = new SimpleBpmnEngine(join(directory, 'created'));
      const process = await creator.createProcess('Layout state prototype');
      await creator.createElement(process.id, {
        id: 'Start_Prototype',
        type: 'bpmn:StartEvent',
        name: 'Start'
      });
      await creator.createElement(process.id, {
        id: 'Task_Prototype',
        type: 'bpmn:Task',
        name: 'Before mutation'
      });
      await creator.createElement(process.id, {
        id: 'End_Prototype',
        type: 'bpmn:EndEvent',
        name: 'End'
      });
      const firstFlow = await creator.connect(process.id, 'Start_Prototype', 'Task_Prototype');
      const secondFlow = await creator.connect(process.id, 'Task_Prototype', 'End_Prototype');

      const generated = await creator.exportXml(process.id);
      const extensionNamespace = 'xmlns:decision="urn:mcp-bpmn:layout-decision"';
      const taskElement = '<bpmn:task id="Task_Prototype" name="Before mutation" />';
      const taskWithExtension = [
        '<bpmn:task id="Task_Prototype" name="Before mutation">',
        '      <bpmn:extensionElements>',
        '        <decision:marker value="preserve-me" />',
        '      </bpmn:extensionElements>',
        '    </bpmn:task>'
      ].join('\n');
      const sourceXml = generated
        .replace('xmlns:bpmndi=', `${extensionNamespace} xmlns:bpmndi=`)
        .replace(taskElement, taskWithExtension);
      expect(sourceXml).not.toBe(generated);

      const selectedOutput = await packageLayout('bpmn-auto-layout-alpha', sourceXml);
      expect(selectedOutput.warnings).toEqual([]);
      const beforeMutation = await validateBpmnGeometry(selectedOutput.xml);
      expect(beforeMutation.valid).toBe(true);

      const mutator = new SimpleBpmnEngine(join(directory, 'mutated'));
      const imported = await mutator.importXml(selectedOutput.xml);
      await mutator.updateElement(imported.id, 'Task_Prototype', { name: 'After mutation' });
      const exported = await mutator.exportXml(imported.id);
      const afterMutation = await validateBpmnGeometry(exported);

      expect(afterMutation.valid).toBe(true);
      expect(afterMutation.normalized).toEqual(beforeMutation.normalized);
      expect(exported).toContain('name="After mutation"');
      expect(exported).toContain('decision:marker value="preserve-me"');
      for (const semanticId of [
        process.id,
        'Start_Prototype',
        'Task_Prototype',
        'End_Prototype',
        firstFlow.id,
        secondFlow.id
      ]) {
        expect(exported).toContain(`id="${semanticId}"`);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
