import { TypeMappings } from '../../../src/utils/TypeMappings.js';
import { EventType, ActivityType, GatewayType } from '../../../src/types/index.js';

describe('TypeMappings', () => {
  describe('mapEventType', () => {
    it('should map event types correctly', () => {
      const tests: Array<{ input: EventType; expected: string }> = [
        { input: 'start', expected: 'bpmn:StartEvent' },
        { input: 'end', expected: 'bpmn:EndEvent' },
        { input: 'intermediate-throw', expected: 'bpmn:IntermediateThrowEvent' },
        { input: 'intermediate-catch', expected: 'bpmn:IntermediateCatchEvent' },
        { input: 'boundary', expected: 'bpmn:BoundaryEvent' },
      ];

      tests.forEach(test => {
        expect(TypeMappings.mapEventType(test.input)).toBe(test.expected);
      });
    });

    it('should accept optional event definition parameter', () => {
      const result = TypeMappings.mapEventType('start', 'timer');
      expect(result).toBe('bpmn:StartEvent');
    });
  });

  describe('mapActivityType', () => {
    it('should map activity types correctly', () => {
      const tests: Array<{ input: ActivityType; expected: string }> = [
        { input: 'task', expected: 'bpmn:Task' },
        { input: 'userTask', expected: 'bpmn:UserTask' },
        { input: 'serviceTask', expected: 'bpmn:ServiceTask' },
        { input: 'scriptTask', expected: 'bpmn:ScriptTask' },
        { input: 'businessRuleTask', expected: 'bpmn:BusinessRuleTask' },
        { input: 'manualTask', expected: 'bpmn:ManualTask' },
        { input: 'receiveTask', expected: 'bpmn:ReceiveTask' },
        { input: 'sendTask', expected: 'bpmn:SendTask' },
        { input: 'subProcess', expected: 'bpmn:SubProcess' },
        { input: 'transaction', expected: 'bpmn:Transaction' },
        { input: 'callActivity', expected: 'bpmn:CallActivity' },
      ];

      tests.forEach(test => {
        expect(TypeMappings.mapActivityType(test.input)).toBe(test.expected);
      });
    });
  });

  describe('mapGatewayType', () => {
    it('should map gateway types correctly', () => {
      const tests: Array<{ input: GatewayType; expected: string }> = [
        { input: 'exclusive', expected: 'bpmn:ExclusiveGateway' },
        { input: 'parallel', expected: 'bpmn:ParallelGateway' },
        { input: 'inclusive', expected: 'bpmn:InclusiveGateway' },
        { input: 'eventBased', expected: 'bpmn:EventBasedGateway' },
        { input: 'complex', expected: 'bpmn:ComplexGateway' },
      ];

      tests.forEach(test => {
        expect(TypeMappings.mapGatewayType(test.input)).toBe(test.expected);
      });
    });
  });

  describe('createEventDefinition', () => {
    it('should return undefined for no event definition', () => {
      expect(TypeMappings.createEventDefinition()).toBeUndefined();
    });

    it('should create correct event definitions', () => {
      const tests = [
        { input: 'message', expected: 'bpmn:MessageEventDefinition' },
        { input: 'timer', expected: 'bpmn:TimerEventDefinition' },
        { input: 'error', expected: 'bpmn:ErrorEventDefinition' },
        { input: 'signal', expected: 'bpmn:SignalEventDefinition' },
        { input: 'conditional', expected: 'bpmn:ConditionalEventDefinition' },
        { input: 'escalation', expected: 'bpmn:EscalationEventDefinition' },
        { input: 'compensation', expected: 'bpmn:CompensateEventDefinition' },
        { input: 'cancel', expected: 'bpmn:CancelEventDefinition' },
        { input: 'terminate', expected: 'bpmn:TerminateEventDefinition' },
      ];

      tests.forEach(test => {
        const result = TypeMappings.createEventDefinition(test.input as any);
        expect(result).toBeDefined();
        expect(result.$type).toBe(test.expected);
      });
    });
  });

  describe('canConnect', () => {
    it('should not allow connections from end events', () => {
      expect(TypeMappings.canConnect('bpmn:EndEvent', 'bpmn:Task')).toBe(false);
      expect(TypeMappings.canConnect('bpmn:EndEvent', 'bpmn:StartEvent')).toBe(false);
    });

    it('should not allow connections to start events', () => {
      expect(TypeMappings.canConnect('bpmn:Task', 'bpmn:StartEvent')).toBe(false);
      expect(TypeMappings.canConnect('bpmn:Gateway', 'bpmn:StartEvent')).toBe(false);
    });

    it('should not allow boundary to boundary connections', () => {
      expect(TypeMappings.canConnect('bpmn:BoundaryEvent', 'bpmn:BoundaryEvent')).toBe(false);
    });

    it('should allow valid connections', () => {
      expect(TypeMappings.canConnect('bpmn:StartEvent', 'bpmn:Task')).toBe(true);
      expect(TypeMappings.canConnect('bpmn:Task', 'bpmn:EndEvent')).toBe(true);
      expect(TypeMappings.canConnect('bpmn:Task', 'bpmn:Task')).toBe(true);
      expect(TypeMappings.canConnect('bpmn:Gateway', 'bpmn:Task')).toBe(true);
    });
  });

  describe('getConnectionType', () => {
    it('should return message flow for participant connections', () => {
      expect(TypeMappings.getConnectionType('bpmn:Participant', 'bpmn:Task')).toBe('bpmn:MessageFlow');
      expect(TypeMappings.getConnectionType('bpmn:Task', 'bpmn:Participant')).toBe('bpmn:MessageFlow');
    });

    it('should return sequence flow for regular connections', () => {
      expect(TypeMappings.getConnectionType('bpmn:Task', 'bpmn:Task')).toBe('bpmn:SequenceFlow');
      expect(TypeMappings.getConnectionType('bpmn:Gateway', 'bpmn:Task')).toBe('bpmn:SequenceFlow');
      expect(TypeMappings.getConnectionType('bpmn:StartEvent', 'bpmn:Task')).toBe('bpmn:SequenceFlow');
    });
  });
});
