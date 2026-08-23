import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const projectRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-codex-plugin-'));
const isolatedCodexHome = join(temporaryRoot, 'codex-home');
const marketplaceRoot = join(temporaryRoot, 'marketplace');
const marketplaceFile = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
const dataHome = join(temporaryRoot, 'data');
const installedApp = join(dataHome, 'mcp-bpmn', 'app');
const marketplaceName = 'mcp-bpmn-local';
const pluginId = `mcp-bpmn@${marketplaceName}`;
const environment = {
  ...process.env,
  CODEX_HOME: isolatedCodexHome,
  XDG_DATA_HOME: dataHome,
  MCP_BPMN_DIAGRAMS_PATH: join(temporaryRoot, 'diagrams'),
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  npm_config_cache: join(temporaryRoot, 'npm-cache')
};

process.once('exit', () => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  });
}

function runJson(command, args, options) {
  return JSON.parse(run(command, args, options));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertContainedPath(root, rawPath, label) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('./')) {
    throw new Error(`${label} must be a ./-prefixed relative path`);
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(root, rawPath);
  if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} escapes the plugin root: ${rawPath}`);
  }
  if (!existsSync(candidate)) {
    throw new Error(`${label} points to a missing packaged path: ${rawPath}`);
  }
  return candidate;
}

function requestAppServer(method, params) {
  return new Promise((resolveRequest, rejectRequest) => {
    const child = spawn('codex', ['app-server', '--stdio'], {
      cwd: marketplaceRoot,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGTERM');
      if (error) rejectRequest(error);
      else resolveRequest(result);
    }

    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;

        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        if (response.id === 1) {
          if (response.error) {
            finish(new Error(`Codex app-server initialize failed: ${JSON.stringify(response.error)}`));
            return;
          }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method, params })}\n`);
        } else if (response.id === 2) {
          if (response.error) {
            finish(new Error(`Codex app-server ${method} failed: ${JSON.stringify(response.error)}`));
          } else {
            finish(undefined, response.result);
          }
        }
      }
    });
    child.once('error', finish);
    child.once('exit', code => {
      if (!settled) finish(new Error(`Codex app-server exited ${code}: ${stderr}`));
    });

    const timeout = setTimeout(() => {
      finish(new Error(`Codex app-server ${method} timed out: ${stderr}`));
    }, 30_000);

    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'mcp-bpmn-codex-plugin-smoke', version: '1.0.0' },
        capabilities: { experimentalApi: true }
      }
    })}\n`);
  });
}

function runMcpSession(command, args, cwd, requests) {
  return new Promise((resolveSession, rejectSession) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let nextRequest = 0;
    let pendingResponseId;
    const results = [];

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill('SIGTERM');
      if (error) rejectSession(error);
      else resolveSession(results);
    }

    function sendNext() {
      const request = requests[nextRequest];
      const id = nextRequest + 2;
      nextRequest += 1;
      pendingResponseId = id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...request })}\n`);
    }

    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;

        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        if (response.id === 1) {
          if (response.error) {
            finish(new Error(`MCP initialize failed: ${JSON.stringify(response.error)}`));
            return;
          }
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          })}\n`);
          sendNext();
        } else if (response.id === pendingResponseId) {
          pendingResponseId = undefined;
          if (response.error) {
            finish(new Error(`MCP request failed: ${JSON.stringify(response.error)}`));
          } else {
            results[response.id - 2] = response.result;
            if (nextRequest < requests.length) sendNext();
            else finish();
          }
        } else if (Number.isSafeInteger(response.id)) {
          finish(new Error(`Unexpected MCP response id: ${String(response.id)}`));
        }
      }
    });
    child.once('error', finish);
    child.once('exit', code => {
      if (!settled) finish(new Error(`Cached MCP server exited ${code}: ${stderr}`));
    });

    const timeout = setTimeout(() => {
      finish(new Error(`Cached MCP session timed out: ${stderr}`));
    }, 30_000);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'codex-plugin-smoke', version: '1.0.0' }
      }
    })}\n`);
  });
}

try {
  const packageMetadata = readJson(join(projectRoot, 'package.json'));
  const sourceManifest = readJson(join(projectRoot, '.codex-plugin', 'plugin.json'));
  const sourceMarketplace = readJson(
    join(projectRoot, '.agents', 'plugins', 'marketplace.json')
  );

  if (sourceManifest.name !== 'mcp-bpmn'
    || sourceManifest.version !== packageMetadata.version) {
    throw new Error('Codex plugin identity or version differs from package.json');
  }
  const sourceSkillsRoot = assertContainedPath(
    projectRoot,
    sourceManifest.skills,
    'plugin.json skills'
  );
  assertContainedPath(projectRoot, sourceManifest.mcpServers, 'plugin.json mcpServers');
  if (sourceMarketplace.name !== marketplaceName
    || sourceMarketplace.plugins?.length !== 1
    || sourceMarketplace.plugins[0]?.name !== sourceManifest.name
    || sourceMarketplace.plugins[0]?.source?.source !== 'local'
    || sourceMarketplace.plugins[0]?.source?.path !== './') {
    throw new Error('Repo marketplace must expose exactly the root mcp-bpmn plugin');
  }
  assertContainedPath(
    projectRoot,
    sourceMarketplace.plugins[0].source.path,
    'marketplace plugin source'
  );
  const sourceSkillPath = join(sourceSkillsRoot, 'bpmn-modeler', 'SKILL.md');
  const openAiMetadata = readFileSync(
    join(sourceSkillsRoot, 'bpmn-modeler', 'agents', 'openai.yaml'),
    'utf8'
  );
  const dependencyCommand = openAiMetadata.match(/^\s+command:\s+"([^"]+)"\s*$/m)?.[1];
  assertContainedPath(projectRoot, dependencyCommand, 'openai.yaml MCP command');

  mkdirSync(isolatedCodexHome, { recursive: true });
  mkdirSync(marketplaceRoot, { recursive: true });
  const suppliedTarballSource = process.env.MCP_BPMN_PACKAGE_TARBALL
    ? realpathSync(resolve(projectRoot, process.env.MCP_BPMN_PACKAGE_TARBALL))
    : undefined;
  const tarballPath = suppliedTarballSource
    ? join(temporaryRoot, 'release-candidate.tgz')
    : join(temporaryRoot, runJson('npm', [
      'pack',
      '--json',
      '--pack-destination',
      temporaryRoot
    ])[0].filename);
  if (suppliedTarballSource) {
    copyFileSync(suppliedTarballSource, tarballPath);
    const expectedDigest = process.env.MCP_BPMN_PACKAGE_SHA256?.toLowerCase();
    const actualDigest = createHash('sha256')
      .update(readFileSync(tarballPath))
      .digest('hex');
    if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)
      || actualDigest !== expectedDigest) {
      throw new Error('Supplied release tarball does not match MCP_BPMN_PACKAGE_SHA256');
    }
  }
  run('npm', [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--prefix',
    installedApp,
    tarballPath
  ], {
    cwd: temporaryRoot,
    env: {
      ...environment,
      PUPPETEER_SKIP_DOWNLOAD: 'true'
    }
  });
  run('tar', [
    '-xzf',
    tarballPath,
    '--strip-components=1',
    '-C',
    marketplaceRoot
  ], { cwd: temporaryRoot });
  mkdirSync(dirname(marketplaceFile), { recursive: true });
  copyFileSync(
    join(projectRoot, '.agents', 'plugins', 'marketplace.json'),
    marketplaceFile
  );

  const addMarketplace = runJson('codex', [
    'plugin', 'marketplace', 'add', marketplaceRoot, '--json'
  ]);
  if (addMarketplace.marketplaceName !== marketplaceName) {
    throw new Error('Codex added the repo marketplace under an unexpected name');
  }

  const available = runJson('codex', ['plugin', 'list', '--available', '--json']);
  if (available.available?.length !== 1
    || available.available[0]?.pluginId !== pluginId
    || available.available[0]?.version !== packageMetadata.version) {
    throw new Error(`Codex marketplace list did not expose ${pluginId}`);
  }

  const install = runJson('codex', ['plugin', 'add', pluginId, '--json']);
  const cachedPluginRoot = install.installedPath;
  if (typeof cachedPluginRoot !== 'string'
    || resolve(cachedPluginRoot) === resolve(projectRoot)
    || !existsSync(join(cachedPluginRoot, 'dist', 'server', 'index.js'))
    || existsSync(join(cachedPluginRoot, 'src'))) {
    throw new Error('Codex did not install a self-contained release-shaped cache copy');
  }
  if (readFileSync(join(cachedPluginRoot, 'skills', 'bpmn-modeler', 'SKILL.md'), 'utf8')
    !== readFileSync(sourceSkillPath, 'utf8')) {
    throw new Error('Codex plugin cache does not contain the canonical bpmn-modeler skill');
  }

  const installed = runJson('codex', ['plugin', 'list', '--json']);
  if (installed.installed?.length !== 1
    || installed.installed[0]?.pluginId !== pluginId
    || installed.installed[0]?.enabled !== true) {
    throw new Error(`Codex plugin list did not report ${pluginId} as installed`);
  }

  const detail = await requestAppServer('plugin/read', {
    marketplacePath: marketplaceFile,
    pluginName: sourceManifest.name
  });
  if (detail?.plugin?.skills?.length !== 1
    || !detail.plugin.skills[0]?.name?.endsWith(':bpmn-modeler')
    || JSON.stringify(detail.plugin.mcpServers) !== JSON.stringify(['mcp-bpmn'])) {
    throw new Error(
      `Codex did not discover one skill and one MCP server: ${JSON.stringify(detail)}`
    );
  }

  const serverStatus = await requestAppServer('mcpServerStatus/list', {
    detail: 'full'
  });
  const discoveredServer = serverStatus?.data?.find(server => server.name === 'mcp-bpmn');
  if (serverStatus?.data?.length !== 1
    || !discoveredServer
    || discoveredServer.pluginId !== pluginId) {
    throw new Error(
      `Codex did not register exactly one installed plugin MCP server: ${JSON.stringify(serverStatus)}`
    );
  }

  const cachedMcp = readJson(join(cachedPluginRoot, '.mcp.json'));
  if ('mcpServers' in cachedMcp || Object.keys(cachedMcp).length !== 1) {
    throw new Error('Codex .mcp.json must be a direct one-server map');
  }
  const cachedServer = cachedMcp['mcp-bpmn'];
  if (cachedServer?.command !== './bin/mcp-bpmn-plugin-server'
    || JSON.stringify(cachedServer.args) !== JSON.stringify([])
    || cachedServer.default_tools_approval_mode !== 'writes'
    || cachedServer.env !== undefined) {
    throw new Error('Codex MCP config must launch the installed release with write-only prompts');
  }
  const cachedCommand = resolve(cachedPluginRoot, cachedServer.command);
  if (!cachedCommand.startsWith(`${resolve(cachedPluginRoot)}${sep}`)
    || !existsSync(cachedCommand)) {
    throw new Error('Codex MCP launcher is missing from the installed plugin cache');
  }
  const mcpResults = await runMcpSession(
    cachedCommand,
    cachedServer.args,
    cachedPluginRoot,
    [
      { method: 'tools/list', params: {} },
      {
        method: 'tools/call',
        params: {
          name: 'new_bpmn',
          arguments: { name: 'Codex plugin lifecycle safety' }
        }
      }
    ]
  );
  const tools = mcpResults[0]?.tools;
  const readOnlyTools = new Set([
    'current',
    'list_elements',
    'get_element',
    'export',
    'validate',
    'list_diagrams',
    'get_diagrams_path'
  ]);
  if (!Array.isArray(tools) || tools.length !== 27) {
    throw new Error(`Cached plugin MCP server advertised ${tools?.length ?? 0} tools, expected 27`);
  }
  for (const tool of tools) {
    const annotations = tool.annotations;
    if (typeof annotations?.readOnlyHint !== 'boolean'
      || typeof annotations.destructiveHint !== 'boolean'
      || typeof annotations.idempotentHint !== 'boolean'
      || annotations.openWorldHint !== false
      || annotations.readOnlyHint !== readOnlyTools.has(tool.name)) {
      throw new Error(`Tool ${tool.name} has approval-incompatible annotations`);
    }
  }
  const createdDiagramFiles = existsSync(environment.MCP_BPMN_DIAGRAMS_PATH)
    ? readdirSync(environment.MCP_BPMN_DIAGRAMS_PATH)
      .filter(file => file.endsWith('.bpmn'))
    : [];
  if (!mcpResults[1]
    || mcpResults[1].isError
    || !Array.isArray(mcpResults[1].content)
    || createdDiagramFiles.length !== 1) {
    throw new Error('Cached Codex plugin MCP server could not execute a BPMN workflow');
  }

  runJson('codex', ['plugin', 'remove', pluginId, '--json']);
  const afterRemove = runJson('codex', ['plugin', 'list', '--json']);
  if (afterRemove.installed?.length !== 0 || existsSync(cachedPluginRoot)) {
    throw new Error('Codex plugin remove retained installed state or cache files');
  }
  runJson('codex', [
    'plugin', 'marketplace', 'remove', marketplaceName, '--json'
  ]);
  const afterMarketplaceRemove = runJson(
    'codex', ['plugin', 'marketplace', 'list', '--json']
  );
  if (afterMarketplaceRemove.marketplaces?.length !== 0) {
    throw new Error('Codex marketplace remove retained the isolated marketplace');
  }

  console.log('Codex plugin validation and isolated marketplace lifecycle smoke passed');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
