import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
  'list_connections',
  'get_connection',
  'update_element',
  'update_connection',
  'update_element_geometry',
  'update_connection_geometry',
  'apply_geometry_patch',
  'route_connection',
  'delete_element',
  'export',
  'save_svg',
  'save_png',
  'validate',
  'analyze_geometry',
  'auto_layout',
  'list_diagrams',
  'delete_diagram_file',
  'get_diagrams_path',
  'get_workspace',
  'select_workspace'
] as const;

// Fingerprints pin the complete advertised input schemas. A schema change must
// therefore be reviewed and explicitly accepted here instead of silently
// weakening e2e.
const EXPECTED_SCHEMA_FINGERPRINTS: Record<string, string> = {
  new_bpmn: 'c8d67446a39cc6e7bd278a6e656ac43e7dd873151b090660e3521839b361919b',
  new_from_mermaid: 'bdf6ae5a0516b9425ce350bbeb53f5a9908aca7954c50a8a629a78e12ae4b6b8',
  open_bpmn: '7587abc15d187397b8d68fe03f16befb84d338d6c996c9698ed095c172575e33',
  open_mermaid_file: '45b8782a7743d24839dc7235199cde0ed9c661ea1a756448251d0432b801e065',
  save: 'e3953439e8c37941081d153623aa62a4f5c3d66d40311fb5d141d83b8bb4149b',
  save_as: '7776d32d4d8f27f75d90dda36f7a2dd6da991820c4444499965176e47b34a9e5',
  close: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  current: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  add_event: 'e7d02f2eb7ed8ff409725ac57cf6c3aa7533253dabdaa9fa5698e6c5f7ffc2ca',
  add_activity: '28047c2200d1bc4285c83c7f0c0973055987959bd23d917c751454f71dd5b1f2',
  add_gateway: '6b90a1756c20772fe595355864c30b2fccfb5aa64863c08fb21bacb36f007d54',
  add_data_object: 'c17986f49a040a837a7380c3e772f5c59961fcd38045a8456ca925fce1ddd900',
  add_text_annotation: '7a0ccb8cca4dd0186e652b86644cd514dd17a73b2281530960cfb0152ceff388',
  connect: '2f907c315ebe108e83269f200f4483e627924af5e01e05834f73664f86a0f6d5',
  add_association: 'b3b5f6b89d87a1210a273980ba9c4c40eae60e4591f86dc0725a8ac44dabaa24',
  add_pool: '550f30243a1967595a7dbf31813529298ae6d201a6e6892764094beba6960424',
  add_lane: '3d7bae26730864137e5835e922c34a55a95cc4e74e983b815098baac7781729d',
  list_elements: 'a6cd6d19adcc3d088f1740e0d298d2da71c13334dfadd81348fd2e75a0f19269',
  get_element: '6a0b98f2c7a65860e11538c9226f98c244ee14ab94df83358dee8ba400c827fa',
  list_connections: '0955a33a04979d10fe4e6d10d2e491e90b6421c44cd288980646cdcfc1a0ac0f',
  get_connection: 'a8d2494864383f5456f5246b9db83755e7e386bc3c3e23a4731b229ff2cdfa86',
  update_element: 'fc7b11fde0c85ea6ab0bf4b7256b6bdb4a59c55e8b24d4704de1c0cb06d78976',
  update_connection: 'a21f42a43df5e3c44f71c416dca5ef832615d387245e750d13b2c01aea2e8413',
  update_element_geometry: 'af731b8e3af773c333b56069b5b0612b84548b77ee0de1f91b3bf86138689a78',
  update_connection_geometry: '23154fdaf45120b7811eab3f1937912df423cc8ac0c286aa9b2642f42add8c67',
  apply_geometry_patch: 'b24ad1f84788b55f3a90c9a91a28b649ab58184286024b4c10b048ef5d543fa3',
  route_connection: '97f02593e029053aad4ef8bfdf43002ab62be0f24e2660b87a784616cb2b3eec',
  delete_element: '180e259778ae17811d6b473dd94661e2da2f7be52d8350c7d95afb09b2a05a06',
  export: '5246d220ea6867c12b818a950bb411b641872c4ebae8daa7462d3939e1a63710',
  save_svg: '63463e9bad4e8f8f17a905f0b237431048d40742c5990347dcba88e3385dd695',
  save_png: '128f014b187ac80c6dfab3977a267fc3f0aabac2194ec689c42b03888496c5b1',
  validate: '7480ee2efa429395b7cd39c1cc63b6323354ab4200eb9a2135ddbf9d6b9f07b8',
  analyze_geometry: 'bbd7b771ec28732a75288fbd1b7a96af5dc4686983681ad8ecc95dc1fcc64eb7',
  auto_layout: 'e102744408602f685882544dd368cef68f410c2545bae815796aa50ad91dee43',
  list_diagrams: '7ee2be8c2aa4cf5ee19648606709df5d0bd35de2cc3d489dbbc34ee69d81b294',
  delete_diagram_file: 'e2e4c99bc839f8567b6fbc158c5f6370b2bd906466477efad74a97738abe451d',
  get_diagrams_path: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  get_workspace: '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
  select_workspace: 'cb23e8b6c4dfad30db9a249668a70d3b7eb18e21f1299adb2dbcfa0f15090fd9'
};

const EXPECTED_OUTPUT_SCHEMA_FINGERPRINTS: Record<string, string> = {
  new_bpmn: '04bf0364da0b9823385a2482fa8b9fed98182e2e28db3db602c1b35d8296d180',
  new_from_mermaid: 'abc91ffdb190e1a0f54357efa2f059841b4af090cbad1df038b963d4a61d8cb3',
  open_bpmn: 'c950412b9362a324d5aadb4de15e88e55d403dbabd80ca822e18a763e89326ce',
  open_mermaid_file: '902e5e667eae807c7a05494155ade36923c276fa031ca3322f5c45c32704bbe8',
  save: 'cce8979283b4f6d56e348dd8cdb401f5e5f94ccb656dd6e93d44581d10e79cc8',
  save_as: 'cce8979283b4f6d56e348dd8cdb401f5e5f94ccb656dd6e93d44581d10e79cc8',
  close: 'bb1f660f35dbe3378b10a47ecebe1a803b1bd437ccb3f280d1bd837d77e13aac',
  current: '957f34a407215681221444baaaf02adff10f93d5a507592135bf88feebc47aaa',
  add_event: 'd7e3c2de2b29bec9cc34c7849892fe7201ff687eb423d699353287d678022964',
  add_activity: 'd7e3c2de2b29bec9cc34c7849892fe7201ff687eb423d699353287d678022964',
  add_gateway: 'd7e3c2de2b29bec9cc34c7849892fe7201ff687eb423d699353287d678022964',
  add_data_object: 'b0c5f7a6cb41a8cafd8f491d968efc98c19ff3748e29a87cbce6e4dae7210b19',
  add_text_annotation: '87075ca424a6ec6d523e96a339c6a2c6ba75d1f8eb01cca28453c901dfc5889a',
  connect: '67a04acd2405d0d07639fbf99eca3a11dde5a77d4255a920e932b49da3497d91',
  add_association: 'b46defecc658ffbd49c16e3ce77584a6df835e00497bddf1bccb03661b2dd1a0',
  add_pool: '91fc256a5c8c10d230a926252ba5d816d41f350a7a98d682239a6b5f76c55ebb',
  add_lane: '70fdb3ef5c34986164384cf1b4f3b267ccaa75c88a702ecfbe30fb2e56106497',
  list_elements: 'c9a126d8679efad62943b7979effeb020d66d54252d552f73f6fff6402f4293a',
  get_element: '6bacfd2932098da88df335c374f8ddaa3d728f6c810b270da9856f7ace60c3fe',
  list_connections: '7be4192a2906654bb980870e3b5bc5ba8dfbac8e6d13dd80376386da4dacb150',
  get_connection: 'd7c972eafd878cfa1321ae3de8c8391fd88db5d7352bc16117aa24effa143592',
  update_element: '7a9342ecc1c04552b07d66e8d30893a6a19940419c2e40a1a4f7779f0903bab6',
  update_connection: 'd27c4cd3a1ae6e629e10a517f04153679f7df128773b6e2427085a33bfb7ce00',
  update_element_geometry: 'c057fce71e7bd4f74d321e0aa39fc3948bb8367ad8b775794aa91dc08816f74c',
  update_connection_geometry: '107dd91228c30411da079888af0c8baa9e1e09021cfc5f428b46c82e975fe654',
  apply_geometry_patch: '28aaa10560531121a986edb44a9220ad88f23bdfbd9eb29c3f0dc3bc0125832e',
  route_connection: 'c5d75104c94e3bee70e050c7cd0998ecc9555508d73cdfe9fa3d0145fe37451a',
  delete_element: 'cb744fd33b21e9cf83a53dc2e36818647481910cd018e4491008353d2e71e330',
  export: '62b4cdf277d72915b590cff5fe0a0fa2569d9a6ad756ed994fab000dc5582b01',
  save_svg: '03d7e82d126d313d69758afad9a933dcd60f4eca906b19a260ccb6ca3b6d83b5',
  save_png: '82a7fa1d59b5ff0a616e386ffe9b07be7367f8d41017faa5b9dd50bca2a7ee64',
  validate: '51b040b98aa2c23860847c0deb71e59ae2ea0a44756fb947157a61e29a2931ac',
  analyze_geometry: '726e0006fae222243be6da25c89d3823fe0375e2b28446e3c00e7d5ea4206495',
  auto_layout: 'a27dd3a547ee7662516554c754956196eea5fe5ecb348aaf66fc6506e4c9c352',
  list_diagrams: 'b70e5d844a9ff74f00dbc169404b2ff2334a47f9c3e790399733816919669ec8',
  delete_diagram_file: '08820ad10e47a4d8c3ed02d5e7a489846dcc7efacb67a12ce3fa4559486ba8f9',
  get_diagrams_path: 'fe84c056d57a34dde9e7f1e1aacf5ee9cf724dc231ec24f8acfc29b8cabce3dc',
  get_workspace: '5c322f6ad5f4f47efdf0ca4e29ce43aca2dfd1ae458907639dfd5f190c71bb68',
  select_workspace: 'bb83cdfb45ac5e7bfb201d5b869731a577b623e25e50be008910a2eab9961b75'
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
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  cwd?: string
): ServerLaunch {
  const child = spawn(command, args, {
    cwd,
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
    const diagramsDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-output-e2e-'))
    );
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
    }, STARTUP_TIMEOUT_MS, diagramsDirectory);

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
          case 'list_connections':
          case 'get_connection':
          case 'list_diagrams':
          case 'analyze_geometry':
          case 'update_element_geometry':
          case 'update_connection':
          case 'update_connection_geometry':
          case 'apply_geometry_patch':
          case 'route_connection':
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
          case 'save_svg':
          case 'save_png':
            expect(text).toContain(structured.filename);
            return;
          case 'get_diagrams_path':
            expect(text).toContain(structured.path);
            return;
          case 'get_workspace':
          case 'select_workspace':
            expect(JSON.parse(text)).toEqual(structured);
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
        responseTimeoutMs = (name === 'export' && args.format === 'svg')
          || name === 'save_svg'
          || name === 'save_png'
          ? REAL_BROWSER_RESPONSE_TIMEOUT_MS
          : 6_000
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
      const workspaceResult = await call('get_workspace');
      expect(workspaceResult.structuredContent).toMatchObject({
        launchCwd: diagramsDirectory,
        startupBoundary: diagramsDirectory,
        workspace: diagramsDirectory,
        source: 'environment'
      });
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
      const connectionListing = await call('list_connections', {
        connectionType: 'bpmn:SequenceFlow',
        limit: 1,
        offset: 0
      });
      expect(connectionListing.structuredContent).toMatchObject({
        count: 1,
        returnedCount: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
        connections: [{
          type: 'bpmn:SequenceFlow',
          sourceId: expect.any(String),
          targetId: expect.any(String),
          isDefault: false,
          edgeId: expect.any(String),
          waypoints: expect.any(Array),
          geometryRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
        }],
        revision: expect.any(String)
      });
      expect(new Set([
        connectionListing.structuredContent.connections[0].sourceId,
        connectionListing.structuredContent.connections[0].targetId
      ])).toEqual(new Set([firstElement.id, secondElement.id]));
      const connectionDetails = await call('get_connection', {
        connectionId: connectionListing.structuredContent.connections[0].id
      });
      expect(connectionDetails.structuredContent)
        .toEqual(expect.objectContaining(connectionListing.structuredContent.connections[0]));
      const connectionGeometryPreview = await call('update_connection_geometry', {
        connectionId: connectionDetails.structuredContent.id,
        waypoints: connectionDetails.structuredContent.waypoints,
        expectedWaypoints: connectionDetails.structuredContent.waypoints,
        expectedGeometryRevision: connectionDetails.structuredContent.geometryRevision,
        expectedRevision: connectionDetails.structuredContent.revision,
        dryRun: true
      });
      expect(connectionGeometryPreview.structuredContent).toMatchObject({
        connectionId: connectionDetails.structuredContent.id,
        before: {
          edgeId: connectionDetails.structuredContent.edgeId,
          waypoints: connectionDetails.structuredContent.waypoints,
          geometryRevision: connectionDetails.structuredContent.geometryRevision
        },
        after: {
          waypoints: connectionDetails.structuredContent.waypoints,
          geometryRevision: connectionDetails.structuredContent.geometryRevision
        },
        endpointPolicy: 'exact',
        collisionPolicy: 'reject-new',
        dryRun: true,
        applied: false,
        beforeRevision: connectionDetails.structuredContent.revision,
        afterRevision: connectionDetails.structuredContent.revision,
        filename: mermaidBpmnFilename
      });
      const connectionSemanticUpdate = await call('update_connection', {
        connectionId: connectionDetails.structuredContent.id,
        label: 'Updated connection',
        expectedSemanticRevision: connectionDetails.structuredContent.semanticRevision
      });
      expect(connectionSemanticUpdate.structuredContent).toMatchObject({
        connectionId: connectionDetails.structuredContent.id,
        before: { semanticRevision: connectionDetails.structuredContent.semanticRevision },
        after: { label: 'Updated connection', semanticRevision: expect.any(String) },
        collisionPolicy: 'reject-new',
        filename: mermaidBpmnFilename
      });
      const updated = await call('update_element', {
        elementId: firstElement.id,
        name: 'Updated Alpha'
      });
      expect(updated.structuredContent).toMatchObject({
        elementId: firstElement.id,
        filename: mermaidBpmnFilename
      });
      const geometryPreview = await call('update_element_geometry', {
        elementId: firstElement.id,
        bounds: details.structuredContent.bounds,
        expectedBounds: details.structuredContent.bounds,
        expectedRevision: updated.structuredContent.afterRevision,
        dryRun: true
      });
      expect(geometryPreview.structuredContent).toMatchObject({
        elementId: firstElement.id,
        before: { shapeId: expect.any(String), bounds: details.structuredContent.bounds },
        after: { shapeId: expect.any(String), bounds: details.structuredContent.bounds },
        diagnostics: expect.any(Array),
        dryRun: true,
        applied: false,
        filename: mermaidBpmnFilename,
        beforeRevision: updated.structuredContent.afterRevision,
        afterRevision: updated.structuredContent.afterRevision
      });
      const patchPreview = await call('apply_geometry_patch', {
        expectedRevision: updated.structuredContent.afterRevision,
        elementUpdates: [{
          elementId: firstElement.id,
          bounds: details.structuredContent.bounds
        }],
        connectionUpdates: [{
          connectionId: connectionDetails.structuredContent.id,
          waypoints: connectionDetails.structuredContent.waypoints
        }],
        dryRun: true
      });
      expect(patchPreview.structuredContent).toMatchObject({
        elements: [{
          elementId: firstElement.id,
          before: { bounds: details.structuredContent.bounds },
          after: { bounds: details.structuredContent.bounds }
        }],
        connections: [{
          connectionId: connectionDetails.structuredContent.id,
          before: { waypoints: connectionDetails.structuredContent.waypoints },
          after: { waypoints: connectionDetails.structuredContent.waypoints },
          endpointPolicy: 'exact'
        }],
        diagnostics: expect.any(Array),
        introducedDiagnostics: [],
        summary: expect.objectContaining({ total: expect.any(Number) }),
        collisionPolicy: 'reject-new',
        dryRun: true,
        applied: false,
        beforeRevision: updated.structuredContent.afterRevision,
        afterRevision: updated.structuredContent.afterRevision
      });
      const routePreview = await call('route_connection', {
        connectionId: connectionDetails.structuredContent.id
      });
      expect(routePreview.structuredContent).toMatchObject({
        connectionId: connectionDetails.structuredContent.id,
        proposedWaypoints: expect.any(Array),
        scoreBreakdown: expect.objectContaining({ total: expect.any(Number) }),
        introducedDiagnostics: [],
        geometryPatch: expect.objectContaining({
          expectedRevision: updated.structuredContent.afterRevision,
          collisionPolicy: 'reject-new',
          dryRun: false
        }),
        apply: false,
        applied: false,
        beforeRevision: updated.structuredContent.afterRevision,
        afterRevision: updated.structuredContent.afterRevision
      });
      const layout = await call('auto_layout');
      expect(layout.structuredContent).toMatchObject({
        algorithm: 'horizontal',
        elementCount: 2,
        connectionCount: 1,
        warnings: expect.any(Array),
        filename: mermaidBpmnFilename
      });
      const geometry = await call('analyze_geometry', {
        elementIds: [firstElement.id],
        clearance: 8,
        tolerance: 0.5,
        requireOrthogonal: true
      });
      expect(geometry.structuredContent).toMatchObject({
        valid: expect.any(Boolean),
        diagnostics: expect.any(Array),
        summary: {
          total: expect.any(Number),
          errors: expect.any(Number),
          warnings: expect.any(Number),
          byCode: expect.any(Object)
        },
        scope: {
          elementIds: [firstElement.id],
          connectionIds: [],
          clearance: 8,
          tolerance: 0.5,
          requireOrthogonal: true
        },
        geometry: expect.objectContaining({ shapes: expect.any(Array) }),
        filename: mermaidBpmnFilename,
        revision: expect.any(String)
      });
      expect(geometry.structuredContent.summary.total)
        .toBe(geometry.structuredContent.diagnostics.length);

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
      expect(unassociatedAnnotation.structuredContent).toMatchObject({
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
      expect(deletedConnection.structuredContent).toMatchObject({
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
      const savedSvg = await call('save_svg', { filename: 'structured-output.svg' });
      expect(savedSvg.structuredContent).toMatchObject({
        processId: mermaidCreation.structuredContent.processId,
        filename: 'structured-output.svg',
        format: 'svg',
        mimeType: 'image/svg+xml',
        byteLength: expect.any(Number)
      });
      const savedPng = await call('save_png', { filename: 'structured-output.png' });
      expect(savedPng.structuredContent).toMatchObject({
        processId: mermaidCreation.structuredContent.processId,
        filename: 'structured-output.png',
        format: 'png',
        mimeType: 'image/png',
        byteLength: expect.any(Number)
      });
      expect((await readFile(path.join(diagramsDirectory, 'structured-output.svg'), 'utf8')))
        .toContain('<svg');
      expect((await readFile(path.join(diagramsDirectory, 'structured-output.png')))
        .subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

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
      expect(deleted.structuredContent).toMatchObject({
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
      const importedConnection = await call('get_connection', {
        connectionId: 'Flow_Approved'
      });
      expect(importedConnection.structuredContent).toMatchObject({
        id: 'Flow_Approved',
        type: 'bpmn:SequenceFlow',
        ownerId: 'Process_RoundTrip',
        scopeId: 'Process_RoundTrip',
        sourceId: 'Gateway_Decision',
        targetId: 'SubProcess_Preserved',
        label: 'approved',
        condition: {
          body: '${approved = true}',
          type: 'bpmn:FormalExpression',
          evaluatesToTypeRef: 'ItemDefinition_Request'
        },
        isDefault: false,
        edgeId: 'Flow_Approved_CustomDI',
        waypoints: [{ x: 430, y: 208 }, { x: 490, y: 208 }],
        labelBounds: { x: 444, y: 186, width: 62, height: 14 },
        geometryRevision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        revision: expect.any(String)
      });
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
      expect(blackBoxPool.structuredContent).toMatchObject({
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

      const selectedWorkspace = await call('select_workspace', { path: 'selected' });
      expect(selectedWorkspace.structuredContent).toMatchObject({
        workspace: path.join(diagramsDirectory, 'selected'),
        source: 'selection',
        changed: true
      });

      expect([...calledTools].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    } finally {
      await stopServer(launch.process);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });

  it('isolates repository workspaces across two stdio sessions from one executable', async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-multi-repository-e2e-'))
    );
    const firstRepository = path.join(temporaryRoot, 'first-repository');
    const secondRepository = path.join(temporaryRoot, 'second-repository');
    const outside = path.join(temporaryRoot, 'outside');
    await Promise.all([
      mkdir(firstRepository),
      mkdir(secondRepository),
      mkdir(outside)
    ]);
    await writeFile(
      path.join(secondRepository, '.mcp-bpmn.json'),
      JSON.stringify({ path: 'wiki/processes/assets' }),
      'utf8'
    );
    await symlink(outside, path.join(firstRepository, 'linked'));

    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const environment = { ...process.env };
    delete environment.MCP_BPMN_DIAGRAMS_PATH;
    const first = launchServer(
      process.execPath,
      [serverPath],
      environment,
      STARTUP_TIMEOUT_MS,
      firstRepository
    );
    const second = launchServer(
      process.execPath,
      [serverPath],
      environment,
      STARTUP_TIMEOUT_MS,
      secondRepository
    );

    try {
      await Promise.all([first.ready, second.ready]);
      expect(first.process.pid).not.toBe(second.process.pid);
      await Promise.all([
        initializeServer(first, 'mcp-bpmn-first-repository'),
        initializeServer(second, 'mcp-bpmn-second-repository')
      ]);

      const firstWorkspace = (await callTool(first, 2, 'get_workspace', {}))
        .structuredContent;
      const secondWorkspace = (await callTool(second, 2, 'get_workspace', {}))
        .structuredContent;
      expect(firstWorkspace).toMatchObject({
        launchCwd: firstRepository,
        startupBoundary: firstRepository,
        workspace: firstRepository,
        source: 'launch_cwd'
      });
      expect(secondWorkspace).toMatchObject({
        launchCwd: secondRepository,
        startupBoundary: secondRepository,
        workspace: path.join(secondRepository, 'wiki', 'processes', 'assets'),
        source: 'repository_config'
      });

      await Promise.all([
        callTool(first, 3, 'new_bpmn', { name: 'First repository' }),
        callTool(second, 3, 'new_bpmn', { name: 'Second repository' })
      ]);
      expect((await readdir(firstRepository)).filter(name => name.endsWith('.bpmn')))
        .toHaveLength(1);
      expect((await readdir(path.join(secondRepository, 'wiki', 'processes', 'assets')))
        .filter(name => name.endsWith('.bpmn'))).toHaveLength(1);

      const dotEscape = expectProtocolSuccess(await sendRequest(first, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'select_workspace', arguments: { path: '../outside' } }
      }), 4);
      expect(dotEscape).toMatchObject({ isError: true });
      const symlinkEscape = expectProtocolSuccess(await sendRequest(first, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'select_workspace', arguments: { path: 'linked/escape' } }
      }), 5);
      expect(symlinkEscape).toMatchObject({ isError: true });
      await expect(readdir(outside)).resolves.toEqual([]);
    } finally {
      await Promise.allSettled([stopServer(first.process), stopServer(second.process)]);
      await rm(temporaryRoot, { recursive: true, force: true });
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

describe('cross-process optimistic persistence', () => {
  it('rejects a stale MCP server and succeeds after reopening the winning file', async () => {
    const diagramsDirectory = await mkdtemp(path.join(tmpdir(), 'mcp-bpmn-revision-e2e-'));
    const serverPath = path.resolve(process.cwd(), 'dist/server/index.js');
    const first = launchServer(process.execPath, [serverPath], {
      ...process.env,
      HOME: path.join(diagramsDirectory, 'first-home'),
      USERPROFILE: path.join(diagramsDirectory, 'first-home'),
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory
    });
    const second = launchServer(process.execPath, [serverPath], {
      ...process.env,
      HOME: path.join(diagramsDirectory, 'second-home'),
      USERPROFILE: path.join(diagramsDirectory, 'second-home'),
      MCP_BPMN_DIAGRAMS_PATH: diagramsDirectory
    });

    try {
      await Promise.all([first.ready, second.ready]);
      await Promise.all([
        initializeServer(first, 'mcp-bpmn-revision-first'),
        initializeServer(second, 'mcp-bpmn-revision-second')
      ]);
      const created = await callTool(first, 2, 'new_bpmn', { name: 'Shared revision' });
      const filename = created.structuredContent.filename as string;
      await callTool(first, 3, 'close', {});
      const firstOpened = await callTool(first, 4, 'open_bpmn', { filename });
      const firstRevision = firstOpened.structuredContent.revision as string;
      const opened = await callTool(second, 2, 'open_bpmn', { filename });
      expect(opened.structuredContent.revision).toBe(firstRevision);

      const winner = await callTool(first, 5, 'add_activity', {
        activityType: 'task',
        name: 'First writer',
        expectedRevision: firstRevision
      });
      const winnerBytes = await readFile(path.join(diagramsDirectory, filename), 'utf8');

      const staleResponse = expectProtocolSuccess(await sendRequest(second, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'add_activity',
          arguments: {
            activityType: 'task',
            name: 'Stale writer',
            expectedRevision: opened.structuredContent.revision
          }
        }
      }), 3);
      expect(staleResponse).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'revision_conflict',
          conflict: true,
          reason: 'external_change',
          expectedRevision: opened.structuredContent.revision,
          actualRevision: expect.any(String)
        }
      });
      await expect(readFile(path.join(diagramsDirectory, filename), 'utf8'))
        .resolves.toBe(winnerBytes);
      expect(textContent(await callTool(second, 4, 'export', { format: 'xml' })))
        .not.toContain('Stale writer');

      const refreshed = await callTool(second, 5, 'open_bpmn', { filename });
      const recovered = await callTool(second, 6, 'add_activity', {
        activityType: 'task',
        name: 'After reopen',
        expectedRevision: refreshed.structuredContent.revision
      });
      expect(recovered.structuredContent.beforeRevision)
        .toBe(refreshed.structuredContent.revision);
      expect(recovered.structuredContent.afterRevision)
        .not.toBe(winner.structuredContent.afterRevision);
      const finalBytes = await readFile(path.join(diagramsDirectory, filename), 'utf8');
      expect(finalBytes).toContain('First writer');
      expect(finalBytes).toContain('After reopen');
      expect(finalBytes).not.toContain('Stale writer');
    } finally {
      await Promise.allSettled([stopServer(first.process), stopServer(second.process)]);
      await rm(diagramsDirectory, { recursive: true, force: true });
    }
  });
});
