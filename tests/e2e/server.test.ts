import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import BpmnModdle from 'bpmn-moddle';

const STARTUP_MESSAGE = 'MCP-BPMN Server running on stdio';
const STARTUP_TIMEOUT_MS = 3000;
const RESPONSE_TIMEOUT_MS = 2000;

jest.setTimeout(10_000);

const EXPECTED_TOOL_NAMES = [
  'new_bpmn',
  'new_from_mermaid',
  'open_bpmn',
  'open_mermaid_file',
  'save',
  'save_as',
  'close',
  'current',
  'add_event',
  'add_activity',
  'add_gateway',
  'add_data_object',
  'add_text_annotation',
  'connect',
  'add_association',
  'add_pool',
  'add_lane',
  'list_elements',
  'get_element',
  'update_element',
  'delete_element',
  'export',
  'validate',
  'auto_layout',
  'list_diagrams',
  'delete_diagram_file',
  'get_diagrams_path'
] as const;

// Fingerprints pin the complete advertised input schemas. A schema change must
// therefore be reviewed and explicitly accepted here instead of silently
// weakening e2e.
const EXPECTED_SCHEMA_FINGERPRINTS: Record<string, string> = {
  new_bpmn: 'c8d67446a39cc6e7bd278a6e656ac43e7dd873151b090660e3521839b361919b',
  new_from_mermaid: 'bdf6ae5a0516b9425ce350bbeb53f5a9908aca7954c50a8a629a78e12ae4b6b8',
  open_bpmn: '7587abc15d187397b8d68fe03f16befb84d338d6c996c9698ed095c172575e33',
  open_mermaid_file: '45b8782a7743d24839dc7235199cde0ed9c661ea1a756448251d0432b801e065',
  save: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  save_as: 'be6306c0c78351fb0f70f6ab9141db64a32ed1f3df4520d22b144dc95562edad',
  close: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  current: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  add_event: 'f87f27a231687fd5a1faaed79d3fe720d48043aa0bd89307c0166f6b7bedc35a',
  add_activity: '4189ab0981e19ecad25d0621cc4dc83a72eca9b194fe5dd41b17621b1a5ab324',
  add_gateway: '0dd27a7b9ff96cbf741e2d0feee9c5f148e45b2c310376697b772904a979ecd2',
  add_data_object: '3393d99847270422a3bcbd0b09a4506b0c1ece68768c2db3deeee362e9c0f815',
  add_text_annotation: 'c32b16524372c107b04aa6ac76ce71cb2b6253b0a982488182b1feac2d02818b',
  connect: 'ed7d59ef10d93784a25162b0f807573e5953e1faab2c01850af3195c89fda364',
  add_association: 'ceabe21c617ab7601489eaf3e7624b6a8d60d261d1f72bd4c3fc383f52bc7ee3',
  add_pool: 'af4830cb358539790bb20c4ec0ff38b7527bc0d1dfd05dbe2f307036314fe09e',
  add_lane: 'a78ffd77bfcc90ec908c0a15208fd1b29a005771aa787598412f1bef51cdbbea',
  list_elements: 'a6cd6d19adcc3d088f1740e0d298d2da71c13334dfadd81348fd2e75a0f19269',
  get_element: '56c709848847f945fdfa22fdc7f0aa1e3b5b7292f49a1f994cf70b908c9457dd',
  update_element: '10b4734c2239cd46be0396c42b53f63b0d0205ed2aa66d42e45cb5e03e9d929c',
  delete_element: '3b3b4c7eb2d9b3db194eb17f52c92fbf8ab1996c6f1a681645e2658fdf68d94d',
  export: '5246d220ea6867c12b818a950bb411b641872c4ebae8daa7462d3939e1a63710',
  validate: '7480ee2efa429395b7cd39c1cc63b6323354ab4200eb9a2135ddbf9d6b9f07b8',
  auto_layout: 'b3057ad9eaaec95f786214411d2ca472969130624cf8d96eaca5132586106025',
  list_diagrams: '7ee2be8c2aa4cf5ee19648606709df5d0bd35de2cc3d489dbbc34ee69d81b294',
  delete_diagram_file: 'e2e4c99bc839f8567b6fbc158c5f6370b2bd906466477efad74a97738abe451d',
  get_diagrams_path: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa'
};

interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: any;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

interface ServerLaunch {
  process: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  stderr: () => string;
  responses: ResponseState;
}

interface PendingResponse {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ResponseState {
  pending: Map<unknown, PendingResponse>;
  protocolError?: Error;
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('close', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);

    child.once('exit', onExit);
    child.once('close', onExit);
  });
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (hasExited(child)) {
    return;
  }

  child.stdin.end();
  child.kill('SIGTERM');

  if (!(await waitForExit(child, 1000)) && !hasExited(child)) {
    child.kill('SIGKILL');
    if (!(await waitForExit(child, 1000)) && !hasExited(child)) {
      throw new Error(`Server process ${String(child.pid)} did not exit after SIGKILL`);
    }
  }
}

function launchServer(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  startupTimeoutMs = STARTUP_TIMEOUT_MS
): ServerLaunch {
  const child = spawn(command, args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderrBuffer = '';
  let stdoutBuffer = '';
  const responses: ResponseState = { pending: new Map() };

  const rejectPendingResponses = (error: Error) => {
    for (const pending of responses.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    responses.pending.clear();
  };

  child.stdout.on('data', (data: Buffer) => {
    if (responses.protocolError) return;

    stdoutBuffer += data.toString();
    const deliveries: Array<{ pending: PendingResponse; response: JsonRpcResponse }> = [];
    let newline = stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      newline = stdoutBuffer.indexOf('\n');
      if (!line) continue;

      let response: JsonRpcResponse;
      try {
        response = JSON.parse(line) as JsonRpcResponse;
      } catch {
        responses.protocolError = new Error(`Server emitted invalid JSON: ${line}`);
        break;
      }

      if (response.id === undefined) continue;
      const pending = responses.pending.get(response.id);
      if (!pending) {
        responses.protocolError = new Error(`Server emitted unexpected response id ${String(response.id)}`);
        break;
      }
      responses.pending.delete(response.id);
      deliveries.push({ pending, response });
    }

    if (responses.protocolError) {
      for (const delivery of deliveries) {
        clearTimeout(delivery.pending.timeout);
        delivery.pending.reject(responses.protocolError);
      }
      rejectPendingResponses(responses.protocolError);
      return;
    }

    for (const delivery of deliveries) {
      clearTimeout(delivery.pending.timeout);
      delivery.pending.resolve(delivery.response);
    }
  });

  child.once('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
    rejectPendingResponses(new Error(
      `Server exited while awaiting response with ${detail}. stderr: ${stderrBuffer}`
    ));
  });

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;

    const startupTimeout = setTimeout(() => {
      void fail(new Error(`Server startup timed out after ${startupTimeoutMs}ms`));
    }, startupTimeoutMs);

    const succeed = () => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimeout);
      resolve();
    };

    const fail = async (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimeout);
      try {
        await stopServer(child);
        reject(error);
      } catch (cleanupError) {
        const detail = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        reject(new Error(`${error.message}; cleanup failed: ${detail}`));
      }
    };

    child.stderr.on('data', (data: Buffer) => {
      stderrBuffer += data.toString();
      if (settled) return;

      const startupOutput = stderrBuffer.trimStart();
      if (startupOutput.startsWith(STARTUP_MESSAGE)) {
        succeed();
      } else if (startupOutput && !STARTUP_MESSAGE.startsWith(startupOutput)) {
        void fail(new Error(`Server wrote to stderr during startup: ${startupOutput}`));
      }
    });

    child.once('error', (error) => {
      void fail(new Error(`Server failed to spawn: ${error.message}`));
    });

    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
      void fail(new Error(`Server exited before startup with ${detail}`));
    });
  });

  return { process: child, ready, stderr: () => stderrBuffer, responses };
}

function sendRequest(
  launch: ServerLaunch,
  request: Record<string, unknown>,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS
): Promise<JsonRpcResponse> {
  return new Promise((resolve, reject) => {
    const child = launch.process;
    if (launch.responses.protocolError) {
      reject(launch.responses.protocolError);
      return;
    }
    if (launch.responses.pending.has(request.id)) {
      reject(new Error(`Duplicate in-flight request id ${String(request.id)}`));
      return;
    }

    const responseTimeout = setTimeout(() => {
      launch.responses.pending.delete(request.id);
      reject(new Error(
        `Response timeout after ${responseTimeoutMs}ms. stderr: ${launch.stderr()}`
      ));
    }, responseTimeoutMs);

    launch.responses.pending.set(request.id, { resolve, reject, timeout: responseTimeout });
    child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (!error) return;
      const pending = launch.responses.pending.get(request.id);
      if (!pending) return;
      launch.responses.pending.delete(request.id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    });
  });
}

function sendNotification(
  child: ChildProcessWithoutNullStreams,
  notification: Record<string, unknown>
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${JSON.stringify(notification)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function expectProtocolSuccess(response: JsonRpcResponse, id: number): any {
  expect(response.jsonrpc).toBe('2.0');
  expect(response.id).toBe(id);
  if (response.error !== undefined) {
    throw new Error(`Unexpected JSON-RPC error: ${JSON.stringify(response.error)}`);
  }
  if (response.result === undefined) {
    throw new Error(`JSON-RPC response ${id} has neither result nor error`);
  }
  return response.result;
}

async function callTool(
  launch: ServerLaunch,
  id: number,
  name: string,
  args: Record<string, unknown>
): Promise<any> {
  const result = expectProtocolSuccess(await sendRequest(launch, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  }), id);

  if (result.isError === true) {
    throw new Error(`Unexpected ${name} tool error: ${JSON.stringify(result.content)}`);
  }
  expect(result.content).toEqual(expect.any(Array));
  return result;
}

function textContent(result: any): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe('text');
  expect(result.content[0]?.text).toEqual(expect.any(String));
  return result.content[0].text as string;
}

function normalizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeSchema(child)])
  );
}

function schemaFingerprint(schema: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSchema(schema)))
    .digest('hex');
}

describe('MCP server process lifecycle', () => {
  it.each([
    {
      name: 'unexpected stderr',
      args: ['-e', "process.stderr.write('startup failed'); setInterval(() => undefined, 1000);"],
      timeoutMs: 1000,
      error: /wrote to stderr during startup/
    },
    {
      name: 'an early child exit',
      args: ['-e', 'process.exit(23);'],
      timeoutMs: 1000,
      error: /exited before startup with code 23/
    },
    {
      name: 'a startup timeout',
      args: ['-e', 'setInterval(() => undefined, 1000);'],
      timeoutMs: 100,
      error: /startup timed out after 100ms/
    }
  ])('fails promptly on $name and leaves no child process', async ({ args, timeoutMs, error }) => {
    const startedAt = Date.now();
    const launch = launchServer(process.execPath, args, process.env, timeoutMs);

    await expect(launch.ready).rejects.toThrow(error);

    expect(Date.now() - startedAt).toBeLessThan(2500);
    expect(hasExited(launch.process)).toBe(true);
  });

  it('times out an unresponsive started server and always terminates it', async () => {
    const launch = launchServer(process.execPath, [
      '-e',
      `process.stderr.write('${STARTUP_MESSAGE}\\n'); process.stdin.resume(); setInterval(() => undefined, 1000);`
    ]);

    try {
      await launch.ready;
      await expect(sendRequest(launch, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      }, 100)).rejects.toThrow('Response timeout after 100ms');
    } finally {
      await stopServer(launch.process);
    }

    expect(hasExited(launch.process)).toBe(true);
  });

  it('rejects a valid-looking response followed by malformed protocol output', async () => {
    const launch = launchServer(process.execPath, [
      '-e',
      `process.stderr.write('${STARTUP_MESSAGE}\\n'); process.stdin.once('data', () => process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\nnot-json\\n')); setInterval(() => undefined, 1000);`
    ]);

    try {
      await launch.ready;
      await expect(sendRequest(launch, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      })).rejects.toThrow('Server emitted invalid JSON: not-json');
    } finally {
      await stopServer(launch.process);
    }

    expect(hasExited(launch.process)).toBe(true);
  });
});

describe('MCP Server End-to-End Tests', () => {
  it('strictly advertises its contract and creates, connects, persists, and exports BPMN', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-e2e-'));
    const isolatedHome = path.join(diagramsDirectory, 'isolated-home');
    const isolatedDefaultDirectory = path.join(isolatedHome, 'mcp-bpmn');
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const launch = launchServer(process.execPath, [serverPath], {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory
    });

    try {
      await launch.ready;

      const packageMetadata = JSON.parse(
        await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8')
      ) as { version: string };
      const initialize = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mcp-bpmn-e2e', version: '1.0.0' }
        }
      }), 1);
      expect(initialize).toEqual({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'mcp-bpmn-server',
          version: packageMetadata.version
        }
      });

      await sendNotification(launch.process, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });

      const listResult = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      }), 2);
      const advertisedTools = listResult.tools as Array<{
        name: string;
        description: string;
        inputSchema: unknown;
      }>;
      expect(advertisedTools.map(tool => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
      expect(advertisedTools.every(tool => typeof tool.description === 'string' && tool.description))
        .toBe(true);
      expect(Object.keys(EXPECTED_SCHEMA_FINGERPRINTS)).toEqual(EXPECTED_TOOL_NAMES);
      for (const tool of advertisedTools) {
        expect({
          name: tool.name,
          fingerprint: schemaFingerprint(tool.inputSchema)
        }).toEqual({
          name: tool.name,
          fingerprint: EXPECTED_SCHEMA_FINGERPRINTS[tool.name]
        });
      }

      expect(textContent(await callTool(launch, 3, 'get_diagrams_path', {})))
        .toContain(diagramsDirectory);
      expect(textContent(await callTool(launch, 4, 'new_bpmn', {
        name: 'Strict Protocol Flow'
      }))).toBe(
        'Created new process diagram "Strict Protocol Flow"\nExtension profile: portable'
      );
      await callTool(launch, 5, 'add_event', {
        eventType: 'start',
        name: 'Order received'
      });
      await callTool(launch, 6, 'add_activity', {
        activityType: 'userTask',
        name: 'Review order'
      });
      await callTool(launch, 7, 'add_event', {
        eventType: 'end',
        name: 'Order approved'
      });

      const listing = JSON.parse(textContent(
        await callTool(launch, 8, 'list_elements', {})
      )) as { elements: Array<{ id: string; name: string; type: string }> };
      const elements = listing.elements;
      const start = elements.find(element => element.name === 'Order received');
      const task = elements.find(element => element.name === 'Review order');
      const end = elements.find(element => element.name === 'Order approved');
      expect(start).toEqual(expect.objectContaining({ type: 'bpmn:StartEvent' }));
      expect(task).toEqual(expect.objectContaining({ type: 'bpmn:UserTask' }));
      expect(end).toEqual(expect.objectContaining({ type: 'bpmn:EndEvent' }));

      await callTool(launch, 9, 'connect', {
        sourceId: start!.id,
        targetId: task!.id,
        label: 'submit'
      });
      await callTool(launch, 10, 'connect', {
        sourceId: task!.id,
        targetId: end!.id,
        label: 'approve'
      });

      const xml = textContent(await callTool(launch, 11, 'export', {
        format: 'xml',
        formatted: true
      }));
      const parsed = await new BpmnModdle().fromXML(xml);
      expect(parsed.warnings).toEqual([]);
      const bpmnProcess = parsed.rootElement.rootElements.find(
        (root: any) => root.$type === 'bpmn:Process'
      );
      expect(bpmnProcess?.name).toBe('Strict Protocol Flow');

      const semanticElements = bpmnProcess.flowElements as any[];
      expect(semanticElements.find(element => element.id === start!.id)).toEqual(
        expect.objectContaining({ $type: 'bpmn:StartEvent', name: 'Order received' })
      );
      expect(semanticElements.find(element => element.id === task!.id)).toEqual(
        expect.objectContaining({ $type: 'bpmn:UserTask', name: 'Review order' })
      );
      expect(semanticElements.find(element => element.id === end!.id)).toEqual(
        expect.objectContaining({ $type: 'bpmn:EndEvent', name: 'Order approved' })
      );

      const flows = semanticElements.filter(element => element.$type === 'bpmn:SequenceFlow');
      expect(flows.map(flow => ({
        source: flow.sourceRef.id,
        target: flow.targetRef.id,
        name: flow.name
      }))).toEqual([
        { source: start!.id, target: task!.id, name: 'submit' },
        { source: task!.id, target: end!.id, name: 'approve' }
      ]);

      const plane = parsed.rootElement.diagrams[0].plane;
      expect(plane.bpmnElement).toBe(bpmnProcess);
      expect(plane.planeElement.map((element: any) => element.bpmnElement.id))
        .toEqual(expect.arrayContaining([
          start!.id,
          task!.id,
          end!.id,
          ...flows.map(flow => flow.id)
        ]));

      const expectedToolError = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: 'invalid_tool_name', arguments: {} }
      }), 12);
      expect(expectedToolError).toEqual({
        content: [{ type: 'text', text: 'Error: Unknown tool: invalid_tool_name' }],
        isError: true
      });

      const files = await readdir(diagramsDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.bpmn$/);
      expect(await readFile(path.join(diagramsDirectory, files[0]), 'utf8')).toBe(xml);
      await expect(access(isolatedDefaultDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });
});
