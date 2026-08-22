// Conversion result types for Mermaid to BPMN conversion
export interface ConversionResult {
  processId: string;
  xml: string;
  svg?: string;
  elements: Array<{
    id: string;
    type: string;
    businessObject?: Record<string, unknown>;
    x?: number;
    y?: number;
  }>;
  flows: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
  }>;
  pools: Array<{
    id: string;
    name: string;
    lanes: Array<Record<string, unknown>>;
  }>;
  lanes: Array<Record<string, unknown>>;
  statistics: {
    totalElements: number;
    tasks: number;
    events: number;
    gateways: number;
    flows: number;
  };
  warnings: string[];
  confidence: number;
  conversionTime: number;
  stats: {
    nodeCount: number;
    edgeCount: number;
  };
}
