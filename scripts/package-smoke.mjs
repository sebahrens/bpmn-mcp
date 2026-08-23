import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const projectRoot = process.cwd();
const suppliedTarballSource = process.env.MCP_BPMN_PACKAGE_TARBALL
  ? realpathSync(resolve(projectRoot, process.env.MCP_BPMN_PACKAGE_TARBALL))
  : undefined;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-package-'));
const suppliedTarball = suppliedTarballSource
  ? join(temporaryRoot, 'release-candidate.tgz')
  : undefined;
if (suppliedTarballSource && suppliedTarball) {
  copyFileSync(suppliedTarballSource, suppliedTarball);
  const expectedDigest = process.env.MCP_BPMN_PACKAGE_SHA256?.toLowerCase();
  const actualDigest = createHash('sha256')
    .update(readFileSync(suppliedTarball))
    .digest('hex');
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)
    || actualDigest !== expectedDigest) {
    throw new Error('Supplied release tarball does not match MCP_BPMN_PACKAGE_SHA256');
  }
}
const npmEnvironment = {
  ...process.env,
  npm_config_cache: join(temporaryRoot, 'npm-cache')
};
process.once('exit', () => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});
const packageMetadata = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
);
const mcpMetadata = JSON.parse(
  readFileSync(join(projectRoot, 'mcp.json'), 'utf8')
);
const claudePluginMetadata = JSON.parse(
  readFileSync(join(projectRoot, '.claude-plugin', 'plugin.json'), 'utf8')
);
const shrinkwrapMetadata = JSON.parse(
  readFileSync(join(projectRoot, 'npm-shrinkwrap.json'), 'utf8')
);
const readme = readFileSync(join(projectRoot, 'README.md'), 'utf8');
const license = readFileSync(join(projectRoot, 'LICENSE'), 'utf8');

const expectedProvenance = {
  author: {
    name: 'Alice V.',
    email: 'ooisee@gmail.com',
    url: 'https://github.com/oisee'
  },
  maintainers: [
    {
      name: 'Alice V.',
      email: 'ooisee@gmail.com',
      url: 'https://github.com/oisee'
    }
  ],
  repository: {
    type: 'git',
    url: 'git+https://github.com/oisee/mcp-bpmn.git'
  },
  homepage: 'https://github.com/oisee/mcp-bpmn#readme',
  bugs: {
    url: 'https://github.com/oisee/mcp-bpmn/issues'
  },
  license: 'MIT'
};

for (const [field, expected] of Object.entries(expectedProvenance)) {
  if (JSON.stringify(packageMetadata[field]) !== JSON.stringify(expected)) {
    throw new Error(`package.json has incorrect ${field} provenance metadata`);
  }
}

const forbiddenReadmeClaims = [
  'github.com/your-org/mcp-bpmn',
  'Complete BPMN 2.0 Support',
  'Enterprise-Ready',
  'No Browser Dependencies',
  '~48KB CommonJS bundle',
  'SVG export not yet implemented'
];
for (const claim of forbiddenReadmeClaims) {
  if (readme.includes(claim)) {
    throw new Error(`README retains an unsupported release claim: ${claim}`);
  }
}

const repositoryUrls = [...readme.matchAll(
  /https:\/\/github\.com\/([^/\s)]+)\/mcp-bpmn(?:\.git)?(?=[\s/)])/g
)];
if (repositoryUrls.length === 0
  || repositoryUrls.some(([, owner]) => owner !== 'oisee')) {
  throw new Error('README repository links must target github.com/oisee/mcp-bpmn');
}

for (const requiredText of [
  'npm ci',
  'npm run build',
  'npm start',
  'dist/server/index.js',
  'npm run build:bundle',
  'npm run start:bundle',
  'PUPPETEER_EXECUTABLE_PATH',
  'npm pack --dry-run --json'
]) {
  if (!readme.includes(requiredText)) {
    throw new Error(`README is missing verified setup or dependency guidance: ${requiredText}`);
  }
}

function collectEntrypoints(value) {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  return Object.values(value).flatMap(collectEntrypoints);
}

function packagePath(entrypoint) {
  return normalize(entrypoint).replace(/^\.([/\\])/, '');
}

const declaredEntrypoints = new Set([
  ...collectEntrypoints(packageMetadata.main),
  ...collectEntrypoints(packageMetadata.exports),
  ...collectEntrypoints(packageMetadata.bin),
].map(packagePath));

if (packageMetadata.main !== undefined || packageMetadata.exports !== undefined) {
  throw new Error('The CLI-only package must not declare importable library entrypoints');
}

execFileSync('npm', ['run', 'clean'], {
  cwd: projectRoot,
  env: npmEnvironment,
  stdio: 'pipe'
});

const dryRun = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: npmEnvironment,
  })
)[0];
const packedFiles = new Set(dryRun.files.map(({ path }) => normalize(path)));

const expectedPackageIncludes = [
  'dist',
  'bin',
  'mcp.json',
  'skills',
  'evals',
  '.codex-plugin',
  '.claude-plugin',
  '.mcp.json',
  'npm-shrinkwrap.json',
  'THIRD_PARTY_NOTICES.md'
];
for (const includedPath of expectedPackageIncludes) {
  if (!packageMetadata.files?.includes(includedPath)) {
    throw new Error(`package.json files is missing release path: ${includedPath}`);
  }
}

const requiredPackagedFiles = [
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'npm-shrinkwrap.json',
  'mcp.json',
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'bin/mcp-bpmn-plugin-server',
  'skills/bpmn-modeler/SKILL.md',
  'skills/bpmn-modeler/agents/openai.yaml',
  'evals/bpmn-modeler/cases.json',
  'dist/server/index.js'
];
for (const requiredFile of requiredPackagedFiles) {
  if (!packedFiles.has(requiredFile)) {
    throw new Error(`Published package is missing required file: ${requiredFile}`);
  }
}

function collectFiles(directory, relativeDirectory = directory) {
  if (!existsSync(join(projectRoot, directory))) return [];

  return readdirSync(join(projectRoot, directory), { withFileTypes: true })
    .flatMap(entry => {
      const relativePath = join(relativeDirectory, entry.name);
      return entry.isDirectory()
        ? collectFiles(join(directory, entry.name), relativePath)
        : [normalize(relativePath)];
    });
}

for (const distributionDirectory of ['skills', 'evals', '.codex-plugin', '.claude-plugin']) {
  for (const sourceFile of collectFiles(distributionDirectory)) {
    if (!packedFiles.has(sourceFile)) {
      throw new Error(`Release file is present in the repository but not packaged: ${sourceFile}`);
    }
  }
}

for (const manifestPath of [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json'
]) {
  if (!existsSync(join(projectRoot, manifestPath))) continue;
  const manifest = JSON.parse(readFileSync(join(projectRoot, manifestPath), 'utf8'));
  if (manifest.version !== packageMetadata.version) {
    throw new Error(
      `${manifestPath} version ${String(manifest.version)} differs from package version ${packageMetadata.version}`
    );
  }
}

const packagedMcpServer = mcpMetadata.mcpServers?.['mcp-bpmn'];
if (packagedMcpServer?.command !== 'mcp-bpmn-server'
  || JSON.stringify(packagedMcpServer.args) !== '[]') {
  throw new Error('mcp.json must launch the stable installed mcp-bpmn-server executable');
}

const claudeMcpServer = claudePluginMetadata.mcpServers?.['mcp-bpmn'];
if (Object.keys(claudePluginMetadata.mcpServers ?? {}).length !== 1
  || claudeMcpServer?.command !== 'node'
  || JSON.stringify(claudeMcpServer.args)
    !== JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/dist/server/index.js'])
  || claudeMcpServer.env !== undefined) {
  throw new Error('Claude plugin must define one cache-relative MCP server and no cache-local state');
}
if (claudePluginMetadata.skills !== undefined
  || claudePluginMetadata.commands !== undefined
  || existsSync(join(projectRoot, 'commands'))) {
  throw new Error('Claude plugin must use automatic skills/ discovery without legacy commands');
}
if (JSON.stringify(shrinkwrapMetadata.packages?.['']?.dependencies)
  !== JSON.stringify(packageMetadata.dependencies)) {
  throw new Error('npm-shrinkwrap.json root dependencies differ from package.json');
}

const builtToolsUrl = pathToFileURL(join(projectRoot, 'dist', 'server', 'tools.js')).href;
const { toolNames, tools: builtTools } = await import(builtToolsUrl);
const documentedToolNames = [...readme.matchAll(/^#### `([^`]+)`$/gm)]
  .map(([, name]) => name);
if (JSON.stringify(documentedToolNames) !== JSON.stringify(toolNames)) {
  throw new Error(
    `README tool inventory differs from tools/list: documented=${documentedToolNames.join(',')} advertised=${toolNames.join(',')}`
  );
}

for (const entrypoint of declaredEntrypoints) {
  if (!existsSync(join(projectRoot, entrypoint))) {
    throw new Error(`Declared package entrypoint is missing after prepack: ${entrypoint}`);
  }
}

for (const entrypoint of declaredEntrypoints) {
  if (!packedFiles.has(entrypoint)) {
    throw new Error(`Declared package entrypoint is not published: ${entrypoint}`);
  }
}

const allowedPackagedFiles = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'npm-shrinkwrap.json',
  'mcp.json',
  '.mcp.json'
]);
const allowedPackagedRoots = [
  'dist/',
  'bin/',
  'skills/',
  'evals/',
  '.codex-plugin/',
  '.claude-plugin/'
];
for (const packedFile of packedFiles) {
  if (!allowedPackagedFiles.has(packedFile)
    && !allowedPackagedRoots.some(root => packedFile.startsWith(root))) {
    throw new Error(`Unexpected repository file is published: ${packedFile}`);
  }
  if (/(^|[/\\])(\.env(?:\.|$)|credentials?(?:\.|$)|id_rsa(?:\.|$))|\.(?:key|pem|p12)$/i
    .test(packedFile)) {
    throw new Error(`Potential secret file is published: ${packedFile}`);
  }
}

function runMcpSession(
  command,
  args,
  cwd,
  requests = [{ method: 'tools/list', params: {} }],
  environment = process.env
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let initializeResult;
    const results = [];
    let nextRequestIndex = 0;

    const stop = () => {
      if (child.exitCode !== null) {
        return;
      }

      if (process.platform === 'win32') {
        child.kill();
      } else {
        process.kill(-child.pid, 'SIGTERM');
      }
    };

    const finish = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stop();

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const response = JSON.parse(line);
          if (response.id === 1) {
            if (response.error) {
              finish(new Error(`Initialize failed: ${JSON.stringify(response.error)}`));
            } else {
              initializeResult = response.result;
              child.stdin.write(`${JSON.stringify({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
              })}\n`);
              sendNextRequest();
            }
          } else if (Number.isSafeInteger(response.id) && response.id >= 2) {
            if (response.error) {
              finish(new Error(`MCP request failed: ${JSON.stringify(response.error)}`));
            } else {
              results[response.id - 2] = response.result;
              if (nextRequestIndex < requests.length) {
                sendNextRequest();
              } else {
                finish(undefined, {
                  initializeResult,
                  results,
                  tools: results[0]?.tools
                });
              }
            }
          }
        } catch {
          // npm may write lifecycle output before the JSON-RPC response.
        }
      }
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (!settled) {
        finish(
          new Error(
            `Server exited before initialize (code=${code}, signal=${signal}): ${stderr}`
          )
        );
      }
    });

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for initialize response: ${stderr}`));
    }, 30_000);

    function sendNextRequest() {
      const request = requests[nextRequestIndex];
      const id = nextRequestIndex + 2;
      nextRequestIndex += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...request })}\n`);
    }

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'package-smoke-test',
          version: '1.0.0',
        },
      },
    })}\n`);
  });
}

try {
  execFileSync('npm', ['run', 'build:bundle'], {
    cwd: projectRoot,
    env: npmEnvironment,
    stdio: 'pipe'
  });

  const sourceTreeResult = await runMcpSession(
    'npm',
    ['start', '--silent'],
    projectRoot,
    undefined,
    npmEnvironment
  );
  const bundledResult = await runMcpSession(
    'npm',
    ['run', 'start:bundle', '--silent'],
    projectRoot,
    undefined,
    npmEnvironment
  );

  let tarballPath;
  let packedVersion;
  let actualPackedFiles;
  if (suppliedTarball) {
    tarballPath = suppliedTarball;
    const tarEntries = execFileSync('tar', ['-tzf', tarballPath], {
      cwd: projectRoot,
      encoding: 'utf8'
    }).trim().split('\n');
    actualPackedFiles = new Set(tarEntries
      .filter(entry => entry.startsWith('package/') && !entry.endsWith('/'))
      .map(entry => normalize(entry.slice('package/'.length))));
    const packedMetadata = JSON.parse(
      execFileSync('tar', ['-xOzf', tarballPath, 'package/package.json'], {
        cwd: projectRoot,
        encoding: 'utf8'
      })
    );
    packedVersion = packedMetadata.version;
  } else {
    const packResult = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', temporaryRoot], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: npmEnvironment,
      })
    )[0];
    tarballPath = join(temporaryRoot, packResult.filename);
    packedVersion = packResult.version;
    actualPackedFiles = new Set(
      packResult.files.map(({ path }) => normalize(path))
    );
  }
  if (JSON.stringify([...actualPackedFiles].sort())
    !== JSON.stringify([...packedFiles].sort())) {
    throw new Error('Packed tarball contents differ from npm pack --dry-run inspection');
  }
  if (packedVersion !== packageMetadata.version) {
    throw new Error(
      `Packed tarball version ${String(packedVersion)} differs from package version ${packageMetadata.version}`
    );
  }
  const installRoot = join(temporaryRoot, 'install');
  mkdirSync(installRoot);
  execFileSync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installRoot,
      tarballPath,
    ],
    {
      cwd: temporaryRoot,
      env: {
        ...npmEnvironment,
        PUPPETEER_SKIP_DOWNLOAD: 'true'
      },
      stdio: 'pipe'
    }
  );

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    packageMetadata.name
  );
  const installedPackageMetadata = JSON.parse(
    readFileSync(join(installedPackageRoot, 'package.json'), 'utf8')
  );
  const installedMcpMetadata = JSON.parse(
    readFileSync(join(installedPackageRoot, 'mcp.json'), 'utf8')
  );
  const installedLicense = readFileSync(join(installedPackageRoot, 'LICENSE'), 'utf8');
  const installedBpmnJsRoot = join(installRoot, 'node_modules', 'bpmn-js');
  const installedBpmnJsMetadata = JSON.parse(
    readFileSync(join(installedBpmnJsRoot, 'package.json'), 'utf8')
  );
  const thirdPartyNotices = readFileSync(
    join(installedPackageRoot, 'THIRD_PARTY_NOTICES.md'),
    'utf8'
  );
  const bpmnJsLicense = readFileSync(join(installedBpmnJsRoot, 'LICENSE'), 'utf8');
  const requiredWatermarkClause =
    'The source code responsible for displaying the bpmn.io project watermark';

  if (installedPackageMetadata.version !== packageMetadata.version) {
    throw new Error(
      `Installed package version ${String(installedPackageMetadata.version)} differs from source package version ${packageMetadata.version}`
    );
  }
  for (const dependencyName of Object.keys(packageMetadata.dependencies)) {
    const dependencyPackage = join(
      installRoot,
      'node_modules',
      ...dependencyName.split('/'),
      'package.json'
    );
    if (!existsSync(dependencyPackage)) {
      throw new Error(`Production dependency is missing from the private prefix: ${dependencyName}`);
    }
  }

  for (const [field, expected] of Object.entries(expectedProvenance)) {
    if (JSON.stringify(installedPackageMetadata[field]) !== JSON.stringify(expected)) {
      throw new Error(`Installed package has incorrect ${field} provenance metadata`);
    }
  }
  if (JSON.stringify(installedMcpMetadata) !== JSON.stringify(mcpMetadata)) {
    throw new Error('Installed mcp.json differs from the inspected package adapter metadata');
  }
  if (!installedLicense.includes('MIT License')
    || !installedLicense.includes('Copyright (c) 2025 Alice V.')
    || !installedLicense.includes('Permission is hereby granted, free of charge')) {
    throw new Error('Installed package is missing the intended MIT permission notice');
  }
  if (installedLicense !== license) {
    throw new Error('Installed package LICENSE differs from the repository LICENSE');
  }

  if (packageMetadata.dependencies['bpmn-js'] !== '17.11.1'
    || installedBpmnJsMetadata.version !== '17.11.1') {
    throw new Error('Package compliance baseline requires bpmn-js 17.11.1');
  }
  if (!thirdPartyNotices.includes('bpmn-js 17.11.1')
    || !thirdPartyNotices.includes(requiredWatermarkClause)
    || !bpmnJsLicense.includes(requiredWatermarkClause)) {
    throw new Error('Published bpmn-js license notice is missing or changed');
  }

  const installedBin = join(
    installRoot,
    'node_modules',
    '.bin',
    'mcp-bpmn-server'
  );
  const installedBinTarget = realpathSync(installedBin);
  if (!installedBinTarget.startsWith(`${realpathSync(installedPackageRoot)}/`)) {
    throw new Error(`Installed executable resolves outside its private package: ${installedBinTarget}`);
  }
  const packagedResult = await runMcpSession(
    installedBin,
    [],
    installRoot,
    [
      { method: 'tools/list', params: {} },
      {
        method: 'tools/call',
        params: {
          name: 'new_bpmn',
          arguments: { name: 'Packaged XML smoke' }
        }
      },
      {
        method: 'tools/call',
        params: {
          name: 'export',
          arguments: { format: 'xml' }
        }
      },
      {
        method: 'tools/call',
        params: {
          name: 'export',
          arguments: { format: 'svg' }
        }
      }
    ],
    {
      ...process.env,
      MCP_BPMN_DIAGRAMS_PATH: join(temporaryRoot, 'diagrams'),
      NODE_PATH: '',
      PUPPETEER_CACHE_DIR: join(temporaryRoot, 'empty-puppeteer-cache'),
      PUPPETEER_EXECUTABLE_PATH: join(temporaryRoot, 'missing-chrome')
    }
  );

  const createResult = packagedResult.results[1];
  const xmlResult = packagedResult.results[2];
  const svgResult = packagedResult.results[3];
  if (createResult?.isError
    || xmlResult?.isError
    || !xmlResult?.content?.some(item => (
      item.type === 'text' && item.text.includes('<bpmn:definitions')
    ))) {
    throw new Error('Packaged executable could not create and export BPMN XML without Chrome');
  }
  const svgDiagnostic = svgResult?.content?.find(item => item.type === 'text')?.text ?? '';
  if (!svgResult?.isError
    || !svgDiagnostic.includes('SVG export requires Chrome or Chromium')
    || !svgDiagnostic.includes('PUPPETEER_EXECUTABLE_PATH')) {
    throw new Error(`Packaged SVG prerequisite diagnostic was not actionable: ${svgDiagnostic}`);
  }

  if (sourceTreeResult.initializeResult.serverInfo.version !== packageMetadata.version) {
    throw new Error(
      `npm start reports ${sourceTreeResult.initializeResult.serverInfo.version}; expected ${packageMetadata.version}`
    );
  }

  if (bundledResult.initializeResult.serverInfo.version !== packageMetadata.version) {
    throw new Error(
      `Optional CommonJS bundle reports ${bundledResult.initializeResult.serverInfo.version}; expected ${packageMetadata.version}`
    );
  }

  if (packagedResult.initializeResult.serverInfo.version !== packageMetadata.version) {
    throw new Error(
      `Packaged server reports ${packagedResult.initializeResult.serverInfo.version}; expected ${packageMetadata.version}`
    );
  }

  if (JSON.stringify(packagedResult.initializeResult.serverInfo)
    !== JSON.stringify(sourceTreeResult.initializeResult.serverInfo)) {
    throw new Error('npm start and the packaged executable report different server metadata');
  }

  const expectedToolAnnotations = builtTools.map(({ name, annotations }) => ({
    name,
    annotations
  }));
  for (const [label, result] of [
    ['npm start', sourceTreeResult],
    ['optional CommonJS bundle', bundledResult],
    ['packaged executable', packagedResult]
  ]) {
    const advertisedToolAnnotations = result.tools?.map(({ name, annotations }) => ({
      name,
      annotations
    }));
    if (JSON.stringify(advertisedToolAnnotations) !== JSON.stringify(expectedToolAnnotations)) {
      throw new Error(`${label} tools/list returned incorrect behavior annotations`);
    }
  }

  console.log(
    `Package smoke test passed for ${packageMetadata.name}@${packageMetadata.version}`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
