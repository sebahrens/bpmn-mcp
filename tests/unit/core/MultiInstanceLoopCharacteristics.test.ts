import BpmnModdle from 'bpmn-moddle';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import { parseToolRequest, tools } from '../../../src/server/tools.js';
import { IdGenerator } from '../../../src/utils/IdGenerator.js';

describe('multi-instance loop characteristics', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;
  let handler: BpmnRequestHandler;
  const moddle = new BpmnModdle();

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-multi-instance-'));
    IdGenerator.reset();
    diagramContext.clear();
    engine = new SimpleBpmnEngine(directory);
    handler = new BpmnRequestHandler(engine);
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['parallel', false],
    ['sequential', true]
  ])('authors a %s standard BPMN multi-instance marker', async (_label, isSequential) => {
    await expectSuccess(handler.handleRequest('new_bpmn', { name: 'Loop fixture' }));
    const cardinality = '  4 & 5  ';
    const completion = '  completed >= required  ';

    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'serviceTask',
      name: 'Process item',
      properties: {
        multiInstance: {
          isSequential,
          loopCardinality: {
            body: cardinality,
            language: 'urn:example:cardinality-expression'
          },
          completionCondition: {
            body: completion,
            language: 'urn:example:completion-expression'
          }
        }
      }
    }));

    const parsed = await moddle.fromXML(diagramContext.getCurrent().xml!);
    expect(parsed.warnings).toEqual([]);
    const loop = parsed.elementsById.ServiceTask_1.loopCharacteristics;
    expect(loop).toMatchObject({
      $type: 'bpmn:MultiInstanceLoopCharacteristics',
      isSequential
    });
    expect(loop.loopCardinality).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: cardinality,
      language: 'urn:example:cardinality-expression'
    });
    expect(loop.completionCondition).toMatchObject({
      $type: 'bpmn:FormalExpression',
      body: completion,
      language: 'urn:example:completion-expression'
    });
  });

  it('serializes portable loop input and output references to ItemAwareElements', async () => {
    const context = await engine.createProcess('Referenced collection');
    diagramContext.setCurrent(context);
    const { reference } = await engine.addDataObject(context.id, 'Items', {
      isCollection: true
    });

    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Process collection',
      properties: {
        multiInstance: {
          isSequential: false,
          loopDataInputRef: reference.id,
          loopDataOutputRef: reference.id
        }
      }
    }));

    const parsed = await moddle.fromXML(diagramContext.getCurrent().xml!);
    const loop = parsed.elementsById.Task_1.loopCharacteristics;
    expect(loop.loopDataInputRef).toBe(parsed.elementsById[reference.id]);
    expect(loop.loopDataOutputRef).toBe(parsed.elementsById[reference.id]);
  });

  it('updates an authored multi-instance configuration through the MCP tool', async () => {
    await expectSuccess(handler.handleRequest('new_bpmn', { name: 'Updated loop' }));
    await expectSuccess(handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Initially parallel',
      properties: {
        multiInstance: {
          isSequential: false,
          loopCardinality: { body: '2' }
        }
      }
    }));

    await expectSuccess(handler.handleRequest('update_element', {
      elementId: 'Task_1',
      properties: {
        multiInstance: {
          isSequential: true,
          loopCardinality: { body: '  8  ' },
          completionCondition: { body: '  done  ' }
        }
      }
    }));

    const parsed = await moddle.fromXML(diagramContext.getCurrent().xml!);
    const loop = parsed.elementsById.Task_1.loopCharacteristics;
    expect(loop.isSequential).toBe(true);
    expect(loop.loopCardinality.body).toBe('  8  ');
    expect(loop.completionCondition.body).toBe('  done  ');
  });

  it('preserves imported multi-instance semantics through update, save, and reopen', async () => {
    const imported = await engine.importXml(loopFixtureXml());
    const importedProperties = imported.elements.get('Task_Multi')?.properties.multiInstance;
    expect(importedProperties).toEqual({
      isSequential: true,
      loopCardinality: {
        body: '  ${batchSize}  ',
        language: 'urn:example:el'
      },
      completionCondition: {
        body: '  ${completed == total}  ',
        language: 'urn:example:el'
      }
    });

    await engine.updateElement(imported.id, 'Task_Multi', { name: 'Updated loop task' });
    await engine.save(imported.id);
    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(imported.filename!);
    const parsed = await moddle.fromXML(await reopenedEngine.exportXml(reopened.id));
    const loop = parsed.elementsById.Task_Multi.loopCharacteristics;

    expect(parsed.elementsById.Task_Multi.name).toBe('Updated loop task');
    expect(loop.$type).toBe('bpmn:MultiInstanceLoopCharacteristics');
    expect(loop.isSequential).toBe(true);
    expect(loop.loopCardinality.body).toBe('  ${batchSize}  ');
    expect(loop.completionCondition.body).toBe('  ${completed == total}  ');
    expect(parsed.elementsById.Task_Standard.loopCharacteristics.$type)
      .toBe('bpmn:StandardLoopCharacteristics');
  });

  it('rejects invalid activity and reference combinations without mutation', async () => {
    const context = await engine.createProcess('Invalid loop');
    await expect(engine.createElement(context.id, {
      type: 'bpmn:StartEvent',
      properties: { multiInstance: { isSequential: false } }
    })).rejects.toThrow('only valid on BPMN activities');

    diagramContext.setCurrent(context);
    const before = context.xml;
    const missingReference = await handler.handleRequest('add_activity', {
      activityType: 'task',
      name: 'Missing collection',
      properties: {
        multiInstance: {
          isSequential: false,
          loopDataInputRef: 'Missing_Collection'
        }
      }
    });
    expect(missingReference.isError).toBe(true);
    expect(missingReference.content[0].text).toContain('missing ItemAwareElement');
    expect(context.elements.size).toBe(0);
    expect(context.xml).toBe(before);
  });

  it('does not replace imported standard loop characteristics with multi-instance ones', async () => {
    const context = await engine.importXml(loopFixtureXml());
    const before = await engine.exportXml(context.id);

    await expect(engine.updateElement(context.id, 'Task_Standard', {
      properties: {
        multiInstance: {
          isSequential: false,
          loopCardinality: { body: '3' }
        }
      }
    })).rejects.toThrow('incompatible bpmn:StandardLoopCharacteristics');

    expect(await engine.exportXml(context.id)).toBe(before);
  });

  it('advertises the exact nested schema and preserves opaque bodies at validation', () => {
    const addSchema = tools.find(tool => tool.name === 'add_activity')!.inputSchema as any;
    const updateSchema = tools.find(tool => tool.name === 'update_element')!.inputSchema as any;
    const advertised = addSchema.properties.properties.properties.multiInstance.properties;
    expect(Object.keys(advertised).sort()).toEqual([
      'completionCondition',
      'isSequential',
      'loopCardinality',
      'loopDataInputRef',
      'loopDataOutputRef'
    ]);
    expect(updateSchema.properties.properties.properties.multiInstance).toBeDefined();

    const body = '  count(items) > 0  ';
    const parsed = parseToolRequest('add_activity', {
      activityType: 'task',
      name: 'Opaque expression',
      properties: {
        multiInstance: {
          isSequential: false,
          loopCardinality: { body }
        }
      }
    });
    expect((parsed.args as any).properties.multiInstance.loopCardinality.body).toBe(body);
    expect(() => parseToolRequest('add_activity', {
      activityType: 'task',
      name: 'Blank expression',
      properties: {
        multiInstance: {
          isSequential: false,
          loopCardinality: { body: '   ' }
        }
      }
    })).toThrow('Expression body must not be blank');
  });
});

async function expectSuccess(resultPromise: Promise<{ isError?: boolean }>): Promise<void> {
  expect((await resultPromise).isError).not.toBe(true);
}

function loopFixtureXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  id="Definitions_Loops" targetNamespace="urn:mcp-bpmn:loops">
  <bpmn:process id="Process_Loops" name="Imported loops" isExecutable="true">
    <bpmn:task id="Task_Multi" name="Multi">
      <bpmn:multiInstanceLoopCharacteristics isSequential="true">
        <bpmn:loopCardinality xsi:type="bpmn:tFormalExpression" language="urn:example:el">  \${batchSize}  </bpmn:loopCardinality>
        <bpmn:completionCondition xsi:type="bpmn:tFormalExpression" language="urn:example:el">  \${completed == total}  </bpmn:completionCondition>
      </bpmn:multiInstanceLoopCharacteristics>
    </bpmn:task>
    <bpmn:task id="Task_Standard" name="Standard">
      <bpmn:standardLoopCharacteristics testBefore="true">
        <bpmn:loopCondition xsi:type="bpmn:tFormalExpression">keepGoing</bpmn:loopCondition>
      </bpmn:standardLoopCharacteristics>
    </bpmn:task>
  </bpmn:process>
</bpmn:definitions>`;
}
