import { BpmnExtensionProfile, ProcessContext } from '../types/index.js';

export interface DiagramInfo {
  name: string;
  filename?: string;
  processId: string;
  elementCount: number;
  connectionCount: number;
  type: 'process' | 'collaboration';
  extensionProfile: BpmnExtensionProfile;
}

export class DiagramContext {
  private currentContext: ProcessContext | null = null;
  private currentName: string | null = null;

  /**
   * Set the current diagram context
   */
  setCurrent(context: ProcessContext, name: string): void {
    this.currentContext = context;
    this.currentName = name;
  }

  /**
   * Get the current context or throw if none exists
   */
  getCurrent(): ProcessContext {
    if (!this.currentContext) {
      throw new Error(
        'No current context. Please create a diagram first with:\n' +
        '  - new_bpmn(name) to create a new BPMN diagram\n' +
        '  - new_from_mermaid(name, mermaidCode) to convert from Mermaid\n' +
        '  - open_bpmn(filename) to open an existing BPMN file\n' +
        '  - open_mermaid_file(filename) to convert a Mermaid file'
      );
    }
    return this.currentContext;
  }

  /**
   * Get current diagram info
   */
  getCurrentInfo(): DiagramInfo | null {
    if (!this.currentContext || !this.currentName) {
      return null;
    }

    return {
      name: this.currentName,
      filename: this.currentContext.filename,
      processId: this.currentContext.id,
      elementCount: this.currentContext.elements.size,
      connectionCount: this.currentContext.connections.size,
      type: this.currentContext.type,
      extensionProfile: this.currentContext.extensionProfile
    };
  }

  /**
   * Clear the current context
   */
  clear(): void {
    this.currentContext = null;
    this.currentName = null;
  }

  /**
   * Check if there's a current context
   */
  hasCurrent(): boolean {
    return this.currentContext !== null;
  }

}

// Singleton instance
export const diagramContext = new DiagramContext();
