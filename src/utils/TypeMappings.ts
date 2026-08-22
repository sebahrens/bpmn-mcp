import {
  ActivityType,
  BpmnFlowNodeType,
  EventDefinitionType,
  EventType,
  GatewayType
} from '../types/index.js';

export class TypeMappings {
  /**
   * Map event type and definition to BPMN element type
   */
  static mapEventType(eventType: EventType, _eventDefinition?: EventDefinitionType): BpmnFlowNodeType {
    const baseTypes: Record<EventType, BpmnFlowNodeType> = {
      'start': 'bpmn:StartEvent',
      'end': 'bpmn:EndEvent',
      'intermediate-throw': 'bpmn:IntermediateThrowEvent',
      'intermediate-catch': 'bpmn:IntermediateCatchEvent',
      'boundary': 'bpmn:BoundaryEvent'
    };

    // Currently just returning base type, but eventDefinition can be used
    // for future enhancements like specialized event types
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

  /**
   * Create event definition based on type
   */
  static createEventDefinition(type?: EventDefinitionType): any {
    if (!type) return undefined;

    const definitionMap: Record<EventDefinitionType, string> = {
      'message': 'bpmn:MessageEventDefinition',
      'timer': 'bpmn:TimerEventDefinition',
      'error': 'bpmn:ErrorEventDefinition',
      'signal': 'bpmn:SignalEventDefinition',
      'conditional': 'bpmn:ConditionalEventDefinition',
      'escalation': 'bpmn:EscalationEventDefinition',
      'compensation': 'bpmn:CompensateEventDefinition',
      'cancel': 'bpmn:CancelEventDefinition',
      'terminate': 'bpmn:TerminateEventDefinition'
    };

    return {
      $type: definitionMap[type]
    };
  }

  /**
   * Check if elements can be connected
   */
  static canConnect(sourceType: string, targetType: string): boolean {
    // Simplified rules - can be expanded
    const invalidConnections = [
      ['bpmn:EndEvent', '*'],
      ['*', 'bpmn:StartEvent'],
      ['bpmn:BoundaryEvent', 'bpmn:BoundaryEvent']
    ];

    for (const [source, target] of invalidConnections) {
      if ((source === '*' || source === sourceType) &&
          (target === '*' || target === targetType)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Determine connection type based on source and target
   */
  static getConnectionType(sourceType: string, targetType: string): string {
    // Message flows between pools
    if (sourceType === 'bpmn:Participant' || targetType === 'bpmn:Participant') {
      return 'bpmn:MessageFlow';
    }

    // Default to sequence flow
    return 'bpmn:SequenceFlow';
  }
}
