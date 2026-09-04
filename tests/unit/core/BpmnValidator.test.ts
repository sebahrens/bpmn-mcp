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

  // Every rule below was reachable but untriggered by any test (mcp-bpmn-5e7.6).
  // Each row pairs the smallest document that violates the rule with a legal
  // twin of the same shape. The violation pins the code *and* the element it
  // names, so a rule that fires on the wrong object fails here; the twin must
  // validate completely clean, so a rule that over-fires fails here too.
  interface ValidatorRuleCase {
    code: string;
    elementId: string;
    violation: string;
    twin: string;
  }

  const ruleCases: ValidatorRuleCase[] = [
    {
      code: 'BPMN_INVALID_PARTICIPANT_PROCESS_REF',
      elementId: 'Participant_BadRef',
      violation: definitions(`
        <bpmn:process id="Process_Real" />
        <bpmn:globalTask id="GlobalTask_Fake" />
        <bpmn:collaboration id="Collaboration_BadRef">
          <bpmn:participant id="Participant_BadRef" processRef="GlobalTask_Fake" />
        </bpmn:collaboration>`),
      twin: definitions(`
        <bpmn:process id="Process_Real" />
        <bpmn:globalTask id="GlobalTask_Unused" />
        <bpmn:collaboration id="Collaboration_GoodRef">
          <bpmn:participant id="Participant_GoodRef" processRef="Process_Real" />
        </bpmn:collaboration>`)
    },
    {
      code: 'BPMN_DUPLICATE_PARTICIPANT_PROCESS',
      elementId: 'Participant_Second',
      violation: definitions(`
        <bpmn:process id="Process_Shared" />
        <bpmn:collaboration id="Collaboration_Duplicate">
          <bpmn:participant id="Participant_First" processRef="Process_Shared" />
          <bpmn:participant id="Participant_Second" processRef="Process_Shared" />
        </bpmn:collaboration>`),
      twin: definitions(`
        <bpmn:process id="Process_One" />
        <bpmn:process id="Process_Two" />
        <bpmn:collaboration id="Collaboration_Distinct">
          <bpmn:participant id="Participant_First" processRef="Process_One" />
          <bpmn:participant id="Participant_Second" processRef="Process_Two" />
        </bpmn:collaboration>`)
    },
    {
      code: 'BPMN_INVALID_SEQUENCE_FLOW_ENDPOINT',
      elementId: 'Flow_BadEndpoint',
      violation: definitions(`
        <bpmn:process id="Process_Endpoint">
          <bpmn:task id="Task_Endpoint" />
          <bpmn:dataObjectReference id="DataObjectReference_Endpoint" />
          <bpmn:sequenceFlow id="Flow_BadEndpoint"
            sourceRef="Task_Endpoint" targetRef="DataObjectReference_Endpoint" />
        </bpmn:process>`),
      // A data object is reached by a data association, never by a sequence flow.
      twin: definitions(`
        <bpmn:process id="Process_Endpoint">
          <bpmn:task id="Task_Endpoint">
            <bpmn:dataInputAssociation id="DataInputAssociation_Endpoint">
              <bpmn:sourceRef>DataObjectReference_Endpoint</bpmn:sourceRef>
            </bpmn:dataInputAssociation>
          </bpmn:task>
          <bpmn:task id="Task_Downstream" />
          <bpmn:dataObjectReference id="DataObjectReference_Endpoint" />
          <bpmn:sequenceFlow id="Flow_GoodEndpoint"
            sourceRef="Task_Endpoint" targetRef="Task_Downstream" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_SAME_PROCESS_MESSAGE_FLOW',
      elementId: 'MessageFlow_Same',
      violation: definitions(`
        <bpmn:process id="Process_M1">
          <bpmn:task id="Task_M1a" />
          <bpmn:task id="Task_M1b" />
        </bpmn:process>
        <bpmn:process id="Process_M2"><bpmn:task id="Task_M2" /></bpmn:process>
        <bpmn:collaboration id="Collaboration_Same">
          <bpmn:participant id="Participant_M1" processRef="Process_M1" />
          <bpmn:participant id="Participant_M2" processRef="Process_M2" />
          <bpmn:messageFlow id="MessageFlow_Same" sourceRef="Task_M1a" targetRef="Task_M1b" />
        </bpmn:collaboration>`),
      twin: definitions(`
        <bpmn:process id="Process_M1">
          <bpmn:task id="Task_M1a" />
          <bpmn:task id="Task_M1b" />
        </bpmn:process>
        <bpmn:process id="Process_M2"><bpmn:task id="Task_M2" /></bpmn:process>
        <bpmn:collaboration id="Collaboration_Cross">
          <bpmn:participant id="Participant_M1" processRef="Process_M1" />
          <bpmn:participant id="Participant_M2" processRef="Process_M2" />
          <bpmn:messageFlow id="MessageFlow_Cross" sourceRef="Task_M1a" targetRef="Task_M2" />
        </bpmn:collaboration>`)
    },
    {
      code: 'BPMN_START_EVENT_HAS_INCOMING_FLOW',
      elementId: 'Start_WithIncoming',
      violation: definitions(`
        <bpmn:process id="Process_StartIn">
          <bpmn:task id="Task_StartIn" />
          <bpmn:startEvent id="Start_WithIncoming" />
          <bpmn:sequenceFlow id="Flow_IntoStart"
            sourceRef="Task_StartIn" targetRef="Start_WithIncoming" />
        </bpmn:process>`),
      twin: definitions(`
        <bpmn:process id="Process_StartIn">
          <bpmn:startEvent id="Start_Clean" />
          <bpmn:task id="Task_StartIn" />
          <bpmn:sequenceFlow id="Flow_FromStart"
            sourceRef="Start_Clean" targetRef="Task_StartIn" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_END_EVENT_HAS_OUTGOING_FLOW',
      elementId: 'End_WithOutgoing',
      violation: definitions(`
        <bpmn:process id="Process_EndOut">
          <bpmn:endEvent id="End_WithOutgoing" />
          <bpmn:task id="Task_EndOut" />
          <bpmn:sequenceFlow id="Flow_OutOfEnd"
            sourceRef="End_WithOutgoing" targetRef="Task_EndOut" />
        </bpmn:process>`),
      twin: definitions(`
        <bpmn:process id="Process_EndOut">
          <bpmn:task id="Task_EndOut" />
          <bpmn:endEvent id="End_Clean" />
          <bpmn:sequenceFlow id="Flow_ToEnd"
            sourceRef="Task_EndOut" targetRef="End_Clean" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_BOUNDARY_EVENT_HAS_INCOMING_FLOW',
      elementId: 'Boundary_WithIncoming',
      violation: definitions(`
        <bpmn:process id="Process_BoundaryIn">
          <bpmn:task id="Task_Host" />
          <bpmn:task id="Task_Other" />
          <bpmn:boundaryEvent id="Boundary_WithIncoming" attachedToRef="Task_Host">
            <bpmn:timerEventDefinition id="Timer_Boundary" />
          </bpmn:boundaryEvent>
          <bpmn:sequenceFlow id="Flow_IntoBoundary"
            sourceRef="Task_Other" targetRef="Boundary_WithIncoming" />
        </bpmn:process>`),
      // A boundary event is entered by attachment, so only outgoing flows are legal.
      twin: definitions(`
        <bpmn:process id="Process_BoundaryIn">
          <bpmn:task id="Task_Host" />
          <bpmn:task id="Task_Handler" />
          <bpmn:boundaryEvent id="Boundary_Clean" attachedToRef="Task_Host">
            <bpmn:timerEventDefinition id="Timer_Boundary" />
          </bpmn:boundaryEvent>
          <bpmn:sequenceFlow id="Flow_FromBoundary"
            sourceRef="Boundary_Clean" targetRef="Task_Handler" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_EVENT_SUBPROCESS_HAS_SEQUENCE_FLOW',
      elementId: 'SubProcess_Event',
      violation: definitions(`
        <bpmn:process id="Process_EventSub">
          <bpmn:task id="Task_EventSub" />
          <bpmn:subProcess id="SubProcess_Event" triggeredByEvent="true">
            <bpmn:startEvent id="Start_EventSub">
              <bpmn:errorEventDefinition id="Error_EventSub" />
            </bpmn:startEvent>
          </bpmn:subProcess>
          <bpmn:sequenceFlow id="Flow_IntoEventSub"
            sourceRef="Task_EventSub" targetRef="SubProcess_Event" />
        </bpmn:process>`),
      // The same flow into an ordinary subprocess is legal; only the
      // triggeredByEvent variant may not be wired into the parent's flow.
      twin: definitions(`
        <bpmn:process id="Process_EventSub">
          <bpmn:task id="Task_EventSub" />
          <bpmn:subProcess id="SubProcess_Plain">
            <bpmn:task id="Task_Inside" />
          </bpmn:subProcess>
          <bpmn:subProcess id="SubProcess_Event" triggeredByEvent="true">
            <bpmn:startEvent id="Start_EventSub">
              <bpmn:errorEventDefinition id="Error_EventSub" />
            </bpmn:startEvent>
          </bpmn:subProcess>
          <bpmn:sequenceFlow id="Flow_IntoPlainSub"
            sourceRef="Task_EventSub" targetRef="SubProcess_Plain" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_INVALID_EVENT_SUBPROCESS_START',
      elementId: 'SubProcess_PlainStart',
      violation: definitions(`
        <bpmn:process id="Process_EventSubStart">
          <bpmn:subProcess id="SubProcess_PlainStart" triggeredByEvent="true">
            <bpmn:startEvent id="Start_Plain" />
          </bpmn:subProcess>
        </bpmn:process>`),
      twin: definitions(`
        <bpmn:process id="Process_EventSubStart">
          <bpmn:subProcess id="SubProcess_EventStart" triggeredByEvent="true">
            <bpmn:startEvent id="Start_Error">
              <bpmn:errorEventDefinition id="Error_Start" />
            </bpmn:startEvent>
          </bpmn:subProcess>
        </bpmn:process>`)
    },
    {
      code: 'BPMN_MISSING_EVENT_DEFINITION',
      elementId: 'Boundary_NoDefinition',
      violation: definitions(`
        <bpmn:process id="Process_BoundaryDefinition">
          <bpmn:task id="Task_BoundaryHost" />
          <bpmn:boundaryEvent id="Boundary_NoDefinition" attachedToRef="Task_BoundaryHost" />
        </bpmn:process>`),
      // A boundary event only interrupts or observes its activity when
      // something triggers it; the same event with a trigger is legal.
      twin: definitions(`
        <bpmn:process id="Process_BoundaryDefinition">
          <bpmn:task id="Task_BoundaryHost" />
          <bpmn:boundaryEvent id="Boundary_Triggered" attachedToRef="Task_BoundaryHost">
            <bpmn:timerEventDefinition id="Timer_BoundaryTriggered" />
          </bpmn:boundaryEvent>
        </bpmn:process>`)
    },
    {
      code: 'BPMN_MISSING_EVENT_DEFINITION',
      elementId: 'Catch_NoDefinition',
      violation: definitions(`
        <bpmn:process id="Process_CatchDefinition">
          <bpmn:task id="Task_BeforeCatch" />
          <bpmn:intermediateCatchEvent id="Catch_NoDefinition" />
          <bpmn:sequenceFlow id="Flow_ToCatch"
            sourceRef="Task_BeforeCatch" targetRef="Catch_NoDefinition" />
        </bpmn:process>`),
      // An intermediate catch event waits for a trigger, so it needs one; an
      // intermediate throw event is reached by control flow and stays legal
      // with no definition at all.
      twin: definitions(`
        <bpmn:process id="Process_CatchDefinition">
          <bpmn:task id="Task_BeforeCatch" />
          <bpmn:intermediateCatchEvent id="Catch_Message">
            <bpmn:messageEventDefinition id="Message_Catch" />
          </bpmn:intermediateCatchEvent>
          <bpmn:intermediateThrowEvent id="Throw_Bare" />
          <bpmn:sequenceFlow id="Flow_ToCatch"
            sourceRef="Task_BeforeCatch" targetRef="Catch_Message" />
          <bpmn:sequenceFlow id="Flow_ToThrow"
            sourceRef="Catch_Message" targetRef="Throw_Bare" />
        </bpmn:process>`)
    },
    {
      code: 'BPMN_DUPLICATE_LANE_ASSIGNMENT',
      elementId: 'Lane_Second',
      violation: definitions(`
        <bpmn:process id="Process_DuplicateLane">
          <bpmn:laneSet id="LaneSet_Duplicate">
            <bpmn:lane id="Lane_First"><bpmn:flowNodeRef>Task_Duplicate</bpmn:flowNodeRef></bpmn:lane>
            <bpmn:lane id="Lane_Second"><bpmn:flowNodeRef>Task_Duplicate</bpmn:flowNodeRef></bpmn:lane>
          </bpmn:laneSet>
          <bpmn:task id="Task_Duplicate" />
        </bpmn:process>`),
      twin: definitions(`
        <bpmn:process id="Process_DuplicateLane">
          <bpmn:laneSet id="LaneSet_Clean">
            <bpmn:lane id="Lane_First"><bpmn:flowNodeRef>Task_First</bpmn:flowNodeRef></bpmn:lane>
            <bpmn:lane id="Lane_Second"><bpmn:flowNodeRef>Task_Second</bpmn:flowNodeRef></bpmn:lane>
          </bpmn:laneSet>
          <bpmn:task id="Task_First" />
          <bpmn:task id="Task_Second" />
        </bpmn:process>`)
    }
  ];

  it.each(ruleCases)(
    'raises $code on $elementId and leaves its legal twin clean',
    async ({ code, elementId, violation, twin }) => {
      const flagged = await validator.validate(violation, 'semantic');

      expect(flagged.valid).toBe(false);
      expect(flagged.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code, severity: 'error', elementId })
      ]));
      // The rule must name this object and only this object.
      expect(flagged.errors.filter(issue => issue.code === code).map(issue => issue.elementId))
        .toEqual([elementId]);

      const clean = await validator.validate(twin, 'semantic');

      expect(issueCodes(clean)).not.toContain(code);
      expect(clean.errors).toEqual([]);
      expect(clean.valid).toBe(true);
    }
  );

  describe('BPMN_MISSING_EVENT_DEFINITION', () => {
    // The schema offers two ways to give a catch event its trigger: an inline
    // eventDefinition, or eventDefinitionRef pointing at a root-level one that
    // several events share. Reading only the inline form would report every
    // document using the shared form as broken.
    it('accepts a catch event whose trigger is a referenced root-level definition', async () => {
      const shared = definitions(`
        <bpmn:signalEventDefinition id="Signal_Shared" />
        <bpmn:process id="Process_SharedDefinition" isExecutable="true">
          <bpmn:startEvent id="Start_Shared" />
          <bpmn:intermediateCatchEvent id="Catch_Shared">
            <bpmn:eventDefinitionRef>Signal_Shared</bpmn:eventDefinitionRef>
          </bpmn:intermediateCatchEvent>
          <bpmn:endEvent id="End_Shared" />
          <bpmn:sequenceFlow id="Flow_Shared_1" sourceRef="Start_Shared" targetRef="Catch_Shared" />
          <bpmn:sequenceFlow id="Flow_Shared_2" sourceRef="Catch_Shared" targetRef="End_Shared" />
        </bpmn:process>`);

      const result = await validator.validate(shared, 'full');

      expect(issueCodes(result)).not.toContain('BPMN_MISSING_EVENT_DEFINITION');
      expect(result.errors).toEqual([]);
    });

    it('leaves start, end and intermediate throw events without a definition alone', async () => {
      const plainEvents = definitions(`
        <bpmn:process id="Process_PlainEvents" isExecutable="true">
          <bpmn:startEvent id="Start_Plain" />
          <bpmn:intermediateThrowEvent id="Throw_Plain" />
          <bpmn:endEvent id="End_Plain" />
          <bpmn:sequenceFlow id="Flow_Plain_1" sourceRef="Start_Plain" targetRef="Throw_Plain" />
          <bpmn:sequenceFlow id="Flow_Plain_2" sourceRef="Throw_Plain" targetRef="End_Plain" />
        </bpmn:process>`);

      const result = await validator.validate(plainEvents, 'full');

      expect(issueCodes(result)).not.toContain('BPMN_MISSING_EVENT_DEFINITION');
      expect(result.errors).toEqual([]);
    });
  });

  describe('BPMN_INVALID_DEFINITIONS', () => {
    // bpmn-moddle 9 always parses a document as bpmn:Definitions and throws
    // ("failed to parse document as <bpmn:Definitions>") for any other root, so
    // BPMN_PARSE_ERROR shadows this guard for every real XML input. The guard
    // still protects the rest of validate() from a non-Definitions root, so it
    // is exercised through the parser seam rather than left unpinned.
    function validatorWithRoot(rootElement: unknown): BpmnValidator {
      const stubbed = new BpmnValidator();
      (stubbed as unknown as { moddle: unknown }).moddle = {
        fromXML: () => Promise.resolve({
          rootElement,
          elementsById: {},
          references: [],
          warnings: []
        })
      };
      return stubbed;
    }

    const anyXml = definitions('<bpmn:process id="Process_Ignored" />');

    it('reports the offending root when the document root is not bpmn:Definitions', async () => {
      const result = await validatorWithRoot({ $type: 'bpmn:Process', id: 'Process_Root' })
        .validate(anyXml, 'semantic');

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_DEFINITIONS',
          severity: 'error',
          elementId: 'Process_Root'
        })
      ]);
      expect(result.valid).toBe(false);
    });

    it('does not report it for a bpmn:Definitions root', async () => {
      const result = await validatorWithRoot({
        $type: 'bpmn:Definitions',
        id: 'Definitions_Root',
        rootElements: []
      }).validate(anyXml, 'semantic');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_DEFINITIONS');
      expect(result.errors).toEqual([]);
    });
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

  it.each(['source', 'target'] as const)(
    'rejects a gateway used as a message-flow %s with a stable issue code',
    async endpoint => {
      const sourceRef = endpoint === 'source' ? 'Gateway_Invalid' : 'Task_Source';
      const targetRef = endpoint === 'target' ? 'Gateway_Invalid' : 'Task_Target';
      const result = await validator.validate(definitions(`
        <bpmn:process id="Process_Source"><bpmn:task id="Task_Source" /></bpmn:process>
        <bpmn:process id="Process_Target">
          <bpmn:task id="Task_Target" />
          <bpmn:exclusiveGateway id="Gateway_Invalid" />
        </bpmn:process>
        <bpmn:collaboration id="Collaboration_InvalidMessage">
          <bpmn:participant id="Participant_Source" processRef="Process_Source" />
          <bpmn:participant id="Participant_Target" processRef="Process_Target" />
          <bpmn:messageFlow id="Message_Invalid" sourceRef="${sourceRef}" targetRef="${targetRef}" />
        </bpmn:collaboration>`), 'semantic');

      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'BPMN_INVALID_MESSAGE_FLOW_ENDPOINT',
          elementId: 'Message_Invalid'
        })
      ]));
    }
  );

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
      const syntax = (syntaxResult.structuredContent as Record<string, any>);
      const full = (fullResult.structuredContent as Record<string, any>);

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

  describe('executable profile guidance', () => {
    // An event subprocess is triggered by its own start event, never by a
    // sequence flow from the enclosing scope — the semantic rule
    // BPMN_EVENT_SUBPROCESS_HAS_SEQUENCE_FLOW rejects exactly the wiring these
    // warnings used to ask for. An ad-hoc subprocess coordinates unordered
    // activities and needs neither a start nor an end event.
    const eventSubprocess = definitions(`
      <bpmn:process id="Process_EventSubProfile" isExecutable="true">
        <bpmn:startEvent id="Start_Profile" />
        <bpmn:task id="Task_Profile" />
        <bpmn:endEvent id="End_Profile" />
        <bpmn:sequenceFlow id="Flow_P1" sourceRef="Start_Profile" targetRef="Task_Profile" />
        <bpmn:sequenceFlow id="Flow_P2" sourceRef="Task_Profile" targetRef="End_Profile" />
        <bpmn:subProcess id="SubProcess_EventProfile" triggeredByEvent="true">
          <bpmn:startEvent id="Start_EventProfile">
            <bpmn:errorEventDefinition id="Error_EventProfile" />
          </bpmn:startEvent>
          <bpmn:endEvent id="End_EventProfile" />
          <bpmn:sequenceFlow id="Flow_EventProfile"
            sourceRef="Start_EventProfile" targetRef="End_EventProfile" />
        </bpmn:subProcess>
      </bpmn:process>`);

    const adHocSubprocess = definitions(`
      <bpmn:process id="Process_AdHocProfile" isExecutable="true">
        <bpmn:startEvent id="Start_AdHocProfile" />
        <bpmn:adHocSubProcess id="SubProcess_AdHocProfile">
          <bpmn:task id="Task_AdHocA" />
          <bpmn:task id="Task_AdHocB" />
        </bpmn:adHocSubProcess>
        <bpmn:endEvent id="End_AdHocProfile" />
        <bpmn:sequenceFlow id="Flow_AdHoc1"
          sourceRef="Start_AdHocProfile" targetRef="SubProcess_AdHocProfile" />
        <bpmn:sequenceFlow id="Flow_AdHoc2"
          sourceRef="SubProcess_AdHocProfile" targetRef="End_AdHocProfile" />
      </bpmn:process>`);

    it('does not ask an event subprocess for incoming or outgoing sequence flows', async () => {
      const result = await validator.validate(eventSubprocess, 'full');

      expect(result.issues.filter(issue => issue.elementId === 'SubProcess_EventProfile'))
        .toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('does not ask an ad-hoc subprocess for a start or end event', async () => {
      const result = await validator.validate(adHocSubprocess, 'full');

      expect(result.issues.filter(issue => issue.elementId === 'SubProcess_AdHocProfile'))
        .toEqual([]);
      expect(result.errors).toEqual([]);
    });

    it('does not ask activities inside an ad-hoc subprocess for sequence flows', async () => {
      const result = await validator.validate(adHocSubprocess, 'full');
      const offenders = result.issues.filter(issue =>
        ['Task_AdHocA', 'Task_AdHocB'].includes(issue.elementId || ''));

      expect(offenders).toEqual([]);
    });

    it('still asks activities inside an ordinary subprocess for sequence flows', async () => {
      const plain = definitions(`
        <bpmn:process id="Process_PlainInner" isExecutable="true">
          <bpmn:startEvent id="Start_PlainInner" />
          <bpmn:subProcess id="SubProcess_PlainInner">
            <bpmn:startEvent id="Start_Inner" />
            <bpmn:task id="Task_InnerA" />
            <bpmn:endEvent id="End_Inner" />
            <bpmn:sequenceFlow id="Flow_Inner"
              sourceRef="Start_Inner" targetRef="End_Inner" />
          </bpmn:subProcess>
          <bpmn:endEvent id="End_PlainInner" />
          <bpmn:sequenceFlow id="Flow_Inner1"
            sourceRef="Start_PlainInner" targetRef="SubProcess_PlainInner" />
          <bpmn:sequenceFlow id="Flow_Inner2"
            sourceRef="SubProcess_PlainInner" targetRef="End_PlainInner" />
        </bpmn:process>`);

      const result = await validator.validate(plain, 'full');
      const flagged = result.issues
        .filter(issue => issue.elementId === 'Task_InnerA')
        .map(issue => issue.code)
        .sort();

      expect(flagged).toEqual([
        'BPMN_PROFILE_MISSING_INCOMING_FLOW',
        'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
      ]);
    });

    it('still asks an ordinary disconnected subprocess for incoming and outgoing flows',
      async () => {
        const plain = definitions(`
          <bpmn:process id="Process_PlainProfile" isExecutable="true">
            <bpmn:startEvent id="Start_PlainProfile" />
            <bpmn:endEvent id="End_PlainProfile" />
            <bpmn:sequenceFlow id="Flow_PlainProfile"
              sourceRef="Start_PlainProfile" targetRef="End_PlainProfile" />
            <bpmn:subProcess id="SubProcess_PlainProfile">
              <bpmn:startEvent id="Start_InnerPlain" />
              <bpmn:endEvent id="End_InnerPlain" />
              <bpmn:sequenceFlow id="Flow_InnerPlain"
                sourceRef="Start_InnerPlain" targetRef="End_InnerPlain" />
            </bpmn:subProcess>
          </bpmn:process>`);

        const result = await validator.validate(plain, 'full');
        const flagged = result.issues
          .filter(issue => issue.elementId === 'SubProcess_PlainProfile')
          .map(issue => issue.code)
          .sort();

        expect(flagged).toEqual([
          'BPMN_PROFILE_MISSING_INCOMING_FLOW',
          'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
        ]);
      });

    it('still asks an ordinary subprocess scope for a start and an end event', async () => {
      const plain = definitions(`
        <bpmn:process id="Process_PlainScope" isExecutable="true">
          <bpmn:startEvent id="Start_PlainScope" />
          <bpmn:subProcess id="SubProcess_PlainScope">
            <bpmn:task id="Task_InnerScope" />
          </bpmn:subProcess>
          <bpmn:endEvent id="End_PlainScope" />
          <bpmn:sequenceFlow id="Flow_Scope1"
            sourceRef="Start_PlainScope" targetRef="SubProcess_PlainScope" />
          <bpmn:sequenceFlow id="Flow_Scope2"
            sourceRef="SubProcess_PlainScope" targetRef="End_PlainScope" />
        </bpmn:process>`);

      const result = await validator.validate(plain, 'full');
      const flagged = result.issues
        .filter(issue => issue.elementId === 'SubProcess_PlainScope')
        .map(issue => issue.code)
        .sort();

      expect(flagged).toEqual([
        'BPMN_PROFILE_MISSING_END_EVENT',
        'BPMN_PROFILE_MISSING_START_EVENT'
      ]);
    });
  });

  describe('compensation handlers', () => {
    // The pattern the tool surface advertises: a compensation boundary event on
    // "Reserve stock", joined by an Association to the "Release stock" handler.
    // The handler sits outside the sequence flow on purpose — asking it, or the
    // boundary event, for sequence flows asks for BPMN the spec forbids.
    const compensationModel = (handler: string, boundary: string): string => definitions(`
      <bpmn:process id="Process_Compensation" isExecutable="true">
        <bpmn:startEvent id="Start_Compensation" />
        <bpmn:task id="Task_Reserve" name="Reserve stock" />
        <bpmn:endEvent id="End_Compensation" />
        <bpmn:sequenceFlow id="Flow_Compensation1"
          sourceRef="Start_Compensation" targetRef="Task_Reserve" />
        <bpmn:sequenceFlow id="Flow_Compensation2"
          sourceRef="Task_Reserve" targetRef="End_Compensation" />
        <bpmn:boundaryEvent id="Boundary_Compensation"
          attachedToRef="Task_Reserve" cancelActivity="false">
          ${boundary}
        </bpmn:boundaryEvent>
        ${handler}
        <bpmn:association id="Association_Compensation"
          sourceRef="Boundary_Compensation" targetRef="Task_Release"
          associationDirection="One" />
      </bpmn:process>`);

    const compensateDefinition = '<bpmn:compensateEventDefinition id="Compensate_Reserve" />';
    const releaseTask = '<bpmn:task id="Task_Release" name="Release stock" />';

    it('does not ask a compensation handler or its boundary event for sequence flows',
      async () => {
        const result = await validator.validate(
          compensationModel(releaseTask, compensateDefinition),
          'full'
        );
        const offenders = result.issues.filter(issue =>
          ['Task_Release', 'Boundary_Compensation'].includes(issue.elementId || ''));

        expect(offenders).toEqual([]);
        expect(result.errors).toEqual([]);
      });

    it('exempts a handler marked isForCompensation even with no association', async () => {
      const result = await validator.validate(definitions(`
        <bpmn:process id="Process_MarkedHandler" isExecutable="true">
          <bpmn:startEvent id="Start_Marked" />
          <bpmn:task id="Task_Marked" />
          <bpmn:endEvent id="End_Marked" />
          <bpmn:sequenceFlow id="Flow_Marked1" sourceRef="Start_Marked" targetRef="Task_Marked" />
          <bpmn:sequenceFlow id="Flow_Marked2" sourceRef="Task_Marked" targetRef="End_Marked" />
          <bpmn:task id="Task_Undo" isForCompensation="true" />
        </bpmn:process>`), 'full');
      const offenders = result.issues.filter(issue => issue.elementId === 'Task_Undo');

      expect(offenders).toEqual([]);
    });

    it('still asks a task associated with a non-compensation boundary event for its flows',
      async () => {
        const result = await validator.validate(
          compensationModel(releaseTask, '<bpmn:errorEventDefinition id="Error_Reserve" />'),
          'full'
        );
        const flagged = result.issues
          .filter(issue => issue.elementId === 'Task_Release')
          .map(issue => issue.code)
          .sort();

        expect(flagged).toEqual([
          'BPMN_PROFILE_MISSING_INCOMING_FLOW',
          'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
        ]);
      });

    it('still asks a disconnected task alongside a compensation handler for its flows',
      async () => {
        const result = await validator.validate(
          compensationModel(`${releaseTask}<bpmn:task id="Task_Stranded" />`, compensateDefinition),
          'full'
        );
        const flagged = result.issues
          .filter(issue => issue.elementId === 'Task_Stranded')
          .map(issue => issue.code)
          .sort();

        expect(flagged).toEqual([
          'BPMN_PROFILE_MISSING_INCOMING_FLOW',
          'BPMN_PROFILE_MISSING_OUTGOING_FLOW'
        ]);
      });
  });

  describe('subprocess scope resolution', () => {
    const subprocessFlows = definitions(`
      <bpmn:process id="Process_Scope" isExecutable="true">
        <bpmn:startEvent id="Start_Scope" />
        <bpmn:subProcess id="SubProcess_Scope">
          <bpmn:startEvent id="Inner_Start" />
          <bpmn:task id="Inner_Task" />
          <bpmn:endEvent id="Inner_End" />
          <bpmn:sequenceFlow id="Inner_Flow_1" sourceRef="Inner_Start" targetRef="Inner_Task" />
          <bpmn:sequenceFlow id="Inner_Flow_2" sourceRef="Inner_Task" targetRef="Inner_End" />
        </bpmn:subProcess>
        <bpmn:endEvent id="End_Scope" />
        <bpmn:sequenceFlow id="Flow_Into" sourceRef="Start_Scope" targetRef="SubProcess_Scope" />
        <bpmn:sequenceFlow id="Flow_OutOf" sourceRef="SubProcess_Scope" targetRef="End_Scope" />
      </bpmn:process>`);

    it('accepts sequence flows into and out of a subprocess', async () => {
      const result = await validator.validate(subprocessFlows, 'full');

      expect(result.errors).toEqual([]);
      expect(issueCodes(result)).not.toContain('BPMN_CROSS_SCOPE_SEQUENCE_FLOW');
      expect(result.valid).toBe(true);
    });

    it('accepts a lane that references a subprocess in its own scope', async () => {
      const lanedSubprocess = definitions(`
        <bpmn:process id="Process_Laned" isExecutable="true">
          <bpmn:laneSet id="LaneSet_Laned">
            <bpmn:lane id="Lane_Owner" name="Owner">
              <bpmn:flowNodeRef>Start_Laned</bpmn:flowNodeRef>
              <bpmn:flowNodeRef>SubProcess_Laned</bpmn:flowNodeRef>
            </bpmn:lane>
          </bpmn:laneSet>
          <bpmn:startEvent id="Start_Laned" />
          <bpmn:subProcess id="SubProcess_Laned">
            <bpmn:task id="Laned_Inner" />
          </bpmn:subProcess>
          <bpmn:sequenceFlow id="Flow_Laned" sourceRef="Start_Laned" targetRef="SubProcess_Laned" />
        </bpmn:process>`);

      const result = await validator.validate(lanedSubprocess, 'full');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_LANE_REFERENCE');
      expect(result.errors).toEqual([]);
    });

    it('accepts an association whose endpoint is a lane in the same process', async () => {
      const laneAssociation = definitions(`
        <bpmn:process id="Process_Assoc" isExecutable="true">
          <bpmn:laneSet id="LaneSet_Assoc">
            <bpmn:lane id="Lane_Assoc" name="Reviewer">
              <bpmn:flowNodeRef>Task_Assoc</bpmn:flowNodeRef>
            </bpmn:lane>
          </bpmn:laneSet>
          <bpmn:task id="Task_Assoc" />
          <bpmn:association id="Association_Assoc" sourceRef="Lane_Assoc" targetRef="Task_Assoc" />
        </bpmn:process>`);

      const result = await validator.validate(laneAssociation, 'full');

      expect(issueCodes(result)).not.toContain('BPMN_ASSOCIATION_OUTSIDE_OWNER');
      expect(result.errors).toEqual([]);
    });

    it('still rejects a sequence flow that genuinely crosses a subprocess boundary', async () => {
      const crossing = definitions(`
        <bpmn:process id="Process_Crossing" isExecutable="true">
          <bpmn:startEvent id="Outer_Start" />
          <bpmn:subProcess id="SubProcess_Crossing">
            <bpmn:task id="Crossing_Inner" />
          </bpmn:subProcess>
          <bpmn:sequenceFlow id="Flow_Crossing" sourceRef="Outer_Start" targetRef="Crossing_Inner" />
        </bpmn:process>`);

      const result = await validator.validate(crossing, 'full');

      expect(issueCodes(result)).toContain('BPMN_CROSS_SCOPE_SEQUENCE_FLOW');
      expect(result.valid).toBe(false);
    });

    it('still rejects a lane that references a flow node from another scope', async () => {
      const straySubprocessMember = definitions(`
        <bpmn:process id="Process_Stray" isExecutable="true">
          <bpmn:laneSet id="LaneSet_Stray">
            <bpmn:lane id="Lane_Stray">
              <bpmn:flowNodeRef>Stray_Inner</bpmn:flowNodeRef>
            </bpmn:lane>
          </bpmn:laneSet>
          <bpmn:subProcess id="SubProcess_Stray">
            <bpmn:task id="Stray_Inner" />
          </bpmn:subProcess>
        </bpmn:process>`);

      const result = await validator.validate(straySubprocessMember, 'full');

      expect(issueCodes(result)).toContain('BPMN_INVALID_LANE_REFERENCE');
    });
  });

  describe('message flow direction', () => {
    const collaboration = (sourceRef: string, targetRef: string): string => definitions(`
      <bpmn:collaboration id="Collaboration_Direction">
        <bpmn:participant id="Participant_A" processRef="Process_A" />
        <bpmn:participant id="Participant_B" processRef="Process_B" />
        <bpmn:messageFlow id="MessageFlow_Direction" sourceRef="${sourceRef}" targetRef="${targetRef}" />
      </bpmn:collaboration>
      <bpmn:process id="Process_A" isExecutable="true">
        <bpmn:startEvent id="Start_A" />
        <bpmn:task id="Task_A" />
        <bpmn:endEvent id="End_A" />
        <bpmn:sequenceFlow id="Flow_A1" sourceRef="Start_A" targetRef="Task_A" />
        <bpmn:sequenceFlow id="Flow_A2" sourceRef="Task_A" targetRef="End_A" />
      </bpmn:process>
      <bpmn:process id="Process_B" isExecutable="true">
        <bpmn:startEvent id="Start_B" />
        <bpmn:task id="Task_B" />
        <bpmn:endEvent id="End_B" />
        <bpmn:sequenceFlow id="Flow_B1" sourceRef="Start_B" targetRef="Task_B" />
        <bpmn:sequenceFlow id="Flow_B2" sourceRef="Task_B" targetRef="End_B" />
      </bpmn:process>`);

    it('rejects a message flow that originates from a start event', async () => {
      const result = await validator.validate(collaboration('Start_A', 'Task_B'), 'semantic');

      expect(issueCodes(result)).toContain('BPMN_INVALID_MESSAGE_FLOW_DIRECTION');
      expect(result.valid).toBe(false);
    });

    it('rejects a message flow that targets an end event', async () => {
      const result = await validator.validate(collaboration('Task_A', 'End_B'), 'semantic');

      expect(issueCodes(result)).toContain('BPMN_INVALID_MESSAGE_FLOW_DIRECTION');
      expect(result.valid).toBe(false);
    });

    it.each([
      ['task to task', 'Task_A', 'Task_B'],
      ['end event to task', 'End_A', 'Task_B'],
      ['task to start event', 'Task_A', 'Start_B']
    ])('accepts a message flow from %s', async (_label, sourceRef, targetRef) => {
      const result = await validator.validate(collaboration(sourceRef, targetRef), 'semantic');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_MESSAGE_FLOW_DIRECTION');
    });
  });

  describe('shipped fixture corpus', () => {
    // Pins validator output for every fixture in the repository. Fixtures are
    // the corpus other suites build on, so a fixture the product's own
    // validator rejects is either a broken fixture or a validator false
    // positive; both should fail here rather than silently persist.
    const expectedErrorCodes: Record<string, string[]> = {
      'engine-contract/malformed.bpmn': ['BPMN_PARSE_ERROR'],
      'agent-geometry/imperfect-process.bpmn': ['BPMN_START_EVENT_HAS_INCOMING_FLOW'],
      // Deliberately imperfect: its message flow is named "wrong sender" and
      // originates from a start event.
      'agent-geometry/imperfect-collaboration.bpmn': ['BPMN_INVALID_MESSAGE_FLOW_DIRECTION']
    };

    const fixtureDirectories = [
      'layout',
      'engine-contract',
      'import-roundtrip',
      'collaboration',
      'dialects',
      'agent-geometry',
      'real-tools'
    ];

    it('reports only the intended errors across every shipped BPMN fixture', async () => {
      const root = join(process.cwd(), 'tests', 'fixtures');
      const actual: Record<string, string[]> = {};

      for (const directory of fixtureDirectories) {
        const entries = await fs.readdir(join(root, directory));
        for (const entry of entries.filter(name => name.endsWith('.bpmn'))) {
          const relative = `${directory}/${entry}`;
          const xml = await fs.readFile(join(root, directory, entry), 'utf8');
          const result = await validator.validate(xml, 'full');
          const codes = result.issues
            .filter(issue => issue.severity === 'error')
            .map(issue => issue.code);
          if (codes.length > 0) actual[relative] = [...new Set(codes)].sort();
        }
      }

      expect(actual).toEqual(expectedErrorCodes);
    });
  });

  describe('sequence flow condition and default rules', () => {
    const process = (body: string): string => definitions(`
      <bpmn:process id="Process_Rules" isExecutable="true">${body}</bpmn:process>`);

    it('rejects a conditional flow leaving a parallel gateway', async () => {
      const result = await validator.validate(process(`
        <bpmn:parallelGateway id="Gateway_Parallel" />
        <bpmn:task id="Task_Branch" />
        <bpmn:sequenceFlow id="Flow_Conditional"
          sourceRef="Gateway_Parallel" targetRef="Task_Branch">
          <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${ok}</bpmn:conditionExpression>
        </bpmn:sequenceFlow>`), 'semantic');

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_FLOW_CONDITION',
          elementId: 'Flow_Conditional'
        })
      ]);
    });

    it.each([
      ['an exclusive gateway', '<bpmn:exclusiveGateway id="Source_Node" />'],
      ['an inclusive gateway', '<bpmn:inclusiveGateway id="Source_Node" />'],
      ['a task', '<bpmn:task id="Source_Node" />']
    ])('accepts a conditional flow leaving %s', async (_label, source) => {
      const result = await validator.validate(process(`
        ${source}
        <bpmn:task id="Task_Branch" />
        <bpmn:sequenceFlow id="Flow_Conditional" sourceRef="Source_Node" targetRef="Task_Branch">
          <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${ok}</bpmn:conditionExpression>
        </bpmn:sequenceFlow>`), 'semantic');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_FLOW_CONDITION');
    });

    it('rejects a default flow that belongs to another node', async () => {
      const result = await validator.validate(process(`
        <bpmn:startEvent id="Start_Other" />
        <bpmn:exclusiveGateway id="Gateway_Default" default="Flow_Foreign" />
        <bpmn:task id="Task_After" />
        <bpmn:sequenceFlow id="Flow_Foreign" sourceRef="Start_Other" targetRef="Gateway_Default" />
        <bpmn:sequenceFlow id="Flow_Own" sourceRef="Gateway_Default" targetRef="Task_After" />`),
      'semantic');

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_DEFAULT_FLOW',
          elementId: 'Gateway_Default'
        })
      ]);
    });

    it('rejects a default flow that also carries a condition', async () => {
      const result = await validator.validate(process(`
        <bpmn:exclusiveGateway id="Gateway_Default" default="Flow_Own" />
        <bpmn:task id="Task_After" />
        <bpmn:sequenceFlow id="Flow_Own" sourceRef="Gateway_Default" targetRef="Task_After">
          <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${ok}</bpmn:conditionExpression>
        </bpmn:sequenceFlow>`), 'semantic');

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_DEFAULT_FLOW',
          elementId: 'Gateway_Default'
        })
      ]);
    });

    it('rejects a default flow on a parallel gateway', async () => {
      const result = await validator.validate(process(`
        <bpmn:parallelGateway id="Gateway_Parallel" default="Flow_Own" />
        <bpmn:task id="Task_After" />
        <bpmn:sequenceFlow id="Flow_Own" sourceRef="Gateway_Parallel" targetRef="Task_After" />`),
      'semantic');

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_DEFAULT_FLOW',
          elementId: 'Gateway_Parallel'
        })
      ]);
    });

    it('accepts a well-formed exclusive gateway with a default flow', async () => {
      const result = await validator.validate(process(`
        <bpmn:exclusiveGateway id="Gateway_Ok" default="Flow_Else" />
        <bpmn:task id="Task_Yes" />
        <bpmn:task id="Task_Else" />
        <bpmn:sequenceFlow id="Flow_Yes" sourceRef="Gateway_Ok" targetRef="Task_Yes">
          <bpmn:conditionExpression xsi:type="bpmn:tFormalExpression"
            xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\${ok}</bpmn:conditionExpression>
        </bpmn:sequenceFlow>
        <bpmn:sequenceFlow id="Flow_Else" sourceRef="Gateway_Ok" targetRef="Task_Else" />`),
      'semantic');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_DEFAULT_FLOW');
      expect(issueCodes(result)).not.toContain('BPMN_INVALID_FLOW_CONDITION');
    });
  });

  describe('event-based gateway targets', () => {
    const gatewayTo = (target: string): string => definitions(`
      <bpmn:process id="Process_EventGateway" isExecutable="true">
        <bpmn:eventBasedGateway id="Gateway_Event" />
        ${target}
        <bpmn:sequenceFlow id="Flow_ToTarget" sourceRef="Gateway_Event" targetRef="Target_Node" />
      </bpmn:process>`);

    it('rejects a user task target', async () => {
      const result = await validator.validate(
        gatewayTo('<bpmn:userTask id="Target_Node" />'), 'semantic'
      );

      expect(result.errors).toEqual([
        expect.objectContaining({
          code: 'BPMN_INVALID_EVENT_GATEWAY_TARGET',
          elementId: 'Flow_ToTarget'
        })
      ]);
    });

    it('rejects an intermediate catch event with no definition', async () => {
      const result = await validator.validate(
        gatewayTo('<bpmn:intermediateCatchEvent id="Target_Node" />'), 'semantic'
      );

      expect(issueCodes(result)).toContain('BPMN_INVALID_EVENT_GATEWAY_TARGET');
    });

    it.each([
      ['a receive task', '<bpmn:receiveTask id="Target_Node" />'],
      ['a message catch event', '<bpmn:intermediateCatchEvent id="Target_Node">'
        + '<bpmn:messageEventDefinition id="Def_Message" /></bpmn:intermediateCatchEvent>'],
      ['a timer catch event', '<bpmn:intermediateCatchEvent id="Target_Node">'
        + '<bpmn:timerEventDefinition id="Def_Timer" /></bpmn:intermediateCatchEvent>'],
      ['a signal catch event', '<bpmn:intermediateCatchEvent id="Target_Node">'
        + '<bpmn:signalEventDefinition id="Def_Signal" /></bpmn:intermediateCatchEvent>']
    ])('accepts %s', async (_label, target) => {
      const result = await validator.validate(gatewayTo(target), 'semantic');

      expect(issueCodes(result)).not.toContain('BPMN_INVALID_EVENT_GATEWAY_TARGET');
    });
  });
});
