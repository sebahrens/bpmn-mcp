import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import BpmnModdle from 'bpmn-moddle';

const STARTUP_MESSAGE = 'MCP-BPMN Server running on stdio';
const STARTUP_TIMEOUT_MS = 3000;
const RESPONSE_TIMEOUT_MS = 2000;
// A cold Chrome launch can approach the renderer's 20-second production deadline
// on contended CI runners; leave time for the response and cleanup to propagate.
const REAL_BROWSER_START_TIMEOUT_MS = 22_000;
const REAL_BROWSER_RESPONSE_TIMEOUT_MS = 25_000;

jest.setTimeout(40_000);

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
  add_event: '15686d24e00e09a6ae79a169575cd46f78e392159df53163a3fb5f9ce092bda8',
  add_activity: '0e2154e362a6b5f7f91d20dd3bd9bae2920e3b13dd0092ad53a8eb6662576c10',
  add_gateway: 'c8d6214f2dbc1bec06ddbc6d17a2052da199defd10fe3f3cb97c299752bd2544',
  add_data_object: '2a318b5ba5d7354468c71a3efc251665910e00aaf666fd46ff8b8b49b5ab4ab4',
  add_text_annotation: 'c475c6806ae5799ee8a097cd775352181e1151e9f764c32da344594e071b4694',
  connect: '51b95d23e2be7905e3691742caca9bd9bad2d9c813b038077ffccb248883a59e',
  add_association: '38126c572ff007c443b9eaf93402b04935afb1304326b082dc845586f1c64bb6',
  add_pool: 'af4830cb358539790bb20c4ec0ff38b7527bc0d1dfd05dbe2f307036314fe09e',
  add_lane: 'aa2c852e40edf37607ee0adcb6f78719e105da98fe7360559b02edcc763816ad',
  list_elements: 'a6cd6d19adcc3d088f1740e0d298d2da71c13334dfadd81348fd2e75a0f19269',
  get_element: '6a0b98f2c7a65860e11538c9226f98c244ee14ab94df83358dee8ba400c827fa',
  update_element: '878df27ce94392f82459f59092c4a39b7dfc15caa72950d52e64013ef9edfd8f',
  delete_element: '58339a2466a63b79438966015d53efdcc7b02a75930412fd06799e69e58a1941',
  export: '5246d220ea6867c12b818a950bb411b641872c4ebae8daa7462d3939e1a63710',
  validate: '7480ee2efa429395b7cd39c1cc63b6323354ab4200eb9a2135ddbf9d6b9f07b8',
  auto_layout: 'bdb18546636cee6d26f0bbf04c3f115bab3ba0f4d3808e332a738b9109e9a1e4',
  list_diagrams: '7ee2be8c2aa4cf5ee19648606709df5d0bd35de2cc3d489dbbc34ee69d81b294',
  delete_diagram_file: 'e2e4c99bc839f8567b6fbc158c5f6370b2bd906466477efad74a97738abe451d',
  get_diagrams_path: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa'
};

const EXPECTED_OUTPUT_SCHEMA_FINGERPRINTS: Record<string, string> = {
  new_bpmn: 'c75552380ad88680ac88e9868e8b41ea8d7a8190f1f4846a9af82fbcabcc1e0e',
  new_from_mermaid: '3469a18e651406b3a89ce40ceb79aa1de2c7ecd02fa24dfc0789d1223ae4c273',
  open_bpmn: '3ef91ffd2590c1a7894369c02a404f58a492556dc7f6ddc054087233747e6466',
  open_mermaid_file: '976a690c047db2f613448f4b053055b984b3e5a0ce52cc3bf0e3204f9701e5df',
  save: '77e0878869e208b96f6e4e5100b271fbafa56cf387d5a6e26d916a81187e52ec',
  save_as: '77e0878869e208b96f6e4e5100b271fbafa56cf387d5a6e26d916a81187e52ec',
  close: '77e0878869e208b96f6e4e5100b271fbafa56cf387d5a6e26d916a81187e52ec',
  current: 'fc1f775e270c61dddb84a23d1a736c94b277133290b1492d3c5e97ec48b7925f',
  add_event: 'f011fdea44dc3e2594dc34efc9fbb969bbf496cb58750a2ff1720c510f9ac5b3',
  add_activity: 'f011fdea44dc3e2594dc34efc9fbb969bbf496cb58750a2ff1720c510f9ac5b3',
  add_gateway: 'f011fdea44dc3e2594dc34efc9fbb969bbf496cb58750a2ff1720c510f9ac5b3',
  add_data_object: '5768ddd7b96e94229336217afb243150f725b8e3ef662aa5c4f5b372a8b465a7',
  add_text_annotation: 'efc252dcaf10f68d8f16df0a664a0820b4032ad2d0b89332f0a8d61a13c5571a',
  connect: 'ab64a6a261f902d9ea36d0be2bf21a5a2b3abe8b75aabca8efa94c4e85312de1',
  add_association: 'e5637f1006ada5aaa5656fda40bfd0d2e19f00d8a984eaca521a2d89acdecbab',
  add_pool: '3faceed074959ee21e0b02f1e7b1d97bd1833c7ae186a37f476f6cf0b79031d9',
  add_lane: '4a3e98a22d4446db534251878b8c8bfdc1d301fe27bbddfacefa3852b156f9b9',
  list_elements: '39fe0f90002184cabcc6807a456c175cc2b755e069b227b20aa0ec4b453e047b',
  get_element: 'd92e25534b803762677117e140406766b811154d6da8b1b6600f8c0127f32432',
  update_element: '427fef05430fa8b2ec3001fa5c10b11ebd99fd02d2c55bbe8aa16ea66ff852d5',
  delete_element: 'aceea2b43cc49d839f46aa0a4c6c92a3b68ffe3c868d6d6a9700111411a40270',
  export: '62b4cdf277d72915b590cff5fe0a0fa2569d9a6ad756ed994fab000dc5582b01',
  validate: '51b040b98aa2c23860847c0deb71e59ae2ea0a44756fb947157a61e29a2931ac',
  auto_layout: 'dadf141e336461d4e06c1e4694a6949f60c8121dbbcb343ccfba4ddb3d056b0c',
  list_diagrams: 'b70e5d844a9ff74f00dbc169404b2ff2334a47f9c3e790399733816919669ec8',
  delete_diagram_file: '08820ad10e47a4d8c3ed02d5e7a489846dcc7efacb67a12ce3fa4559486ba8f9',
  get_diagrams_path: 'fe84c056d57a34dde9e7f1e1aacf5ee9cf724dc231ec24f8acfc29b8cabce3dc'
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

function waitForProcessResult(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 3000
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (hasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`Process ${String(child.pid)} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function waitForFile(filename: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filename);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
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
  args: Record<string, unknown>,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS
): Promise<any> {
  const result = expectProtocolSuccess(await sendRequest(launch, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  }, responseTimeoutMs), id);

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

async function initializeServer(launch: ServerLaunch, clientName: string): Promise<void> {
  expectProtocolSuccess(await sendRequest(launch, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' }
    }
  }), 1);
  await sendNotification(launch.process, {
    jsonrpc: '2.0',
    method: 'notifications/initialized'
  });
}

describe('MCP server process lifecycle', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)(
    'drains an accepted mutation and exits cleanly on %s, including a repeated signal',
    async signal => {
      const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-shutdown-e2e-'));
      const marker = path.join(diagramsDirectory, 'operation-started');
      const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
      const fixturePath = path.resolve(process.cwd(), 'tests/e2e/fixtures/delayed-engine.mjs');
      const launch = launchServer(process.execPath, ['--import', fixturePath, serverPath], {
        ...process.env,
        MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory,
        MCP_BPMN_TEST_OPERATION_MARKER: marker
      });

      try {
        await launch.ready;
        await initializeServer(launch, `mcp-bpmn-${signal.toLowerCase()}-e2e`);
        await callTool(launch, 2, 'new_bpmn', { name: `${signal} drain` });
        const listing = JSON.parse(textContent(
          await callTool(launch, 3, 'list_diagrams', {})
        )) as { diagrams: Array<{ filename: string }> };
        const filename = listing.diagrams[0]?.filename;
        expect(filename).toEqual(expect.any(String));

        const mutation = sendRequest(launch, {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'add_activity',
            arguments: { activityType: 'task', name: 'Slow mutation' }
          }
        });
        await waitForFile(marker);
        const exited = waitForProcessResult(launch.process);
        expect(launch.process.kill(signal)).toBe(true);
        expect(launch.process.kill(signal)).toBe(true);
        await mutation.catch(() => undefined);

        await expect(exited).resolves.toEqual({ code: 0, signal: null });
        expect(await readFile(path.join(diagramsDirectory, filename!), 'utf8'))
          .toContain('Slow mutation');
      } finally {
        await stopServer(launch.process);
        await rm(diagramsDirectory, { recursive: true, force: true });
      }
    }
  );

  it('uses the same clean shutdown path when the stdio transport reaches EOF', async () => {
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const launch = launchServer(process.execPath, [serverPath]);

    try {
      await launch.ready;
      await initializeServer(launch, 'mcp-bpmn-eof-e2e');
      const exited = waitForProcessResult(launch.process);
      launch.process.stdin.end();
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
    } finally {
      await stopServer(launch.process);
    }
  });

  it('drains an active layout subprocess without orphaning its child', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-layout-exit-e2e-'));
    const marker = path.join(diagramsDirectory, 'layout.pid');
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const fixturePath = path.resolve(
      process.cwd(),
      'tests/e2e/fixtures/delayed-resources.mjs'
    );
    const launch = launchServer(process.execPath, ['--import', fixturePath, serverPath], {
      ...process.env,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory,
      MCP_BPMN_TEST_LAYOUT_PID: marker
    });

    try {
      await launch.ready;
      await initializeServer(launch, 'mcp-bpmn-layout-shutdown-e2e');
      await callTool(launch, 2, 'new_bpmn', { name: 'Layout shutdown' });
      await callTool(launch, 3, 'add_event', { eventType: 'start', name: 'Start' });
      await callTool(launch, 4, 'add_activity', { activityType: 'task', name: 'Work' });
      const layout = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'auto_layout', arguments: { algorithm: 'horizontal' } }
      }, 5000);
      await waitForFile(marker);
      const layoutPid = Number(await readFile(marker, 'utf8'));
      expect(isPidAlive(layoutPid)).toBe(true);

      const exited = waitForProcessResult(launch.process, 5000);
      launch.process.kill('SIGTERM');
      await layout.catch(() => undefined);
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      expect(isPidAlive(layoutPid)).toBe(false);
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

  it('drains an active SVG render and closes its browser process', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-render-exit-e2e-'));
    const marker = path.join(diagramsDirectory, 'browser.pid');
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const fixturePath = path.resolve(
      process.cwd(),
      'tests/e2e/fixtures/delayed-resources.mjs'
    );
    const launch = launchServer(process.execPath, ['--import', fixturePath, serverPath], {
      ...process.env,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory,
      MCP_BPMN_TEST_BROWSER_PID: marker
    });

    try {
      await launch.ready;
      await initializeServer(launch, 'mcp-bpmn-render-shutdown-e2e');
      await callTool(launch, 2, 'new_bpmn', { name: 'Render shutdown' });
      const render = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'export', arguments: { format: 'svg' } }
      }, REAL_BROWSER_RESPONSE_TIMEOUT_MS);
      await waitForFile(marker, REAL_BROWSER_START_TIMEOUT_MS);
      const browserPid = Number(await readFile(marker, 'utf8'));
      expect(isPidAlive(browserPid)).toBe(true);

      const exited = waitForProcessResult(launch.process, 5000);
      launch.process.kill('SIGINT');
      await render.catch(() => undefined);
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      expect(isPidAlive(browserPid)).toBe(false);
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

  it('runs startup failures through cleanup and exits with a nonzero code', async () => {
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const fixturePath = path.resolve(
      process.cwd(),
      'tests/e2e/fixtures/startup-failure.mjs'
    );
    const child = spawn(process.execPath, ['--import', fixturePath, serverPath], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });

    await expect(waitForProcessResult(child)).resolves.toEqual({ code: 1, signal: null });
    expect(stderr).toContain('Failed to start server: Error: Injected startup failure');
  });

  it('forces a nonzero exit at the configured deadline and leaves persistence unchanged', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-forced-exit-e2e-'));
    const marker = path.join(diagramsDirectory, 'operation-started');
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const fixturePath = path.resolve(process.cwd(), 'tests/e2e/fixtures/delayed-engine.mjs');
    const launch = launchServer(process.execPath, ['--import', fixturePath, serverPath], {
      ...process.env,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory,
      MCP_BPMN_SHUTDOWN_TIMEOUT_MS: '100',
      MCP_BPMN_TEST_OPERATION_MARKER: marker
    });

    try {
      await launch.ready;
      await initializeServer(launch, 'mcp-bpmn-forced-shutdown-e2e');
      await callTool(launch, 2, 'new_bpmn', { name: 'Forced shutdown' });
      const listing = JSON.parse(textContent(
        await callTool(launch, 3, 'list_diagrams', {})
      )) as { diagrams: Array<{ filename: string }> };
      const filename = listing.diagrams[0]?.filename;
      expect(filename).toEqual(expect.any(String));

      void sendRequest(launch, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'add_activity',
          arguments: { activityType: 'task', name: 'Never mutation' }
        }
      }).catch(() => undefined);
      await waitForFile(marker);
      const exited = waitForProcessResult(launch.process);
      launch.process.kill('SIGTERM');

      await expect(exited).resolves.toEqual({ code: 1, signal: null });
      expect(launch.stderr()).toContain('exceeded 100ms; forcing exit');
      expect(await readFile(path.join(diagramsDirectory, filename!), 'utf8'))
        .not.toContain('Never mutation');
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

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
  it('returns schema-valid structured output for every advertised tool', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-output-e2e-'));
    const isolatedHome = path.join(diagramsDirectory, 'isolated-home');
    const mermaidFilename = 'source-flow.mmd';
    await writeFile(
      path.join(diagramsDirectory, mermaidFilename),
      'flowchart TD\n  A[Alpha] --> B[Beta]\n',
      'utf8'
    );
    const launch = launchServer(process.execPath, [
      path.resolve(process.cwd(), 'dist/server/index.js')
    ], {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory
    });

    try {
      await launch.ready;
      await initializeServer(launch, 'mcp-bpmn-structured-output-e2e');
      const listed = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      }), 2);
      const advertisedTools = listed.tools as Array<{
        name: string;
        outputSchema: Record<string, unknown>;
      }>;
      expect(advertisedTools.map(tool => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
      expect(advertisedTools.every(tool => tool.outputSchema?.type === 'object')).toBe(true);
      expect(Object.keys(EXPECTED_OUTPUT_SCHEMA_FINGERPRINTS)).toEqual(EXPECTED_TOOL_NAMES);
      for (const tool of advertisedTools) {
        expect(schemaFingerprint(tool.outputSchema))
          .toBe(EXPECTED_OUTPUT_SCHEMA_FINGERPRINTS[tool.name]);
      }

      const outputValidators = new Map(advertisedTools.map(tool => [
        tool.name,
        new AjvJsonSchemaValidator().getValidator(tool.outputSchema as any)
      ]));
      const assertLegacyContent = (name: string, result: any) => {
        const structured = result.structuredContent as Record<string, any>;
        if (result.content[0]?.type === 'resource') {
          expect(name).toBe('export');
          expect(structured.format).toBe('svg');
          return;
        }

        const text = textContent(result);
        switch (name) {
          case 'current':
            if (structured.current) expect(JSON.parse(text)).toEqual(structured.diagram);
            else expect(text).toBe('No current diagram');
            return;
          case 'list_elements':
          case 'get_element':
          case 'list_diagrams':
            expect(JSON.parse(text)).toEqual(structured);
            return;
          case 'validate': {
            const legacy = { ...structured };
            delete legacy.filename;
            expect(JSON.parse(text)).toEqual(legacy);
            return;
          }
          case 'export':
            expect(structured).toMatchObject({ format: 'xml', mimeType: 'application/xml' });
            expect(Buffer.byteLength(text, 'utf8')).toBe(structured.byteLength);
            return;
          case 'new_bpmn':
          case 'new_from_mermaid':
          case 'open_bpmn':
            expect(text).toContain(structured.name);
            expect(text).toContain(structured.extensionProfile);
            return;
          case 'open_mermaid_file':
            expect(text).toContain(structured.sourceFilename);
            expect(text).toContain(structured.extensionProfile);
            return;
          case 'save':
          case 'save_as':
            expect(text).toContain(structured.filename);
            return;
          case 'close':
            expect(text).toContain(structured.name);
            return;
          case 'add_event':
          case 'add_activity':
          case 'add_gateway':
          case 'add_pool':
            expect(text).toContain(structured.elementId);
            return;
          case 'add_data_object':
            expect(text).toContain(structured.referenceId);
            expect(text).toContain(structured.dataObjectId);
            return;
          case 'add_text_annotation':
            expect(text).toContain(structured.annotationId);
            if (structured.associationId) expect(text).toContain(structured.associationId);
            return;
          case 'connect':
            expect(text).toContain(structured.sourceId);
            expect(text).toContain(structured.targetId);
            return;
          case 'add_association':
            expect(text).toContain(structured.associationId);
            expect(text).toContain(structured.associationDirection);
            return;
          case 'add_lane':
            expect(text).toContain(structured.laneId);
            expect(text).toContain(String(structured.assignedFlowNodeCount));
            return;
          case 'update_element':
          case 'delete_element':
            expect(text).toContain(structured.elementId);
            return;
          case 'auto_layout':
            expect(text).toContain(structured.algorithm);
            expect(text).toContain(String(structured.elementCount));
            expect(text).toContain(String(structured.connectionCount));
            return;
          case 'delete_diagram_file':
            expect(text).toContain(structured.filename);
            return;
          case 'get_diagrams_path':
            expect(text).toContain(structured.path);
            return;
          default:
            throw new Error(`Missing legacy-content assertion for advertised tool ${name}`);
        }
      };
      const calledTools = new Set<string>();
      let requestId = 3;
      const call = async (
        name: string,
        args: Record<string, unknown> = {},
        responseTimeoutMs = 6_000
      ) => {
        const result = await callTool(launch, requestId++, name, args, responseTimeoutMs);
        calledTools.add(name);
        expect(result.structuredContent).toEqual(expect.any(Object));
        const validation = outputValidators.get(name)!(result.structuredContent);
        expect(validation).toEqual(expect.objectContaining({ valid: true }));
        expect(result.content.length).toBeGreaterThan(0);
        for (const block of result.content) {
          if (block.type === 'text') expect(block.text.length).toBeGreaterThan(0);
          else expect(block.type).toBe('resource');
        }
        assertLegacyContent(name, result);
        return result;
      };

      const pathResult = await call('get_diagrams_path');
      expect(pathResult.structuredContent.path).toBe(diagramsDirectory);
      const emptyListing = await call('list_diagrams');
      expect(emptyListing.structuredContent).toMatchObject({
        count: 0,
        returnedCount: 0,
        offset: 0,
        limit: 100,
        hasMore: false,
        diagrams: []
      });

      const defaultProcess = await call('new_bpmn', { name: 'Default process' });
      expect(defaultProcess.structuredContent).toMatchObject({
        name: 'Default process',
        type: 'process',
        extensionProfile: 'portable'
      });
      await call('close');

      const mermaidCreation = await call('new_from_mermaid', {
        name: 'Structured Mermaid',
        mermaidCode: 'flowchart TD\n  Start[Start] --> Finish[Finish]'
      });
      expect(mermaidCreation.structuredContent).toMatchObject({
        processId: expect.any(String),
        filename: expect.stringMatching(/\.bpmn$/),
        type: 'process',
        extensionProfile: 'portable',
        nodeCount: 2,
        flowCount: 1,
        warnings: []
      });
      const mermaidBpmnFilename = mermaidCreation.structuredContent.filename as string;

      const current = await call('current');
      expect(current.structuredContent).toMatchObject({
        current: true,
        diagram: { filename: mermaidBpmnFilename }
      });
      const elementListing = await call('list_elements');
      expect(elementListing.structuredContent).toMatchObject({
        count: 2,
        returnedCount: 2,
        offset: 0,
        limit: 100,
        hasMore: false
      });
      const listedElements = elementListing.structuredContent.elements as Array<{
        id: string;
        type: string;
      }>;
      const firstElement = listedElements[0];
      const secondElement = listedElements[1];
      const firstElementPage = await call('list_elements', { limit: 1, offset: 0 });
      const secondElementPage = await call('list_elements', { limit: 1, offset: 1 });
      expect(firstElementPage.structuredContent).toMatchObject({
        count: 2,
        returnedCount: 1,
        offset: 0,
        limit: 1,
        hasMore: true,
        elements: [firstElement]
      });
      expect(secondElementPage.structuredContent).toMatchObject({
        count: 2,
        returnedCount: 1,
        offset: 1,
        limit: 1,
        hasMore: false,
        elements: [secondElement]
      });
      const details = await call('get_element', { elementId: firstElement.id });
      expect(details.structuredContent).toMatchObject({
        id: firstElement.id,
        type: firstElement.type
      });
      const updated = await call('update_element', {
        elementId: firstElement.id,
        name: 'Updated Alpha'
      });
      expect(updated.structuredContent).toEqual({
        elementId: firstElement.id,
        filename: mermaidBpmnFilename
      });
      const layout = await call('auto_layout');
      expect(layout.structuredContent).toMatchObject({
        algorithm: 'horizontal',
        elementCount: 2,
        connectionCount: 1,
        warnings: expect.any(Array),
        filename: mermaidBpmnFilename
      });

      const event = await call('add_event', { eventType: 'end', name: 'Done' });
      const activity = await call('add_activity', { activityType: 'task', name: 'Review' });
      const gateway = await call('add_gateway', { gatewayType: 'exclusive', name: 'Decision' });
      for (const result of [event, activity, gateway]) {
        expect(result.structuredContent).toMatchObject({
          elementId: expect.any(String),
          elementType: expect.stringMatching(/^bpmn:/),
          filename: mermaidBpmnFilename
        });
      }
      const dataObject = await call('add_data_object', { name: 'Request data' });
      expect(dataObject.structuredContent).toMatchObject({
        referenceId: expect.any(String),
        dataObjectId: expect.any(String),
        filename: mermaidBpmnFilename
      });
      const dataObjectDetails = await call('get_element', {
        elementId: dataObject.structuredContent.referenceId
      });
      expect(dataObjectDetails.structuredContent.properties).toMatchObject({
        dataObjectRef: dataObject.structuredContent.dataObjectId,
        isCollection: false
      });
      const annotation = await call('add_text_annotation', {
        text: 'Review note',
        associatedElementId: activity.structuredContent.elementId
      });
      expect(annotation.structuredContent).toMatchObject({
        annotationId: expect.any(String),
        associationId: expect.any(String),
        filename: mermaidBpmnFilename
      });
      const unassociatedAnnotation = await call('add_text_annotation', {
        text: 'Standalone note'
      });
      expect(unassociatedAnnotation.structuredContent).toEqual({
        annotationId: expect.any(String),
        filename: mermaidBpmnFilename
      });
      const connection = await call('connect', {
        sourceId: secondElement.id,
        targetId: activity.structuredContent.elementId,
        label: 'continue'
      });
      expect(connection.structuredContent).toMatchObject({
        connectionId: expect.any(String),
        connectionType: 'bpmn:SequenceFlow',
        sourceId: secondElement.id,
        targetId: activity.structuredContent.elementId,
        filename: mermaidBpmnFilename
      });
      const defaultFlowSource = await call('get_element', { elementId: secondElement.id });
      expect(defaultFlowSource.structuredContent).not.toHaveProperty('defaultFlow');
      expect(defaultFlowSource.structuredContent.outgoing).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: connection.structuredContent.connectionId,
          isDefault: false
        })
      ]));
      const association = await call('add_association', {
        sourceId: dataObject.structuredContent.referenceId,
        targetId: activity.structuredContent.elementId
      });
      expect(association.structuredContent).toMatchObject({
        associationId: expect.any(String),
        associationDirection: 'None',
        filename: mermaidBpmnFilename
      });
      const associationDetails = await call('get_element', {
        elementId: association.structuredContent.associationId
      });
      expect(associationDetails.structuredContent).toMatchObject({
        id: association.structuredContent.associationId,
        type: 'bpmn:Association',
        sourceId: dataObject.structuredContent.referenceId,
        targetId: activity.structuredContent.elementId,
        associationDirection: 'None'
      });
      const deletedConnection = await call('delete_element', {
        elementId: connection.structuredContent.connectionId
      });
      expect(deletedConnection.structuredContent).toEqual({
        elementId: connection.structuredContent.connectionId,
        deletedKind: 'connection',
        removedConnectionCount: 0,
        filename: mermaidBpmnFilename
      });

      const validation = await call('validate');
      expect(validation.structuredContent).toMatchObject({
        level: 'full',
        issues: expect.any(Array),
        errors: expect.any(Array),
        warnings: expect.any(Array),
        filename: mermaidBpmnFilename
      });
      const validationIssues = validation.structuredContent.issues as Array<{
        severity: 'error' | 'warning';
      }>;
      expect(validationIssues.length).toBeGreaterThan(0);
      expect(validation.structuredContent.errors).toEqual(
        validationIssues.filter(issue => issue.severity === 'error')
      );
      expect(validation.structuredContent.warnings).toEqual(
        validationIssues.filter(issue => issue.severity === 'warning')
      );
      expect(validation.structuredContent.valid)
        .toBe(validation.structuredContent.errors.length === 0);
      expect(validation.structuredContent.issues).toEqual(expect.arrayContaining([{
        code: 'BPMN_PROFILE_MISSING_INCOMING_FLOW',
        severity: 'warning',
        message: 'Flow node should have an incoming sequence flow',
        elementId: activity.structuredContent.elementId
      }]));
      expect(validation.structuredContent.summary).toBe(
        `Validation ${validation.structuredContent.valid ? 'passed' : 'failed'}: `
        + `${validation.structuredContent.errors.length} errors, `
        + `${validation.structuredContent.warnings.length} warnings`
      );

      const xmlExport = await call('export');
      expect(xmlExport.structuredContent).toMatchObject({
        processId: mermaidCreation.structuredContent.processId,
        filename: mermaidBpmnFilename,
        format: 'xml',
        mimeType: 'application/xml',
        byteLength: Buffer.byteLength(textContent(xmlExport), 'utf8')
      });
      expect(textContent(xmlExport)).toMatch(/^<\?xml[^>]*>\n/);
      expect(textContent(xmlExport)).toContain('\n  <');
      const svgExport = await call(
        'export',
        { format: 'svg' },
        REAL_BROWSER_RESPONSE_TIMEOUT_MS
      );
      const svgResource = svgExport.content[0].resource;
      expect(svgExport.structuredContent).toMatchObject({
        processId: mermaidCreation.structuredContent.processId,
        filename: mermaidBpmnFilename,
        format: 'svg',
        mimeType: 'image/svg+xml',
        byteLength: Buffer.byteLength(svgResource.text, 'utf8'),
        uri: svgResource.uri
      });
      expect(svgExport.structuredContent.mimeType).toBe(svgResource.mimeType);

      expect((await call('save')).structuredContent.filename).toBe(mermaidBpmnFilename);
      const savedAs = await call('save_as', { filename: 'structured-output.bpmn' });
      expect(savedAs.structuredContent.filename).toBe('structured-output.bpmn');
      expect((await call('close')).structuredContent.filename).toBe('structured-output.bpmn');
      const opened = await call('open_bpmn', { filename: 'structured-output.bpmn' });
      expect(opened.structuredContent).toMatchObject({
        filename: 'structured-output.bpmn',
        elementCount: expect.any(Number),
        connectionCount: expect.any(Number)
      });
      const deleted = await call('delete_element', {
        elementId: gateway.structuredContent.elementId
      });
      expect(deleted.structuredContent).toEqual({
        elementId: gateway.structuredContent.elementId,
        deletedKind: 'element',
        removedConnectionCount: 0,
        filename: 'structured-output.bpmn'
      });
      await call('close');

      const importedFilename = 'imported-output-variants.bpmn';
      const importedFixture = await readFile(path.resolve(
        process.cwd(),
        'tests/fixtures/import-roundtrip/full-semantics-di.bpmn'
      ), 'utf8');
      const importedXml = importedFixture
        .replace('<dc:Bounds x="110" y="190"', '<dc:Bounds x="-25" y="190"')
        .replace(
          '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">',
          '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" evaluatesToTypeRef="ItemDefinition_Request">'
        );
      expect(importedXml).toContain('x="-25"');
      expect(importedXml).toContain('evaluatesToTypeRef="ItemDefinition_Request"');
      expect((await new BpmnModdle().fromXML(importedXml)).warnings).toEqual([]);
      await writeFile(path.join(diagramsDirectory, importedFilename), importedXml, 'utf8');
      await call('open_bpmn', { filename: importedFilename });
      const importedPosition = await call('get_element', { elementId: 'Start_RoundTrip' });
      expect(importedPosition.structuredContent.position.x).toBe(-25);
      const importedDetails = await call('get_element', { elementId: 'Gateway_Decision' });
      expect(importedDetails.structuredContent.outgoing).toEqual(expect.arrayContaining([
        expect.objectContaining({
          condition: expect.objectContaining({ evaluatesToTypeRef: 'ItemDefinition_Request' })
        })
      ]));
      await call('close');

      const openedMermaid = await call('open_mermaid_file', { filename: mermaidFilename });
      expect(openedMermaid.structuredContent).toMatchObject({
        sourceFilename: mermaidFilename,
        filename: expect.stringMatching(/\.bpmn$/),
        extensionProfile: 'portable',
        nodeCount: 2,
        flowCount: 1
      });
      const openedMermaidFilename = openedMermaid.structuredContent.filename as string;
      await call('close');

      const collaboration = await call('new_bpmn', {
        name: 'Structured Collaboration',
        type: 'collaboration'
      });
      expect(collaboration.structuredContent).toMatchObject({
        type: 'collaboration',
        filename: expect.stringMatching(/\.bpmn$/)
      });
      const pool = await call('add_pool', { name: 'Operations' });
      expect(pool.structuredContent).toMatchObject({
        elementId: expect.any(String),
        processId: expect.any(String),
        blackBox: false,
        filename: collaboration.structuredContent.filename
      });
      const blackBoxPool = await call('add_pool', { name: 'External', blackBox: true });
      expect(blackBoxPool.structuredContent).toEqual({
        elementId: expect.any(String),
        blackBox: true,
        filename: collaboration.structuredContent.filename
      });
      const poolActivity = await call('add_activity', {
        activityType: 'task',
        name: 'Handle request',
        ownerId: pool.structuredContent.processId,
        scopeId: pool.structuredContent.processId
      });
      const lane = await call('add_lane', {
        poolId: pool.structuredContent.elementId,
        name: 'Team',
        flowNodeIds: [poolActivity.structuredContent.elementId],
        position: 'top'
      });
      expect(lane.structuredContent).toMatchObject({
        laneId: expect.any(String),
        poolId: pool.structuredContent.elementId,
        assignedFlowNodeCount: 1,
        filename: collaboration.structuredContent.filename
      });
      const laneDetails = await call('get_element', {
        elementId: lane.structuredContent.laneId
      });
      expect(laneDetails.structuredContent).toMatchObject({
        id: lane.structuredContent.laneId,
        type: 'bpmn:Lane',
        properties: { flowNodeRefs: [poolActivity.structuredContent.elementId] }
      });
      const bottomActivity = await call('add_activity', {
        activityType: 'task',
        name: 'Bottom task',
        ownerId: pool.structuredContent.processId,
        scopeId: pool.structuredContent.processId
      });
      const defaultBottomLane = await call('add_lane', {
        poolId: pool.structuredContent.elementId,
        name: 'Default bottom lane',
        flowNodeIds: [bottomActivity.structuredContent.elementId]
      });
      const defaultBottomLaneDetails = await call('get_element', {
        elementId: defaultBottomLane.structuredContent.laneId
      });
      expect(defaultBottomLaneDetails.structuredContent.position.y)
        .toBeGreaterThan(laneDetails.structuredContent.position.y);
      const diagramFilenames: string[] = [];
      let expectedDiagramCount: number | undefined;
      let diagramOffset = 0;
      let diagramHasMore: boolean;
      do {
        const page = await call('list_diagrams', { limit: 1, offset: diagramOffset });
        expectedDiagramCount ??= page.structuredContent.count;
        expect(page.structuredContent).toMatchObject({
          count: expectedDiagramCount,
          returnedCount: 1,
          offset: diagramOffset,
          limit: 1
        });
        diagramFilenames.push(page.structuredContent.diagrams[0].filename);
        diagramHasMore = page.structuredContent.hasMore;
        diagramOffset += 1;
      } while (diagramHasMore);
      expect(diagramHasMore).toBe(false);
      expect(expectedDiagramCount).toBeGreaterThan(1);
      expect(diagramFilenames).toHaveLength(expectedDiagramCount!);
      expect(new Set(diagramFilenames).size).toBe(expectedDiagramCount);
      const deletedNonCurrentFile = await call('delete_diagram_file', {
        filename: openedMermaidFilename
      });
      expect(deletedNonCurrentFile.structuredContent).toEqual({
        filename: openedMermaidFilename,
        closedCurrent: false
      });
      const deletedFile = await call('delete_diagram_file', {
        filename: collaboration.structuredContent.filename
      });
      expect(deletedFile.structuredContent).toEqual({
        filename: collaboration.structuredContent.filename,
        closedCurrent: true
      });
      expect((await call('current')).structuredContent).toEqual({ current: false });

      const expectedToolError = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: requestId++,
        method: 'tools/call',
        params: { name: 'add_event', arguments: { eventType: 'start' } }
      }), requestId - 1);
      expect(expectedToolError).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('Error: No current context') }],
        isError: true
      });
      expect(expectedToolError.structuredContent).toBeUndefined();

      expect([...calledTools].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

  it('serializes pipelined current-diagram calls and stays live after a tool error', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-queue-e2e-'));
    const isolatedHome = path.join(diagramsDirectory, 'isolated-home');
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const delayFixturePath = path.resolve(
      process.cwd(),
      'tests/e2e/fixtures/delayed-engine.mjs'
    );
    const launch = launchServer(process.execPath, ['--import', delayFixturePath, serverPath], {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory
    });

    try {
      await launch.ready;
      expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'mcp-bpmn-queue-e2e', version: '1.0.0' }
        }
      }), 1);
      await sendNotification(launch.process, {
        jsonrpc: '2.0',
        method: 'notifications/initialized'
      });

      const [slowCreate, fastCreate] = await Promise.all([
        sendRequest(launch, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'new_bpmn', arguments: { name: 'Slow create' } }
        }),
        sendRequest(launch, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'new_bpmn', arguments: { name: 'Fast create' } }
        })
      ]);
      expect(expectProtocolSuccess(slowCreate, 2).isError).not.toBe(true);
      expect(expectProtocolSuccess(fastCreate, 3).isError).not.toBe(true);

      const currentAfterCreates = JSON.parse(textContent(
        await callTool(launch, 4, 'current', {})
      )) as { name: string };
      expect(currentAfterCreates.name).toBe('Fast create');

      const listing = JSON.parse(textContent(
        await callTool(launch, 5, 'list_diagrams', {})
      )) as { diagrams: Array<{ filename: string; name: string }> };
      const slowFile = listing.diagrams.find(diagram => diagram.name === 'Slow create')?.filename;
      const fastFile = listing.diagrams.find(diagram => diagram.name === 'Fast create')?.filename;
      expect(slowFile).toEqual(expect.any(String));
      expect(fastFile).toEqual(expect.any(String));
      if (!slowFile || !fastFile) {
        throw new Error('Expected both pipelined creates to persist a diagram file');
      }

      const slowMutationRequest = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'add_activity',
          arguments: { activityType: 'task', name: 'Slow mutation' }
        }
      });
      const closeRequest = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'close', arguments: {} }
      });
      await expect(Promise.race([
        slowMutationRequest.then(() => 'mutation'),
        closeRequest.then(() => 'close')
      ])).resolves.toBe('mutation');
      expect(expectProtocolSuccess(await slowMutationRequest, 6).isError).not.toBe(true);
      expect(expectProtocolSuccess(await closeRequest, 7).isError).not.toBe(true);
      expect(textContent(await callTool(launch, 8, 'current', {}))).toBe('No current diagram');

      const [opened, rejected, recoveredMutation] = await Promise.all([
        sendRequest(launch, {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'open_bpmn', arguments: { filename: slowFile } }
        }),
        sendRequest(launch, {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'injected_queue_rejection', arguments: {} }
        }),
        sendRequest(launch, {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'add_activity',
            arguments: { activityType: 'task', name: 'Recovered mutation' }
          }
        })
      ]);
      expect(expectProtocolSuccess(opened, 9).isError).not.toBe(true);
      expect(rejected).toMatchObject({
        jsonrpc: '2.0',
        id: 10,
        error: { message: 'Injected queue rejection' }
      });
      expect(expectProtocolSuccess(recoveredMutation, 11).isError).not.toBe(true);

      const finalCurrent = JSON.parse(textContent(
        await callTool(launch, 12, 'current', {})
      )) as { name: string };
      expect(finalCurrent.name).toBe('Slow create');

      const exportRequest = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'export', arguments: { format: 'xml' } }
      });
      const finalCloseRequest = sendRequest(launch, {
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: { name: 'close', arguments: {} }
      });
      await expect(Promise.race([
        exportRequest.then(() => 'export'),
        finalCloseRequest.then(() => 'close')
      ])).resolves.toBe('export');
      expect(textContent(expectProtocolSuccess(await exportRequest, 13)))
        .toContain('Recovered mutation');
      expect(expectProtocolSuccess(await finalCloseRequest, 14).isError).not.toBe(true);
      expect(textContent(await callTool(launch, 15, 'current', {}))).toBe('No current diagram');

      const slowXml = await readFile(path.join(diagramsDirectory, slowFile), 'utf8');
      const fastXml = await readFile(path.join(diagramsDirectory, fastFile), 'utf8');
      expect(slowXml).toContain('Recovered mutation');
      expect(fastXml).toContain('Slow mutation');
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

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
        },
        instructions: expect.any(String)
      });
      const instructions = initialize.instructions as string;
      const portableBaseline = instructions.split('\n\n')[0];
      expect(portableBaseline.length).toBeLessThanOrEqual(512);
      expect(portableBaseline).toContain('one active BPMN diagram');
      expect(portableBaseline).toContain('mutations auto-save');
      expect(portableBaseline).toContain('element IDs returned');
      expect(portableBaseline).toContain('configured diagram store');
      expect(portableBaseline).toContain('explicit user confirmation');
      expect(portableBaseline).toContain('destructively replacing');
      expect(instructions).toContain('validate, then auto_layout, then validate again');
      expect(instructions).toContain('while hasMore is true');
      expect(instructions).toContain('offset + returnedCount');
      expect(instructions).toContain('tools/list');
      expect(instructions.length).toBeLessThanOrEqual(750);

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
      const autoLayoutSchema = advertisedTools.find(tool => tool.name === 'auto_layout')!
        .inputSchema as { properties: { algorithm: { enum: string[] } } };
      expect(autoLayoutSchema.properties.algorithm.enum).toEqual(['horizontal']);

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

      const validationBeforeLayout = JSON.parse(textContent(
        await callTool(launch, 11, 'validate', { level: 'full' })
      )) as { valid: boolean; summary: string };
      expect(validationBeforeLayout).toEqual(expect.objectContaining({
        valid: true,
        summary: expect.stringContaining('Validation passed')
      }));

      expect(textContent(await callTool(launch, 12, 'auto_layout', {
        algorithm: 'horizontal'
      }))).toContain('Applied horizontal auto-layout');

      const unsupportedLayout = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'auto_layout', arguments: { algorithm: 'vertical' } }
      }), 13);
      expect(unsupportedLayout.isError).toBe(true);
      expect(textContent(unsupportedLayout)).toContain('algorithm: Invalid enum value');
      expect(textContent(unsupportedLayout)).not.toContain('Only horizontal layout algorithm');

      const validationAfterLayout = JSON.parse(textContent(
        await callTool(launch, 14, 'validate', { level: 'full' })
      )) as { valid: boolean; summary: string };
      expect(validationAfterLayout).toEqual(expect.objectContaining({
        valid: true,
        summary: expect.stringContaining('Validation passed')
      }));

      const xml = textContent(await callTool(launch, 15, 'export', {
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

      const submitFlow = flows.find(flow => flow.name === 'submit');
      expect(submitFlow).toBeDefined();
      expect(textContent(await callTool(launch, 16, 'delete_element', {
        elementId: submitFlow.id
      }))).toBe(`Deleted sequence flow ${submitFlow.id}`);

      const deletedXml = textContent(await callTool(launch, 17, 'export', {
        format: 'xml',
        formatted: true
      }));
      const deletedParsed = await new BpmnModdle().fromXML(deletedXml);
      expect(deletedParsed.warnings).toEqual([]);
      expect(deletedParsed.elementsById[submitFlow.id]).toBeUndefined();
      expect(deletedParsed.elementsById[`${submitFlow.id}_di`]).toBeUndefined();
      expect(deletedParsed.elementsById[start!.id]).toBeDefined();
      expect(deletedParsed.elementsById[task!.id]).toBeDefined();
      expect(deletedParsed.elementsById[end!.id]).toBeDefined();
      expect(deletedParsed.elementsById[flows.find(flow => flow.name === 'approve')!.id])
        .toBeDefined();

      const unknownConnection = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 18,
        method: 'tools/call',
        params: { name: 'delete_element', arguments: { elementId: 'Flow_Missing' } }
      }), 18);
      expect(unknownConnection).toEqual({
        content: [{ type: 'text', text: 'Error: Element Flow_Missing not found' }],
        isError: true
      });
      expect(textContent(await callTool(launch, 19, 'export', {
        format: 'xml',
        formatted: true
      }))).toBe(deletedXml);

      const expectedToolError = expectProtocolSuccess(await sendRequest(launch, {
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: { name: 'invalid_tool_name', arguments: {} }
      }), 20);
      expect(expectedToolError).toEqual({
        content: [{ type: 'text', text: 'Error: Unknown tool: invalid_tool_name' }],
        isError: true
      });

      const files = await readdir(diagramsDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.bpmn$/);
      expect(await readFile(path.join(diagramsDirectory, files[0]), 'utf8')).toBe(deletedXml);
      await expect(access(isolatedDefaultDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });
});
