import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BpmnValidator } from '../../../src/core/BpmnValidator.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';
import type { ValidationLevel } from '../../../src/types/index.js';

const namespaces = `
  xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  id="Definitions_Test"
  targetNamespace="http://bpmn.io/schema/bpmn"`;

function definitions(contents: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${namespaces}>
${contents}
</bpmn:definitions>`;
}

function issueCodes(result: Awaited<ReturnType<BpmnValidator['validate']>>): string[] {
  return result.issues.map(issue => issue.code);
}

describe('BpmnValidator', () => {
  const validator = new BpmnValidator();

  const invalidEvent = definitions(`
    <bpmn:process id="Process_Events">
      <bpmn:endEvent id="End_Timer">
        <bpmn:timerEventDefinition id="Timer_End" />
      </bpmn:endEvent>
    </bpmn:process>`);

  const executableProfileGap = definitions(`
    <bpmn:process id="Process_Profile" isExecutable="true">
      <bpmn:task id="Task_Disconnected" />
    </bpmn:process>`);

  it.each<{
    level: ValidationLevel;
    xml: string;
    expected: string[];
    excluded: string[];
  }>([
    {
      level: 'syntax',
      xml: invalidEvent,
      expected: [],
      excluded: ['BPMN_INVALID_EVENT_DEFINITION', 'BPMN_PROFILE_MISSING_START_EVENT']
    },
    {
      level: 'semantic',
      xml: invalidEvent,
      expected: ['BPMN_INVALID_EVENT_DEFINITION'],
      excluded: ['BPMN_PROFILE_MISSING_START_EVENT']
    },
    {
      level: 'full',
      xml: executableProfileGap,
      expected: [
        'BPMN_PROFILE_MISSING_START_EVENT',
        'BPMN_PROFILE_MISSING_END_EVENT',
        'BPMN_PROFILE_MISSING_INCOMING_FLOW',
        'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
      ],
      excluded: []
    },
    {
      level: 'semantic',
      xml: executableProfileGap,
      expected: [],
      excluded: [
        'BPMN_PROFILE_MISSING_START_EVENT',
        'BPMN_PROFILE_MISSING_END_EVENT',
        'BPMN_PROFILE_MISSING_INCOMING_FLOW',
        'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
      ]
    }
  ])('$level performs only its documented checks', async ({ level, xml, expected, excluded }) => {
    const result = await validator.validate(xml, level);
    const codes = issueCodes(result);

    expect(result.level).toBe(level);
    expect(codes).toEqual(expect.arrayContaining(expected));
    for (const code of excluded) expect(codes).not.toContain(code);
  });

  it.each<{
    name: string;
    xml: string;
    code: string;
    elementId?: string;
  }>([
    {
      name: 'malformed XML',
      xml: '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL">',
      code: 'BPMN_PARSE_ERROR'
    },
    {
      name: 'an unresolved reference',
      xml: definitions(`
        <bpmn:process id="Process_Ref">
          <bpmn:task id="Task_Ref" />
          <bpmn:sequenceFlow id="Flow_Ref" sourceRef="Task_Ref" targetRef="Missing_Ref" />
        </bpmn:process>`),
      code: 'BPMN_UNRESOLVED_REFERENCE',
      elementId: 'Flow_Ref'
    }
  ])('returns a stable syntax issue for $name', async ({ xml, code, elementId }) => {
    const first = await validator.validate(xml, 'syntax');
    const second = await validator.validate(xml, 'full');

    for (const result of [first, second]) {
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code, severity: 'error', ...(elementId ? { elementId } : {}) })
      ]));
    }
  });

  it('detects sequence flows that cross process ownership', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_One">
        <bpmn:task id="Task_One" />
        <bpmn:sequenceFlow id="Flow_Cross" sourceRef="Task_One" targetRef="Task_Two" />
      </bpmn:process>
      <bpmn:process id="Process_Two">
        <bpmn:task id="Task_Two" />
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BPMN_CROSS_PROCESS_SEQUENCE_FLOW',
        elementId: 'Flow_Cross'
      })
    ]));
  });

  it('detects associations that cross process ownership', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_Association">
        <bpmn:task id="Task_Local" />
        <bpmn:association id="Association_Cross" sourceRef="Task_Local" targetRef="Task_Remote" />
      </bpmn:process>
      <bpmn:process id="Process_Remote">
        <bpmn:task id="Task_Remote" />
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BPMN_ASSOCIATION_OUTSIDE_OWNER',
        elementId: 'Association_Cross'
      })
    ]));
  });

  it('detects invalid boundary ownership and event-definition combinations', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_Boundary">
        <bpmn:subProcess id="SubProcess_One">
          <bpmn:task id="Task_Nested" />
        </bpmn:subProcess>
        <bpmn:boundaryEvent id="Boundary_CrossScope" attachedToRef="Task_Nested">
          <bpmn:terminateEventDefinition id="Terminate_Boundary" />
        </bpmn:boundaryEvent>
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BPMN_INVALID_BOUNDARY_ATTACHMENT',
        elementId: 'Boundary_CrossScope'
      }),
      expect.objectContaining({
        code: 'BPMN_INVALID_EVENT_DEFINITION',
        elementId: 'Boundary_CrossScope'
      })
    ]));
  });

  it('enforces boundary interruption and cancel-host constraints', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_Boundary_Semantics">
        <bpmn:task id="Task_Regular" />
        <bpmn:transaction id="Transaction_Cancel" />
        <bpmn:boundaryEvent id="Boundary_Cancel_Task" attachedToRef="Task_Regular">
          <bpmn:cancelEventDefinition id="Cancel_Task" />
        </bpmn:boundaryEvent>
        <bpmn:boundaryEvent id="Boundary_Cancel_NonInterrupting"
          attachedToRef="Transaction_Cancel" cancelActivity="false">
          <bpmn:cancelEventDefinition id="Cancel_NonInterrupting" />
        </bpmn:boundaryEvent>
        <bpmn:boundaryEvent id="Boundary_Compensation_Interrupting"
          attachedToRef="Task_Regular" cancelActivity="true">
          <bpmn:compensateEventDefinition id="Compensation_Interrupting" />
        </bpmn:boundaryEvent>
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BPMN_INVALID_BOUNDARY_ATTACHMENT',
        elementId: 'Boundary_Cancel_Task'
      }),
      expect.objectContaining({
        code: 'BPMN_INVALID_BOUNDARY_INTERRUPTION',
        elementId: 'Boundary_Cancel_NonInterrupting'
      }),
      expect.objectContaining({
        code: 'BPMN_INVALID_BOUNDARY_INTERRUPTION',
        elementId: 'Boundary_Compensation_Interrupting'
      })
    ]));
  });

  it('rejects event-subprocess-only start definitions on top-level processes', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_Start">
        <bpmn:startEvent id="Start_Error">
          <bpmn:errorEventDefinition id="Error_Start" />
        </bpmn:startEvent>
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BPMN_INVALID_EVENT_DEFINITION', elementId: 'Start_Error' })
    ]));
  });

  it('detects lane references outside their containing process scope', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:process id="Process_Lanes">
        <bpmn:laneSet id="LaneSet_One">
          <bpmn:lane id="Lane_One">
            <bpmn:flowNodeRef>Task_Other</bpmn:flowNodeRef>
          </bpmn:lane>
        </bpmn:laneSet>
        <bpmn:task id="Task_Local" />
      </bpmn:process>
      <bpmn:process id="Process_Other">
        <bpmn:task id="Task_Other" />
      </bpmn:process>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'BPMN_INVALID_LANE_REFERENCE', elementId: 'Lane_One' })
    ]));
  });

  it('does not apply sequence-flow connectivity guidance to participants or artifacts', async () => {
    const xml = definitions(`
      <bpmn:collaboration id="Collaboration_BlackBoxes">
        <bpmn:participant id="Participant_Requester" />
        <bpmn:participant id="Participant_Provider" />
        <bpmn:messageFlow id="Message_Request" sourceRef="Participant_Requester" targetRef="Participant_Provider" />
        <bpmn:textAnnotation id="Annotation_Context"><bpmn:text>Context</bpmn:text></bpmn:textAnnotation>
      </bpmn:collaboration>`);
    const result = await validator.validate(xml, 'full');

    expect(result.errors).toEqual([]);
    expect(result.issues.filter(issue =>
      ['Participant_Requester', 'Participant_Provider', 'Annotation_Context'].includes(issue.elementId || '')
    )).toEqual([]);
  });

  it('rejects message flow endpoints owned by another collaboration', async () => {
    const result = await validator.validate(definitions(`
      <bpmn:collaboration id="Collaboration_One">
        <bpmn:participant id="Participant_One" />
        <bpmn:messageFlow id="Message_Cross" sourceRef="Participant_One" targetRef="Participant_Two" />
      </bpmn:collaboration>
      <bpmn:collaboration id="Collaboration_Two">
        <bpmn:participant id="Participant_Two" />
      </bpmn:collaboration>`), 'semantic');

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'BPMN_MESSAGE_FLOW_OUTSIDE_COLLABORATION',
        elementId: 'Message_Cross'
      })
    ]));
  });

  it('uses the requested level through the validate tool handler', async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'mcp-bpmn-validator-'));
    const engine = new SimpleBpmnEngine(directory);
    try {
      const context = await engine.createProcess('Handler validation');
      await engine.createElement(context.id, { type: 'bpmn:Task', name: 'Disconnected' });
      diagramContext.setCurrent(context, context.name);
      const handler = new BpmnRequestHandler(engine);

      const syntaxResult = await handler.handleRequest('validate', { level: 'syntax' });
      const fullResult = await handler.handleRequest('validate', { level: 'full' });
      const syntax = JSON.parse((syntaxResult.content[0] as { text: string }).text);
      const full = JSON.parse((fullResult.content[0] as { text: string }).text);

      expect(syntax).toMatchObject({ level: 'syntax', issues: [] });
      expect(issueCodes(full)).toEqual(expect.arrayContaining([
        'BPMN_PROFILE_MISSING_START_EVENT',
        'BPMN_PROFILE_MISSING_END_EVENT'
      ]));
    } finally {
      diagramContext.clear();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['process', join(process.cwd(), 'tests', 'fixtures', 'simple-process.bpmn')],
    ['collaboration', join(process.cwd(), 'tests', 'fixtures', 'collaboration', 'two-pool.bpmn')]
  ])('returns no errors for the valid %s fixture at every level', async (_name, fixturePath) => {
    const xml = await fs.readFile(fixturePath, 'utf8');

    for (const level of ['syntax', 'semantic', 'full'] as const) {
      const result = await validator.validate(xml, level);
      expect(result.errors).toEqual([]);
    }
  });
});
