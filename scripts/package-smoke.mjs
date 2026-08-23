import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const projectRoot = process.cwd();
const packageMetadata = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
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

execFileSync('npm', ['run', 'clean'], { cwd: projectRoot, stdio: 'pipe' });

const dryRun = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
)[0];
const packedFiles = new Set(dryRun.files.map(({ path }) => normalize(path)));

const packedKilobytes = Math.round(dryRun.size / 1000);
if (!readme.includes(`approximately \`${packedKilobytes} kB\` compressed`)
  || !readme.includes(`\`${dryRun.unpackedSize}\` unpacked bytes`)) {
  throw new Error(
    `README package measurement is stale; expected approximately ${packedKilobytes} kB compressed and ${dryRun.unpackedSize} unpacked bytes`
  );
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

if (!packedFiles.has('THIRD_PARTY_NOTICES.md')) {
  throw new Error('Published package is missing THIRD_PARTY_NOTICES.md');
}

if (!packedFiles.has('LICENSE')) {
  throw new Error('Published package is missing the project MIT LICENSE');
}

for (const entrypoint of declaredEntrypoints) {
  if (!packedFiles.has(entrypoint)) {
    throw new Error(`Declared package entrypoint is not published: ${entrypoint}`);
  }
}

const unnecessaryRoots = ['.beads/', 'scripts/', 'src/', 'tests/'];
for (const packedFile of packedFiles) {
  if (unnecessaryRoots.some((root) => packedFile.startsWith(root))) {
    throw new Error(`Unnecessary development file is published: ${packedFile}`);
  }
}

function initialize(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let initializeResult;

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
              child.stdin.write(`${JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {}
              })}\n`);
            }
          } else if (response.id === 2) {
            if (response.error) {
              finish(new Error(`tools/list failed: ${JSON.stringify(response.error)}`));
            } else {
              finish(undefined, {
                initializeResult,
                tools: response.result?.tools
              });
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
    }, 15_000);

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

const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-package-'));

try {
  execFileSync('npm', ['run', 'build:bundle'], {
    cwd: projectRoot,
    stdio: 'pipe'
  });

  const sourceTreeResult = await initialize(
    'npm',
    ['start', '--silent'],
    projectRoot
  );
  const bundledResult = await initialize(
    'npm',
    ['run', 'start:bundle', '--silent'],
    projectRoot
  );

  const packResult = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temporaryRoot], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
  )[0];
  const tarballPath = join(temporaryRoot, packResult.filename);
  const installRoot = join(temporaryRoot, 'install');
  mkdirSync(installRoot);
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installRoot,
      tarballPath,
    ],
    { cwd: projectRoot, stdio: 'pipe' }
  );

  const installedPackageRoot = join(
    installRoot,
    'node_modules',
    packageMetadata.name
  );
  const installedPackageMetadata = JSON.parse(
    readFileSync(join(installedPackageRoot, 'package.json'), 'utf8')
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

  for (const [field, expected] of Object.entries(expectedProvenance)) {
    if (JSON.stringify(installedPackageMetadata[field]) !== JSON.stringify(expected)) {
      throw new Error(`Installed package has incorrect ${field} provenance metadata`);
    }
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

  const rendererModuleUrl = pathToFileURL(
    join(installedPackageRoot, 'dist', 'core', 'BpmnSvgRenderer.js')
  ).href;
  const { BpmnSvgRenderer } = await import(rendererModuleUrl);
  const fixture = readFileSync(
    join(projectRoot, 'tests', 'fixtures', 'simple-process.bpmn'),
    'utf8'
  );
  const packagedSvg = await new BpmnSvgRenderer().render(fixture);
  const packagedLinks = [...packagedSvg.matchAll(/\shref="([^"]+)"/gi)]
    .map((match) => match[1]);
  const viewBox = packagedSvg.match(/\bviewBox="([^"]+)"/)?.[1]
    .trim()
    .split(/[ ,]+/)
    .map(Number);
  const attributionBounds = packagedSvg.match(
    /<a id="bpmn-io-attribution"[^>]*><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" fill="#fff"\/>/
  )?.slice(1).map(Number);
  const attributionIsContained = viewBox?.length === 4
    && attributionBounds?.length === 4
    && attributionBounds[0] >= viewBox[0]
    && attributionBounds[1] >= viewBox[1]
    && attributionBounds[0] + attributionBounds[2] <= viewBox[0] + viewBox[2]
    && attributionBounds[1] + attributionBounds[3] <= viewBox[1] + viewBox[3];

  if (!packagedSvg.includes('id="bpmn-io-attribution"')
    || !packagedSvg.includes('aria-label="Powered by bpmn.io"')
    || !packagedSvg.includes('viewBox="0 0 14.02 5.57" width="53" height="21"')
    || JSON.stringify(packagedLinks) !== JSON.stringify(['https://bpmn.io'])
    || !attributionIsContained
    || !/<a id="bpmn-io-attribution"[\s\S]*<\/a><\/svg>$/.test(packagedSvg)) {
    throw new Error('Packed SVG renderer did not preserve the safe bpmn.io attribution');
  }

  const installedBin = join(
    installRoot,
    'node_modules',
    '.bin',
    'mcp-bpmn-server'
  );
  const packagedResult = await initialize(installedBin, [], installRoot);

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
