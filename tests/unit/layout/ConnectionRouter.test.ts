import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { ConnectionRouter } from '../../../src/core/layout/ConnectionRouter.js';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

describe('ConnectionRouter container awareness', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-connection-router-'));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('routes a flow inside an expanded subprocess without treating it as an obstacle', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const process = await engine.createProcess('Subprocess routing', 'process');
    const subProcess = await engine.createElement(process.id, {
      id: 'SubProcess_1',
      type: 'bpmn:SubProcess',
      name: 'Handle',
      position: { x: 100, y: 100 },
      size: { width: 400, height: 200 }
    });
    await engine.createElement(process.id, {
      id: 'Task_A',
      type: 'bpmn:Task',
      scopeId: subProcess.id,
      position: { x: 140, y: 160 },
      size: { width: 100, height: 80 }
    });
    await engine.createElement(process.id, {
      id: 'Task_B',
      type: 'bpmn:Task',
      scopeId: subProcess.id,
      position: { x: 340, y: 160 },
      size: { width: 100, height: 80 }
    });
    const flow = await engine.connect(process.id, 'Task_A', 'Task_B');

    const [best] = new ConnectionRouter().route(process.document, flow.id, {
      avoidElementIds: [],
      avoidConnectionIds: [],
      clearance: 10
    });

    expect(best.diagnostics).toEqual([]);
    expect(best.waypoints).toEqual([{ x: 240, y: 200 }, { x: 340, y: 200 }]);
  });

  it('keeps a labelled sequence flow and its label inside the owning pool', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Two pools', 'collaboration');
    const upper = await engine.createElement(collaboration.id, {
      id: 'Participant_1',
      type: 'bpmn:Participant',
      name: 'Upper',
      position: { x: 80, y: 80 },
      size: { width: 600, height: 250 }
    });
    const lower = await engine.createElement(collaboration.id, {
      id: 'Participant_2',
      type: 'bpmn:Participant',
      name: 'Lower',
      position: { x: 80, y: 410 },
      size: { width: 600, height: 250 }
    });
    if (upper.kind !== 'participant' || lower.kind !== 'participant') {
      throw new Error('Expected collaboration participants');
    }
    await engine.createElement(collaboration.id, {
      id: 'Task_1',
      type: 'bpmn:Task',
      name: 'First',
      ownerId: upper.processRef,
      position: { x: 286, y: 120 },
      size: { width: 100, height: 80 }
    });
    await engine.createElement(collaboration.id, {
      id: 'Task_2',
      type: 'bpmn:Task',
      name: 'Second',
      ownerId: upper.processRef,
      position: { x: 486, y: 120 },
      size: { width: 100, height: 80 }
    });
    await engine.createElement(collaboration.id, {
      id: 'Task_3',
      type: 'bpmn:Task',
      name: 'Third',
      ownerId: lower.processRef,
      position: { x: 286, y: 450 },
      size: { width: 100, height: 80 }
    });
    const flow = await engine.connect(collaboration.id, 'Task_1', 'Task_2', 'go');

    const [best] = new ConnectionRouter().route(collaboration.document, flow.id, {
      avoidElementIds: [],
      avoidConnectionIds: [],
      clearance: 10
    });

    const pool = { x: 80, y: 80, width: 600, height: 250 };
    expect(best.diagnostics).toEqual([]);
    expect(best.waypoints).toEqual([{ x: 386, y: 160 }, { x: 486, y: 160 }]);
    expect(best.waypoints.every(point => withinBounds(point, pool))).toBe(true);
    expect(best.labelBounds).toBeDefined();
    expect(contains(pool, best.labelBounds!)).toBe(true);
  });

  it('docks a message flow on the top and bottom of the shapes it connects', async () => {
    const engine = new SimpleBpmnEngine(directory);
    const collaboration = await engine.createProcess('Message docking', 'collaboration');
    const upper = await engine.createElement(collaboration.id, {
      id: 'Participant_1',
      type: 'bpmn:Participant',
      name: 'Upper',
      position: { x: 80, y: 80 },
      size: { width: 600, height: 250 }
    });
    const lower = await engine.createElement(collaboration.id, {
      id: 'Participant_2',
      type: 'bpmn:Participant',
      name: 'Lower',
      position: { x: 80, y: 410 },
      size: { width: 900, height: 250 }
    });
    if (upper.kind !== 'participant' || lower.kind !== 'participant') {
      throw new Error('Expected collaboration participants');
    }
    await engine.createElement(collaboration.id, {
      id: 'SendTask_1',
      type: 'bpmn:SendTask',
      name: 'Send',
      ownerId: upper.processRef,
      position: { x: 286, y: 160 },
      size: { width: 100, height: 80 }
    });
    await engine.createElement(collaboration.id, {
      id: 'ReceiveTask_1',
      type: 'bpmn:ReceiveTask',
      name: 'Receive',
      ownerId: lower.processRef,
      position: { x: 700, y: 470 },
      size: { width: 100, height: 80 }
    });
    const message = await engine.connect(collaboration.id, 'SendTask_1', 'ReceiveTask_1');

    const [best] = new ConnectionRouter().route(collaboration.document, message.id, {
      avoidElementIds: [],
      avoidConnectionIds: [],
      clearance: 10
    });

    expect(best.diagnostics).toEqual([]);
    expect(best.waypoints[0]).toEqual({ x: 336, y: 240 });
    expect(best.waypoints[best.waypoints.length - 1]).toEqual({ x: 750, y: 470 });
  });
});

function withinBounds(point: { x: number; y: number }, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function contains(container: Bounds, child: Bounds): boolean {
  return child.x >= container.x
    && child.y >= container.y
    && child.x + child.width <= container.x + container.width
    && child.y + child.height <= container.y + container.height;
}
