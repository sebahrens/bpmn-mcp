import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { snapshotReleaseArtifact } from './release-artifact.mjs';

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
  PUPPETEER_SKIP_DOWNLOAD: 'true',
  npm_config_cache: join(temporaryRoot, 'npm-cache')
};
delete environment.MCP_BPMN_DIAGRAMS_PATH;

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
  const suppliedTarball = snapshotReleaseArtifact(projectRoot, temporaryRoot);
  const tarballPath = suppliedTarball ?? join(temporaryRoot, runJson('npm', [
      'pack',
      '--json',
      '--pack-destination',
      temporaryRoot
    ])[0].filename);
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
  let firstRepository = join(temporaryRoot, 'first-repository');
  let secondRepository = join(temporaryRoot, 'second-repository');
  mkdirSync(firstRepository);
  mkdirSync(secondRepository);
  firstRepository = realpathSync(firstRepository);
  secondRepository = realpathSync(secondRepository);
  writeFileSync(
    join(secondRepository, '.mcp-bpmn.json'),
    JSON.stringify({ path: 'wiki/processes/assets' })
  );
  const mcpResults = await runMcpSession(
    cachedCommand,
    cachedServer.args,
    firstRepository,
    [
      { method: 'tools/list', params: {} },
      {
        method: 'tools/call',
        params: { name: 'get_workspace', arguments: {} }
      },
      {
        method: 'tools/call',
        params: {
          name: 'new_bpmn',
          arguments: { name: 'Codex plugin lifecycle safety' }
        }
      }
    ]
  );
  const secondMcpResults = await runMcpSession(
    cachedCommand,
    cachedServer.args,
    secondRepository,
    [
      {
        method: 'tools/call',
        params: { name: 'get_workspace', arguments: {} }
      },
      {
        method: 'tools/call',
        params: {
          name: 'new_bpmn',
          arguments: { name: 'Codex second repository' }
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
    'get_diagrams_path',
    'get_workspace'
  ]);
  if (!Array.isArray(tools) || tools.length !== 29) {
    throw new Error(`Cached plugin MCP server advertised ${tools?.length ?? 0} tools, expected 29`);
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
  const secondWorkspace = join(secondRepository, 'wiki', 'processes', 'assets');
  if (mcpResults[1]?.structuredContent?.workspace !== firstRepository
    || mcpResults[1]?.structuredContent?.source !== 'launch_cwd'
    || mcpResults[2]?.isError
    || !Array.isArray(mcpResults[2]?.content)
    || readdirSync(firstRepository).filter(file => file.endsWith('.bpmn')).length !== 1
    || secondMcpResults[0]?.structuredContent?.workspace !== secondWorkspace
    || secondMcpResults[0]?.structuredContent?.source !== 'repository_config'
    || secondMcpResults[1]?.isError
    || readdirSync(secondWorkspace).filter(file => file.endsWith('.bpmn')).length !== 1) {
    throw new Error('One cached Codex MCP registration did not isolate two repository workspaces');
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
