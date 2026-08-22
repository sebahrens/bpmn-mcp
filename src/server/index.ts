#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from './tools.js';
import { BpmnRequestHandler } from './handlers.js';

const requirePackage = createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url
);
const packageMetadata = requirePackage('../../package.json') as {
  version: string;
};

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
  }
);

// Create request handler
const handler = new BpmnRequestHandler();

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

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP-BPMN Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
