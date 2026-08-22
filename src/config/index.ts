import { homedir } from 'os';
import { join } from 'path';

export interface Config {
  bpmnDiagramsPath: string;
  bpmnImportLimits: BpmnImportLimits;
  resourceLimits: ResourceLimits;
}

export interface BpmnImportLimits {
  maxBytes: number;
  maxElements: number;
  maxFlows: number;
  maxDiElements: number;
}

export interface ResourceLimits {
  maxMermaidBytes: number;
  maxLayoutElements: number;
  maxLayoutConnections: number;
  maxLayoutDensity: number;
  maxLayoutBytes: number;
  maxConcurrentLayouts: number;
  maxListingItems: number;
  layoutTimeoutMs: number;
}

const DEFAULT_IMPORT_LIMITS: BpmnImportLimits = {
  maxBytes: 5 * 1024 * 1024,
  maxElements: 10_000,
  maxFlows: 20_000,
  maxDiElements: 30_000
};

/**
 * bpmn-auto-layout@2.0.0-alpha.2 benchmark results on 2026-08-22:
 * sparse 2,000/1,999 element/connection graphs completed in 1.4s, while
 * dense 25/300 graphs took 4.8s and 26/325 exceeded 5s. The density ceiling
 * keeps accepted dense inputs below that cliff; the subprocess deadline is a
 * final backstop for pathological inputs that pass the structural checks.
 */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxMermaidBytes: DEFAULT_IMPORT_LIMITS.maxBytes,
  maxLayoutElements: 2_000,
  maxLayoutConnections: 2_000,
  maxLayoutDensity: 10,
  maxLayoutBytes: DEFAULT_IMPORT_LIMITS.maxBytes,
  maxConcurrentLayouts: 2,
  maxListingItems: 10_000,
  layoutTimeoutMs: 5_000
});

function positiveIntegerFromEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberFromEnvironment(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Get configuration with environment variable override
 */
export function getConfig(): Config {
  // Allow override via environment variable
  const customPath = process.env.MCP_BPMN_DIAGRAMS_PATH;
  
  // Default to ~/mcp-bpmn on Unix-like or %HOME%\mcp-bpmn on Windows
  const defaultPath = join(homedir(), 'mcp-bpmn');
  
  return {
    bpmnDiagramsPath: customPath || defaultPath,
    bpmnImportLimits: {
      maxBytes: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_IMPORT_BYTES',
        DEFAULT_IMPORT_LIMITS.maxBytes
      ),
      maxElements: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_IMPORT_ELEMENTS',
        DEFAULT_IMPORT_LIMITS.maxElements
      ),
      maxFlows: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_IMPORT_FLOWS',
        DEFAULT_IMPORT_LIMITS.maxFlows
      ),
      maxDiElements: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_IMPORT_DI_ELEMENTS',
        DEFAULT_IMPORT_LIMITS.maxDiElements
      )
    },
    resourceLimits: {
      maxMermaidBytes: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_MERMAID_BYTES',
        DEFAULT_RESOURCE_LIMITS.maxMermaidBytes
      ),
      maxLayoutElements: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_LAYOUT_ELEMENTS',
        DEFAULT_RESOURCE_LIMITS.maxLayoutElements
      ),
      maxLayoutConnections: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_LAYOUT_CONNECTIONS',
        DEFAULT_RESOURCE_LIMITS.maxLayoutConnections
      ),
      maxLayoutDensity: positiveNumberFromEnvironment(
        'MCP_BPMN_MAX_LAYOUT_DENSITY',
        DEFAULT_RESOURCE_LIMITS.maxLayoutDensity
      ),
      maxLayoutBytes: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_LAYOUT_BYTES',
        DEFAULT_RESOURCE_LIMITS.maxLayoutBytes
      ),
      maxConcurrentLayouts: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_CONCURRENT_LAYOUTS',
        DEFAULT_RESOURCE_LIMITS.maxConcurrentLayouts
      ),
      maxListingItems: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_LISTING_ITEMS',
        DEFAULT_RESOURCE_LIMITS.maxListingItems
      ),
      layoutTimeoutMs: positiveIntegerFromEnvironment(
        'MCP_BPMN_LAYOUT_TIMEOUT_MS',
        DEFAULT_RESOURCE_LIMITS.layoutTimeoutMs
      )
    }
  };
}

export const config = getConfig();
