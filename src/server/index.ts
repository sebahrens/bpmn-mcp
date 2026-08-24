#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools.js';
import { BpmnRequestHandler } from './handlers.js';
import { config } from '../config/index.js';
import { WorkspaceSession } from '../config/WorkspaceSession.js';
import { SimpleBpmnEngine } from '../core/SimpleBpmnEngine.js';

/** Maximum time accepted calls get to drain before shutdown is forced. */
const SHUTDOWN_TIMEOUT_MS = config.shutdownTimeoutMs;

const requirePackage = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
);
const packageMetadata = requirePackage('../../package.json') as {
  version: string;
};

const SERVER_INSTRUCTIONS = [
  'Work with one active BPMN diagram at a time; creating or opening a diagram replaces the active context. Successful mutations auto-save to its active file. Use element IDs returned by create and query calls for all later connections, lookups, updates, and deletions. File tools are confined to the configured diagram store. Obtain explicit user confirmation before deleting a stored file or destructively replacing existing diagram or file state.',
  'Recommended finish: validate, then auto_layout, then validate again. list_elements, list_connections, and list_diagrams are paginated; while hasMore is true, request the next page with offset + returnedCount. See tools/list for tool-specific arguments and outputs.'
].join('\n\n');

// Create server instance
const server = new Server(
  {
    name: 'mcp-bpmn-server',
    version: packageMetadata.version,
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// Resolve storage from the client session cwd without changing cwd. Imports
// remain anchored to this installed module while each stdio child gets its own
// repository-scoped workspace.
const workspace = WorkspaceSession.fromLaunch();
const handler = new BpmnRequestHandler(
  new SimpleBpmnEngine(workspace.path),
  undefined,
  config.resourceLimits,
  undefined,
  workspace
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools,
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await handler.handleRequest(name, args);
});

// Error handling
server.onerror = (error) => {
  console.error('[MCP-BPMN Server Error]', error);
};

let shutdownPromise: Promise<void> | undefined;
let shutdownExitCode = 0;

function shutdown(reason: string, requestedExitCode: number): Promise<void> {
  shutdownExitCode = Math.max(shutdownExitCode, requestedExitCode);
  if (shutdownPromise) {
    return shutdownPromise;
  }

  handler.beginShutdown();
  shutdownPromise = performShutdown(reason);
  return shutdownPromise;
}

async function performShutdown(reason: string): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const cleanup = (async () => {
    await handler.shutdown();
    await server.close();
  })();

  const outcome = await Promise.race([
    cleanup.then(() => 'clean' as const),
    new Promise<'timeout'>(resolve => {
      timeout = setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS);
    })
  ]).catch(error => {
    console.error(`Shutdown after ${reason} failed:`, error);
    return 'failed' as const;
  });

  if (timeout) clearTimeout(timeout);
  if (outcome === 'clean') {
    process.exitCode = shutdownExitCode;
    return;
  }

  process.exitCode = 1;
  if (outcome === 'timeout') {
    console.error(`Shutdown after ${reason} exceeded ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`);
  }
  // The deadline is absolute: initiate best-effort child/transport cleanup,
  // then force the documented nonzero exit without waiting on the operation
  // that already failed to settle within its budget.
  void handler.forceCloseResources();
  void server.close().catch(() => undefined);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal, 0);
  });
}

process.stdin.once('end', () => {
  void shutdown('transport EOF', 0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP-BPMN Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  void shutdown('startup failure', 1);
});
