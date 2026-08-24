import { execFileSync, spawn } from 'node:child_process';
import {
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
import { join } from 'node:path';
import { snapshotReleaseArtifact } from './release-artifact.mjs';

const projectRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-claude-plugin-'));
const npmCache = join(temporaryRoot, 'npm-cache');
const isolatedHome = join(temporaryRoot, 'home');
const claudeConfig = join(isolatedHome, '.claude');
const marketplaceRoot = join(temporaryRoot, 'marketplace');
const pluginSource = join(marketplaceRoot, 'plugin');
const marketplaceName = 'mcp-bpmn-development';
const pluginId = `mcp-bpmn@${marketplaceName}`;
const environment = {
  ...process.env,
  HOME: isolatedHome,
  CLAUDE_CONFIG_DIR: claudeConfig,
  XDG_CONFIG_HOME: join(isolatedHome, '.config'),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  npm_config_cache: npmCache,
  PUPPETEER_SKIP_DOWNLOAD: 'true'
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function findPluginCacheRoot(directory) {
  if (!existsSync(directory)) return undefined;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (existsSync(join(path, '.claude-plugin', 'plugin.json'))
        && readJson(join(path, '.claude-plugin', 'plugin.json')).name === 'mcp-bpmn') {
        return path;
      }
      const nested = findPluginCacheRoot(path);
      if (nested) return nested;
    }
  }
  return undefined;
}

function runMcpSession(command, args, cwd, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const results = [];
    let stdout = '';
    let stderr = '';
    let nextRequest = 0;
    let settled = false;

    function stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stop();
      if (error) reject(error);
      else resolve(results);
    }

    function sendNext() {
      const request = requests[nextRequest];
      const id = nextRequest + 2;
      nextRequest += 1;
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
            finish(new Error(`initialize failed: ${JSON.stringify(response.error)}`));
            return;
          }
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized'
          })}\n`);
          sendNext();
        } else if (Number.isSafeInteger(response.id) && response.id >= 2) {
          if (response.error) {
            finish(new Error(`MCP request failed: ${JSON.stringify(response.error)}`));
            return;
          }
          results[response.id - 2] = response.result;
          if (nextRequest < requests.length) sendNext();
          else finish();
        }
      }
    });
    child.once('error', finish);
    child.once('exit', code => {
      if (!settled) finish(new Error(`MCP server exited ${code}: ${stderr}`));
    });

    const timeout = setTimeout(() => {
      finish(new Error(`MCP session timed out: ${stderr}`));
    }, 30_000);

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'claude-plugin-smoke', version: '1.0.0' }
      }
    })}\n`);
  });
}

try {
  const packageMetadata = readJson(join(projectRoot, 'package.json'));
  const sourceManifest = readJson(join(projectRoot, '.claude-plugin', 'plugin.json'));

  run('claude', ['plugin', 'validate', projectRoot]);

  if (sourceManifest.name !== 'mcp-bpmn'
    || sourceManifest.version !== packageMetadata.version) {
    throw new Error('Claude plugin identity or version differs from package.json');
  }
  if (sourceManifest.skills !== undefined || sourceManifest.commands !== undefined
    || !existsSync(join(projectRoot, 'skills', 'bpmn-modeler', 'SKILL.md'))
    || existsSync(join(projectRoot, 'commands'))) {
    throw new Error('Claude plugin must discover the canonical skills/ tree without legacy commands');
  }

  const mcpServer = sourceManifest.mcpServers?.['mcp-bpmn'];
  if (mcpServer?.command !== 'node'
    || JSON.stringify(mcpServer.args)
      !== JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/dist/server/index.js'])
    || mcpServer.env !== undefined) {
    throw new Error('Claude plugin MCP config must launch cached dist and inherit external state configuration');
  }

  mkdirSync(pluginSource, { recursive: true });
  const suppliedTarball = snapshotReleaseArtifact(projectRoot, temporaryRoot);
  const tarballPath = suppliedTarball ?? join(temporaryRoot, JSON.parse(run('npm', [
      'pack',
      '--json',
      '--pack-destination',
      temporaryRoot
    ]))[0].filename);
  run('tar', [
    '-xzf',
    tarballPath,
    '--strip-components=1',
    '-C',
    pluginSource
  ], { cwd: temporaryRoot });
  run('claude', ['plugin', 'validate', '--strict', pluginSource]);

  mkdirSync(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: marketplaceName,
    owner: { name: 'mcp-bpmn maintainers' },
    plugins: [{ name: 'mcp-bpmn', source: './plugin' }]
  }, null, 2));

  run('claude', ['plugin', 'marketplace', 'add', '--scope', 'user', marketplaceRoot]);
  run('claude', ['plugin', 'install', '--scope', 'user', pluginId]);

  const details = run('claude', ['plugin', 'details', pluginId]);
  if (!details.includes('bpmn-modeler') || !details.includes('mcp-bpmn')) {
    throw new Error(`Claude did not discover the expected skill and MCP server:\n${details}`);
  }

  const cachedPluginRoot = findPluginCacheRoot(join(claudeConfig, 'plugins', 'cache'));
  if (!cachedPluginRoot || cachedPluginRoot === projectRoot
    || !existsSync(join(cachedPluginRoot, 'dist', 'server', 'index.js'))) {
    throw new Error('Claude did not install a self-contained cached plugin copy');
  }

  const cachedManifest = readJson(join(cachedPluginRoot, '.claude-plugin', 'plugin.json'));
  const cachedServer = cachedManifest.mcpServers['mcp-bpmn'];
  const cachedArgs = cachedServer.args.map(arg => (
    arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', cachedPluginRoot)
  ));
  let firstRepository = join(temporaryRoot, 'first-repository');
  let secondRepository = join(temporaryRoot, 'second-repository');
  mkdirSync(firstRepository);
  mkdirSync(secondRepository);
  firstRepository = realpathSync(firstRepository);
  secondRepository = realpathSync(secondRepository);
  const secondWorkspace = join(secondRepository, 'wiki', 'processes', 'assets');
  writeFileSync(
    join(secondRepository, '.mcp-bpmn.json'),
    JSON.stringify({ path: 'wiki/processes/assets' })
  );
  const createResults = await runMcpSession(cachedServer.command, cachedArgs, firstRepository, [
    { method: 'tools/list', params: {} },
    {
      method: 'tools/call',
      params: { name: 'get_workspace', arguments: {} }
    },
    {
      method: 'tools/call',
      params: {
        name: 'new_bpmn',
        arguments: { name: 'Plugin lifecycle safety' }
      }
    }
  ]);
  if (!createResults[0]?.tools?.some(tool => tool.name === 'new_bpmn')
    || createResults[1]?.structuredContent?.workspace !== firstRepository
    || createResults[1]?.structuredContent?.source !== 'launch_cwd'
    || createResults[2]?.isError) {
    throw new Error('Cached plugin MCP server did not advertise and execute BPMN tools');
  }

  const firstDiagramFiles = () => (
    existsSync(firstRepository)
      ? readdirSync(firstRepository).filter(file => file.endsWith('.bpmn'))
      : []
  );
  if (firstDiagramFiles().length !== 1) {
    throw new Error('Plugin MCP server did not store its diagram outside the plugin cache');
  }

  const secondResults = await runMcpSession(cachedServer.command, cachedArgs, secondRepository, [
    { method: 'tools/call', params: { name: 'get_workspace', arguments: {} } },
    {
      method: 'tools/call',
      params: { name: 'new_bpmn', arguments: { name: 'Claude second repository' } }
    }
  ]);
  const secondDiagramFiles = () => (
    existsSync(secondWorkspace)
      ? readdirSync(secondWorkspace).filter(file => file.endsWith('.bpmn'))
      : []
  );
  if (secondResults[0]?.structuredContent?.workspace !== secondWorkspace
    || secondResults[0]?.structuredContent?.source !== 'repository_config'
    || secondResults[1]?.isError
    || secondDiagramFiles().length !== 1
    || firstDiagramFiles().length !== 1) {
    throw new Error('One cached Claude MCP registration did not isolate two repository workspaces');
  }

  run('claude', ['plugin', 'disable', pluginId]);
  if (firstDiagramFiles().length !== 1 || secondDiagramFiles().length !== 1) {
    throw new Error('Disabling the plugin deleted a user diagram');
  }
  run('claude', ['plugin', 'enable', pluginId]);
  if (firstDiagramFiles().length !== 1 || secondDiagramFiles().length !== 1) {
    throw new Error('Enabling the plugin deleted a user diagram');
  }
  run('claude', ['plugin', 'uninstall', '--scope', 'user', pluginId]);
  if (firstDiagramFiles().length !== 1 || secondDiagramFiles().length !== 1) {
    throw new Error('Removing the plugin deleted a user diagram');
  }
  run('claude', ['plugin', 'marketplace', 'remove', '--scope', 'user', marketplaceName]);
  if (firstDiagramFiles().length !== 1 || secondDiagramFiles().length !== 1) {
    throw new Error('Removing the marketplace deleted a user diagram');
  }

  console.log('Claude plugin validation and isolated lifecycle smoke passed');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
