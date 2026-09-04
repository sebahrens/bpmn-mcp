import { v4 as uuidv4 } from 'uuid';

/** Prefixes whose numbering spans the whole process, not one diagram. */
const ROOT_ID_PREFIXES = new Set(['Process', 'Collaboration', 'Definitions']);

export class IdGenerator {
  private static counters: Map<string, number> = new Map();

  /**
   * Generate a unique ID with a given prefix
   */
  static generate(prefix: string): string {
    const counter = this.counters.get(prefix) || 0;
    this.counters.set(prefix, counter + 1);
    return `${prefix}_${counter + 1}`;
  }

  /**
   * Generate a UUID-based ID
   */
  static generateUuid(prefix?: string): string {
    const uuid = uuidv4().replace(/-/g, '');
    return prefix ? `${prefix}_${uuid}` : uuid;
  }

  /**
   * Reset counters (useful for testing)
   */
  static reset(): void {
    this.counters.clear();
  }

  /**
   * Restart element numbering for a diagram created from scratch, so the same
   * modelling steps always produce the same ids and two runs diff cleanly
   * (mcp-bpmn-8u0.27).
   *
   * Root counters are deliberately left running: two engines in one process
   * can hold diagrams at the same time, and a reused Process id would make
   * their contexts indistinguishable.
   */
  static resetElementCounters(): void {
    for (const prefix of this.counters.keys()) {
      if (!ROOT_ID_PREFIXES.has(prefix)) this.counters.delete(prefix);
    }
  }
}