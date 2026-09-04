import {
  ActivityType,
  BpmnFlowNodeType,
  EventType,
  GatewayType
} from '../types/index.js';

export class TypeMappings {
  /**
   * Map an event type to its BPMN element type.
   *
   * The event definition does not take part: BPMN puts the definition inside
   * the event rather than changing the element type, so a timer start event is
   * still a `bpmn:StartEvent`. The engine attaches the definition separately.
   */
  static mapEventType(eventType: EventType): BpmnFlowNodeType {
    const baseTypes: Record<EventType, BpmnFlowNodeType> = {
      'start': 'bpmn:StartEvent',
      'end': 'bpmn:EndEvent',
      'intermediate-throw': 'bpmn:IntermediateThrowEvent',
      'intermediate-catch': 'bpmn:IntermediateCatchEvent',
      'boundary': 'bpmn:BoundaryEvent'
    };

    return baseTypes[eventType];
  }

  /**
   * Map activity type to BPMN element type
   */
  static mapActivityType(activityType: ActivityType): BpmnFlowNodeType {
    const activityMap: Record<ActivityType, BpmnFlowNodeType> = {
      'task': 'bpmn:Task',
      'userTask': 'bpmn:UserTask',
      'serviceTask': 'bpmn:ServiceTask',
      'scriptTask': 'bpmn:ScriptTask',
      'businessRuleTask': 'bpmn:BusinessRuleTask',
      'manualTask': 'bpmn:ManualTask',
      'receiveTask': 'bpmn:ReceiveTask',
      'sendTask': 'bpmn:SendTask',
      'subProcess': 'bpmn:SubProcess',
      'transaction': 'bpmn:Transaction',
      'callActivity': 'bpmn:CallActivity'
    };

    return activityMap[activityType];
  }

  /**
   * Map gateway type to BPMN element type
   */
  static mapGatewayType(gatewayType: GatewayType): BpmnFlowNodeType {
    const gatewayMap: Record<GatewayType, BpmnFlowNodeType> = {
      'exclusive': 'bpmn:ExclusiveGateway',
      'parallel': 'bpmn:ParallelGateway',
      'inclusive': 'bpmn:InclusiveGateway',
      'eventBased': 'bpmn:EventBasedGateway',
      'complex': 'bpmn:ComplexGateway'
    };

    return gatewayMap[gatewayType];
  }
}
