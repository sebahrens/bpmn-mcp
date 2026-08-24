import { resolve } from 'path';

export interface Config {
  bpmnDiagramsPath: string;
  bpmnImportLimits: BpmnImportLimits;
  resourceLimits: ResourceLimits;
  shutdownTimeoutMs: number;
}

export interface BpmnImportLimits {
  maxBytes: number;
  maxElements: number;
  maxFlows: number;
  maxDiElements: number;
}

export interface ResourceLimits {
  maxMermaidBytes: number;
  maxArtifactBytes: number;
  maxLayoutElements: number;
  maxLayoutConnections: number;
  maxLayoutDensity: number;
  maxLayoutBytes: number;
  maxConcurrentLayouts: number;
  maxListingItems: number;
  maxListingMetadataBytes: number;
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
  maxArtifactBytes: DEFAULT_IMPORT_LIMITS.maxBytes,
  maxLayoutElements: 2_000,
  maxLayoutConnections: 2_000,
  maxLayoutDensity: 10,
  maxLayoutBytes: DEFAULT_IMPORT_LIMITS.maxBytes,
  maxConcurrentLayouts: 2,
  maxListingItems: 10_000,
  maxListingMetadataBytes: DEFAULT_IMPORT_LIMITS.maxBytes,
  layoutTimeoutMs: 5_000
});

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

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
  
  // The stdio child inherits the client session cwd. Server startup replaces
  // this lexical fallback with WorkspaceSession's canonical resolution.
  const defaultPath = resolve(process.cwd());
  
  return {
    bpmnDiagramsPath: customPath || defaultPath,
    shutdownTimeoutMs: positiveIntegerFromEnvironment(
      'MCP_BPMN_SHUTDOWN_TIMEOUT_MS',
      DEFAULT_SHUTDOWN_TIMEOUT_MS
    ),
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
      maxArtifactBytes: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_ARTIFACT_BYTES',
        DEFAULT_RESOURCE_LIMITS.maxArtifactBytes
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
      maxListingMetadataBytes: positiveIntegerFromEnvironment(
        'MCP_BPMN_MAX_LISTING_METADATA_BYTES',
        DEFAULT_RESOURCE_LIMITS.maxListingMetadataBytes
      ),
      layoutTimeoutMs: positiveIntegerFromEnvironment(
        'MCP_BPMN_LAYOUT_TIMEOUT_MS',
        DEFAULT_RESOURCE_LIMITS.layoutTimeoutMs
      )
    }
  };
}

export const config = getConfig();

/**
 * Public request limits shared by schema validation and direct engine/file
 * boundaries. Keeping the collection cap aligned with arbitrary JSON arrays
 * avoids a second, larger allocation path; 256 also reduces the previously
 * accepted 10,000-item stress case by more than an order of magnitude while
 * remaining well above practical lane and candidate-group counts.
 *
 * Portable filenames use UTF-8 bytes rather than JavaScript string length.
 * Atomic writes prepend one dot and append `.<pid>.<uuid>.tmp` (at most 53
 * ASCII bytes with a 10-digit PID), so a 200-byte target remains at most 253
 * bytes under the common portable 255-byte component ceiling.
 */
export const MAX_INPUT_ARRAY_ITEMS = 256;
export const TOOL_INPUT_LIMITS = Object.freeze({
  coordinate: Object.freeze({ min: 0, max: 1_000_000 }),
  dimension: Object.freeze({ min: 1, max: 1_000_000 }),
  name: Object.freeze({ minLength: 1, maxLength: 256 }),
  label: Object.freeze({ minLength: 1, maxLength: 1_024 }),
  filename: Object.freeze({
    minLength: 1,
    maxLength: 200,
    maxUtf8Bytes: 200,
    maxComponentBytes: 255,
    maxAtomicWriteSuffixBytes: 53
  }),
  identifier: Object.freeze({ minLength: 1, maxLength: 255 }),
  annotationText: Object.freeze({ minLength: 1, maxLength: 8_192 }),
  expression: Object.freeze({ minLength: 1, maxLength: 8_192 }),
  language: Object.freeze({ minLength: 1, maxLength: 256 }),
  candidateGroups: Object.freeze({ minItems: 1, maxItems: MAX_INPUT_ARRAY_ITEMS }),
  laneFlowNodeIds: Object.freeze({ minItems: 1, maxItems: MAX_INPUT_ARRAY_ITEMS }),
  mermaidCode: Object.freeze({
    minLength: 1,
    maxLength: config.resourceLimits.maxMermaidBytes
  })
});
