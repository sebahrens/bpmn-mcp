import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BpmnValidator } from '../../src/core/BpmnValidator.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { parseToolRequest } from '../../src/server/tools.js';
import { IdGenerator } from '../../src/utils/IdGenerator.js';

describe('BPMN xsd:ID persistence', () => {
  let directory: string;
  let engine: SimpleBpmnEngine;

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-ids-'));
    IdGenerator.reset();
    engine = new SimpleBpmnEngine(directory);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('rejects an invalid public or generated ID without mutating memory or disk', async () => {
    const context = await engine.createProcess('Atomic ID rejection');
    const beforeXml = context.xml;
    const beforeElements = Array.from(context.elements.entries());
    const beforeDisk = await fs.readFile(join(directory, context.filename!), 'utf8');

    await expect(engine.createElement(context.id, {
      id: 'a:b',
      type: 'bpmn:Task'
    })).rejects.toThrow(
      'Invalid BPMN xsd:ID at element.id: "a:b" is not an XML NCName'
    );
    expect(Array.from(context.elements.entries())).toEqual(beforeElements);
    expect(context.xml).toBe(beforeXml);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);

    await expect(engine.createElement(context.id, {
      id: '',
      type: 'bpmn:Task'
    })).rejects.toThrow(
      'Invalid BPMN xsd:ID at element.id: "" is not an XML NCName'
    );
    expect(Array.from(context.elements.entries())).toEqual(beforeElements);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);

    await expect(engine.createElement(context.id, {
      id: 'Start_A',
      type: 'bpmn:StartEvent',
      properties: {
        eventDefinition: 'message',
        eventDefinitionPayload: { definitionId: '', reference: { id: 'Message_A' } }
      }
    })).rejects.toThrow(
      'Invalid BPMN xsd:ID at eventDefinitionPayload.definitionId: "" is not an XML NCName'
    );
    expect(Array.from(context.elements.entries())).toEqual(beforeElements);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);

    jest.spyOn(IdGenerator, 'generate').mockReturnValueOnce('1-invalid');
    await expect(engine.createElement(context.id, { type: 'bpmn:Task' })).rejects.toThrow(
      'Invalid BPMN xsd:ID at generated Task.id: "1-invalid" is not an XML NCName'
    );
    expect(Array.from(context.elements.entries())).toEqual(beforeElements);
    expect(context.xml).toBe(beforeXml);
    await expect(fs.readFile(join(directory, context.filename!), 'utf8')).resolves.toBe(beforeDisk);
  });

  it('round-trips valid Unicode IDs through tools, moddle, export, and reopen', async () => {
    const unicodeElementId = `\u{10000}_Task`;
    const unicodeDefinitionId = 'Définition_Événement';
    const unicodeReferenceId = '消息_一';
    expect(parseToolRequest('add_event', {
      eventType: 'start',
      eventDefinition: 'message',
      eventDefinitionPayload: {
        definitionId: unicodeDefinitionId,
        reference: { id: unicodeReferenceId }
      }
    }).args.eventDefinitionPayload).toMatchObject({
      definitionId: unicodeDefinitionId,
      reference: { id: unicodeReferenceId }
    });

    const context = await engine.createProcess('Unicode IDs');
    await engine.createElement(context.id, {
      id: unicodeElementId,
      type: 'bpmn:Task',
      name: '__mcp_bpmn_unicode_id_1'
    });
    await engine.createElement(context.id, {
      id: 'Événement_Départ',
      type: 'bpmn:StartEvent',
      properties: {
        eventDefinition: 'message',
        eventDefinitionPayload: {
          definitionId: unicodeDefinitionId,
          reference: { id: unicodeReferenceId, name: '消息' }
        }
      }
    });

    const xml = await engine.exportXml(context.id);
    expect(xml).toContain(`id="${unicodeElementId}"`);
    expect(xml).toContain(`id="${unicodeDefinitionId}"`);
    expect(xml).toContain(`id="${unicodeReferenceId}"`);
    await expect(new BpmnValidator().validate(xml, 'syntax')).resolves.toMatchObject({ valid: true });

    const reopenedEngine = new SimpleBpmnEngine(directory);
    const reopened = await reopenedEngine.loadDiagram(context.filename!);
    expect(reopened.elements.has(unicodeElementId)).toBe(true);
    expect(reopened.elements.get(unicodeElementId)?.name).toBe('__mcp_bpmn_unicode_id_1');
    expect(reopened.elements.has('Événement_Départ')).toBe(true);
    expect(reopened.document.diagram.shapes.get(`${unicodeElementId}_di`)).toMatchObject({
      id: `${unicodeElementId}_di`,
      elementId: unicodeElementId
    });
    const reopenedXml = await reopenedEngine.exportXml(reopened.id);
    expect(reopenedXml).toContain(`id="${unicodeElementId}"`);
    expect(reopenedXml).toContain(`id="${unicodeDefinitionId}"`);
    expect(reopenedXml).toContain(`id="${unicodeReferenceId}"`);
    await expect(new BpmnValidator().validate(reopenedXml, 'syntax'))
      .resolves.toMatchObject({ valid: true });
  });

  it('rejects tool IDs with surrounding whitespace instead of trimming them', () => {
    expect(() => parseToolRequest('get_element', { elementId: ' Task_A ' })).toThrow(
      'Invalid BPMN xsd:ID; expected an XML NCName'
    );
  });

  it('rejects an imported invalid ID before registering or persisting the document', async () => {
    const invalidXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Invalid" targetNamespace="http://example.test/bpmn">
  <bpmn:process id="Process_Invalid"><bpmn:task id="a:b" /></bpmn:process>
</bpmn:definitions>`;

    await expect(engine.importXml(invalidXml)).rejects.toThrow(
      /Invalid BPMN xsd:ID at bpmn:task\[0\]\.id: "a:b"/
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);

    const duplicateXml = invalidXml
      .replace('id="a:b"', 'id="Process_Invalid"');
    await expect(engine.importXml(duplicateXml)).rejects.toThrow(
      /Duplicate BPMN xsd:ID at bpmn:task\[0\]\.id: "Process_Invalid"/
    );
    await expect(fs.readdir(directory)).resolves.toEqual([]);
  });
});
