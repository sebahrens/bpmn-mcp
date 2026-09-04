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

    it('maps by event type alone, since the definition lives inside the event', () => {
      // A timer start event is still a bpmn:StartEvent; the engine attaches the
      // timer definition to it rather than choosing a different element type.
      expect(TypeMappings.mapEventType('start')).toBe('bpmn:StartEvent');
      expect(TypeMappings.mapEventType('intermediate-catch'))
        .toBe('bpmn:IntermediateCatchEvent');
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
});
