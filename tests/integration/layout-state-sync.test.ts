import BpmnModdle from 'bpmn-moddle';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { NormalizedGeometry, validateBpmnGeometry } from '../helpers/bpmnGeometry.js';

interface LibraryLayoutResult {
  xml: string;
  warnings: unknown[];
}

const importedFixturePath = join(
  process.cwd(),
  'tests',
  'fixtures',
  'import-roundtrip',
  'full-semantics-di.bpmn'
);

async function runSelectedLayout(xml: string): Promise<LibraryLayoutResult> {
  const runner = `
    let source = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) source += chunk;
    const { layoutProcess } = await import('bpmn-auto-layout');
    process.stdout.write(JSON.stringify(await layoutProcess(source)));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', runner], {
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
      reject(new Error('Selected layout package timed out'));
    }, 20_000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Selected layout package exited ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(JSON.parse(stdout) as LibraryLayoutResult);
    });
    child.stdin.end(xml);
  });
}

async function normalizedGeometry(xml: string): Promise<NormalizedGeometry> {
  const report = await validateBpmnGeometry(xml);
  expect(report.normalized).toBeDefined();
  return report.normalized!;
}

function boundsOf(bounds: any): { x: number; y: number; width: number; height: number } {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function pointsOf(points: any[]): Array<{ x: number; y: number }> {
  return points.map(point => ({ x: point.x, y: point.y }));
}

describe('layout state synchronization', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-layout-sync-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('adopts selected-library DI in memory and preserves it through a later mutation', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.createProcess('Mutable layout state');
    await engine.createElement(context.id, {
      id: 'Start_LayoutSync',
      type: 'bpmn:StartEvent',
      name: 'Start'
    });
    await engine.createElement(context.id, {
      id: 'Task_LayoutSync',
      type: 'bpmn:Task',
      name: 'Before layout'
    });
    await engine.createElement(context.id, {
      id: 'End_LayoutSync',
      type: 'bpmn:EndEvent',
      name: 'End'
    });
    await engine.connect(context.id, 'Start_LayoutSync', 'Task_LayoutSync');
    await engine.connect(context.id, 'Task_LayoutSync', 'End_LayoutSync');

    const libraryResult = await runSelectedLayout(await engine.exportXml(context.id));
    expect(libraryResult.warnings).toEqual([]);
    await engine.applyLayoutXml(context.id, libraryResult.xml);

    const parsedLayout = await new BpmnModdle().fromXML(libraryResult.xml);
    for (const item of parsedLayout.rootElement.diagrams[0].plane.planeElement) {
      const semanticId = item.bpmnElement?.id;
      if (item.$type === 'bpmndi:BPMNShape' && context.elements.has(semanticId)) {
        expect(context.elements.get(semanticId)).toMatchObject({
          position: { x: item.bounds.x, y: item.bounds.y },
          size: { width: item.bounds.width, height: item.bounds.height }
        });
        expect(context.document.diagram.shapes.get(item.id)?.bounds)
          .toEqual(boundsOf(item.bounds));
      }
      if (item.$type === 'bpmndi:BPMNEdge' && context.connections.has(semanticId)) {
        expect(context.connections.get(semanticId)?.waypoints).toEqual(pointsOf(item.waypoint));
        expect(context.document.diagram.edges.get(item.id)?.waypoints)
          .toEqual(pointsOf(item.waypoint));
      }
    }

    const firstGeometry = await normalizedGeometry(await engine.exportXml(context.id));
    await engine.applyLayoutXml(context.id, libraryResult.xml);
    expect(await normalizedGeometry(await engine.exportXml(context.id))).toEqual(firstGeometry);

    await engine.updateElement(context.id, 'Task_LayoutSync', { name: 'After layout' });
    const exported = await engine.exportXml(context.id);
    expect(await normalizedGeometry(exported)).toEqual(firstGeometry);
    expect(context.elements.get('Task_LayoutSync')?.name).toBe('After layout');
    expect(context.xml).toBe(exported);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(exported);
  });

  it('preserves pre-laid participant, lane, label, shape, and edge geometry through edits', async () => {
    const sourceXml = await fs.readFile(importedFixturePath, 'utf8');
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.importXml(sourceXml);
    const before = await normalizedGeometry(await engine.exportXml(context.id));

    const participantShape = context.document.diagram.shapes.get('Participant_Internal_CustomDI');
    const laneShape = context.document.diagram.shapes.get('Lane_Reviewer_CustomDI');
    const labeledShape = context.document.diagram.shapes.get('Start_RoundTrip_CustomDI');
    const labeledEdge = context.document.diagram.edges.get('Flow_Approved_CustomDI');
    expect(context.elements.get('Participant_Internal')).toMatchObject({
      position: { x: 40, y: 40 },
      size: { width: 920, height: 360 }
    });
    expect(context.document.lanes.get('Lane_Reviewer')).toMatchObject({
      position: { x: 70, y: 40 },
      size: { width: 890, height: 360 }
    });
    expect(participantShape?.bounds).toEqual({ x: 40, y: 40, width: 920, height: 360 });
    expect(laneShape?.bounds).toEqual({ x: 70, y: 40, width: 890, height: 360 });
    expect(labeledShape?.labelBounds).toEqual({ x: 105, y: 232, width: 46, height: 14 });
    expect(labeledEdge?.labelBounds).toEqual({ x: 444, y: 186, width: 62, height: 14 });

    await engine.updateElement(context.id, 'Task_Unrelated', { name: 'Edited after opening' });

    expect(await normalizedGeometry(await engine.exportXml(context.id))).toEqual(before);
  });

  it.each([
    ['parser failure', '<bpmn:definitions>'],
    ['semantic change', null]
  ])('rolls back memory and the active file after %s', async (_caseName, candidate) => {
    const engine = new SimpleBpmnEngine(directory);
    const context = await engine.createProcess('Layout rollback');
    await engine.createElement(context.id, {
      id: 'Task_LayoutRollback',
      type: 'bpmn:Task',
      name: 'Original'
    });
    const beforeXml = context.xml!;
    const beforePosition = { ...context.elements.get('Task_LayoutRollback')!.position };
    const invalidLayout = candidate || beforeXml.replace('name="Original"', 'name="Changed by adapter"');

    await expect(engine.applyLayoutXml(context.id, invalidLayout)).rejects.toThrow(
      candidate ? 'Failed to parse layout XML' : 'Layout output changed BPMN semantics'
    );

    expect(context.xml).toBe(beforeXml);
    expect(context.elements.get('Task_LayoutRollback')).toMatchObject({
      name: 'Original',
      position: beforePosition
    });
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeXml);
  });
});
