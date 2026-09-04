import { BpmnExtensionProfile, ProcessContext } from '../types/index.js';
import { ToolError } from '../utils/ToolError.js';

export interface DiagramInfo {
  name: string;
  filename?: string;
  processId: string;
  elementCount: number;
  connectionCount: number;
  type: 'process' | 'collaboration';
  extensionProfile: BpmnExtensionProfile;
  revision: string;
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
      throw new ToolError('no_current_diagram', 'No diagram is currently open', {
        recovery: 'Open or create one first: new_bpmn(name), '
          + 'new_from_mermaid(name, mermaidCode), open_bpmn(filename), '
          + 'or open_mermaid_file(filename).'
      });
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
      extensionProfile: this.currentContext.extensionProfile,
      revision: this.currentContext.revision
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
