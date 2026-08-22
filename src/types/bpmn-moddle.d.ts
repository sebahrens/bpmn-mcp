declare module 'bpmn-moddle' {
  export interface ParseResult {
    rootElement: any;
    references: Array<{
      element: any;
      property: string;
      id: string;
    }>;
    warnings: Error[];
    elementsById: Record<string, any>;
  }

  export interface SerializeResult {
    xml: string;
  }

  export default class BpmnModdle {
    constructor(options?: any);
    create(type: string, attrs?: any): any;
    createDiagram(semantic: any): any;
    fromXML(xml: string): Promise<ParseResult>;
    fromXML(xml: string, options: any): Promise<ParseResult>;
    fromXML(xml: string, callback: (err: any, definitions: any) => void): void;
    fromXML(xml: string, options: any, callback: (err: any, definitions: any) => void): void;
    toXML(element: any): Promise<SerializeResult>;
    toXML(element: any, options: any): Promise<SerializeResult>;
    toXML(element: any, callback: (err: any, xml: string) => void): void;
    toXML(element: any, options: any, callback: (err: any, xml: string) => void): void;
  }
}
