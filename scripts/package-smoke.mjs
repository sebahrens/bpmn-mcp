import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import BpmnModdle from 'bpmn-moddle';
import puppeteer from 'puppeteer';
import { snapshotReleaseArtifact } from './release-artifact.mjs';

const projectRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'mcp-bpmn-package-'));
const suppliedTarball = snapshotReleaseArtifact(projectRoot, temporaryRoot);
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

const expectedPackedToolNames = [
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
  'validate',
  'analyze_geometry',
  'auto_layout',
  'list_diagrams',
  'delete_diagram_file',
  'get_diagrams_path',
  'get_workspace',
  'select_workspace'
];

// Static fingerprints keep the packed agent-only workflow tied to the reviewed
// request and response contracts it actually uses. The full source e2e suite
// independently pins every advertised schema.
const expectedPackedWorkflowSchemaFingerprints = {
  open_bpmn: [
    '7587abc15d187397b8d68fe03f16befb84d338d6c996c9698ed095c172575e33',
    'c950412b9362a324d5aadb4de15e88e55d403dbabd80ca822e18a763e89326ce'
  ],
  close: [
    '99334726611ccf58a148b0814696bfa6fe08c1b2d027e946beccf5a74331c9aa',
    'bb1f660f35dbe3378b10a47ecebe1a803b1bd437ccb3f280d1bd837d77e13aac'
  ],
  list_elements: [
    'a6cd6d19adcc3d088f1740e0d298d2da71c13334dfadd81348fd2e75a0f19269',
    'c9a126d8679efad62943b7979effeb020d66d54252d552f73f6fff6402f4293a'
  ],
  get_element: [
    '6a0b98f2c7a65860e11538c9226f98c244ee14ab94df83358dee8ba400c827fa',
    '6bacfd2932098da88df335c374f8ddaa3d728f6c810b270da9856f7ace60c3fe'
  ],
  list_connections: [
    '0955a33a04979d10fe4e6d10d2e491e90b6421c44cd288980646cdcfc1a0ac0f',
    '7be4192a2906654bb980870e3b5bc5ba8dfbac8e6d13dd80376386da4dacb150'
  ],
  get_connection: [
    'a8d2494864383f5456f5246b9db83755e7e386bc3c3e23a4731b229ff2cdfa86',
    'd7c972eafd878cfa1321ae3de8c8391fd88db5d7352bc16117aa24effa143592'
  ],
  update_connection: [
    'a21f42a43df5e3c44f71c416dca5ef832615d387245e750d13b2c01aea2e8413',
    'd27c4cd3a1ae6e629e10a517f04153679f7df128773b6e2427085a33bfb7ce00'
  ],
  apply_geometry_patch: [
    'b24ad1f84788b55f3a90c9a91a28b649ab58184286024b4c10b048ef5d543fa3',
    '28aaa10560531121a986edb44a9220ad88f23bdfbd9eb29c3f0dc3bc0125832e'
  ],
  route_connection: [
    '97f02593e029053aad4ef8bfdf43002ab62be0f24e2660b87a784616cb2b3eec',
    'c5d75104c94e3bee70e050c7cd0998ecc9555508d73cdfe9fa3d0145fe37451a'
  ],
  export: [
    '5246d220ea6867c12b818a950bb411b641872c4ebae8daa7462d3939e1a63710',
    '62b4cdf277d72915b590cff5fe0a0fa2569d9a6ad756ed994fab000dc5582b01'
  ],
  validate: [
    '7480ee2efa429395b7cd39c1cc63b6323354ab4200eb9a2135ddbf9d6b9f07b8',
    '51b040b98aa2c23860847c0deb71e59ae2ea0a44756fb947157a61e29a2931ac'
  ],
  analyze_geometry: [
    'bbd7b771ec28732a75288fbd1b7a96af5dc4686983681ad8ecc95dc1fcc64eb7',
    '726e0006fae222243be6da25c89d3823fe0375e2b28446e3c00e7d5ea4206495'
  ]
};
const expectedPackedToolContractFingerprint =
  'e085308987ccbb57237892dc63a90751cf5910c94ceaf218ceb78ea48bdb1bd0';

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

function normalizeSchema(value) {
  if (Array.isArray(value)) return value.map(normalizeSchema);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizeSchema(child)])
  );
}

function schemaFingerprint(schema) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSchema(schema)))
    .digest('hex');
}

function callToolRequest(name, args = {}) {
  return {
    method: 'tools/call',
    params: { name, arguments: args }
  };
}

function requireToolSuccess(result, label) {
  if (!result || result.isError) {
    const diagnostic = result?.content?.find(item => item.type === 'text')?.text
      ?? JSON.stringify(result);
    throw new Error(`${label} failed: ${diagnostic}`);
  }
  if (!result.structuredContent) {
    throw new Error(`${label} did not return structured content`);
  }
  return result.structuredContent;
}

function textToolContent(result, label) {
  const block = result?.content?.find(item => item.type === 'text');
  if (!block || typeof block.text !== 'string') {
    throw new Error(`${label} did not return text content`);
  }
  return block.text;
}

function assertDiagnosticCodes(result, expectedErrors, expectedWarnings, label) {
  const structured = requireToolSuccess(result, label);
  const errors = structured.diagnostics
    ?.filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => diagnostic.code)
    .sort();
  const warnings = structured.diagnostics
    ?.filter(diagnostic => diagnostic.severity === 'warning')
    .map(diagnostic => diagnostic.code)
    .sort();
  if (JSON.stringify(errors) !== JSON.stringify([...expectedErrors].sort())
    || JSON.stringify(warnings) !== JSON.stringify([...expectedWarnings].sort())) {
    throw new Error(
      `${label} diagnostics differ: errors=${JSON.stringify(errors)} warnings=${JSON.stringify(warnings)}`
    );
  }
}

function assertValidation(result, expectedErrors, expectedWarnings, label) {
  const structured = requireToolSuccess(result, label);
  const errors = structured.errors?.map(issue => issue.code).sort();
  const warnings = structured.warnings?.map(issue => issue.code).sort();
  if (JSON.stringify(errors) !== JSON.stringify([...expectedErrors].sort())
    || JSON.stringify(warnings) !== JSON.stringify([...expectedWarnings].sort())) {
    throw new Error(
      `${label} validation differs: errors=${JSON.stringify(errors)} warnings=${JSON.stringify(warnings)}`
    );
  }
}

function snapshotUnrepairedDi(listedElements, listedConnections, repairedElementIds, repairedConnectionIds) {
  const snapshot = (items, idField, fields, repairedIds) => Object.fromEntries(
    items
      .filter(item => item[idField] && !repairedIds.has(item.id))
      .map(item => [
        item.id,
        Object.fromEntries(fields.map(field => [field, item[field]]))
      ])
  );

  return {
    shapes: snapshot(
      listedElements.elements,
      'shapeId',
      ['shapeId', 'bounds', 'labelBounds'],
      repairedElementIds
    ),
    edges: snapshot(
      listedConnections.connections,
      'edgeId',
      ['edgeId', 'waypoints', 'labelBounds'],
      repairedConnectionIds
    )
  };
}

function assertUnrepairedDiPreserved(before, after, label) {
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`${label} changed unrelated BPMNShape or BPMNEdge geometry`);
  }
}

async function semanticSnapshot(xml, label, normalizeExpected) {
  const moddle = new BpmnModdle();
  const parsed = await moddle.fromXML(xml);
  if (parsed.warnings.length !== 0) {
    throw new Error(`${label} has moddle warnings: ${JSON.stringify(parsed.warnings)}`);
  }
  normalizeExpected?.(parsed);
  parsed.rootElement.diagrams = [];
  const serialized = await moddle.toXML(parsed.rootElement, { format: true });
  return serialized.xml;
}

async function assertSvgRendersInBrowser(svg, label, executablePath) {
  if (typeof svg !== 'string' || !/^<svg\b/u.test(svg)) {
    throw new Error(`${label} did not produce an SVG document`);
  }

  const browser = await puppeteer.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`data:image/svg+xml,${encodeURIComponent(svg)}`, { waitUntil: 'load' });
    const rendering = await page.evaluate(() => {
      const svgElement = globalThis.document.documentElement;
      const renderedBounds = svgElement.getBoundingClientRect();
      return {
        localName: svgElement.localName,
        namespace: svgElement.namespaceURI,
        width: renderedBounds.width,
        height: renderedBounds.height,
        graphicElementCount: svgElement.querySelectorAll(
          'circle, ellipse, line, path, polygon, polyline, rect, text'
        ).length
      };
    });
    if (rendering.localName !== 'svg'
      || rendering.namespace !== 'http://www.w3.org/2000/svg'
      || rendering.width <= 0
      || rendering.height <= 0
      || rendering.graphicElementCount === 0) {
      throw new Error(`${label} did not load as a nonempty rendered SVG`);
    }
  } finally {
    await browser.close();
  }
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
                  tools: results.find(result => Array.isArray(result?.tools))?.tools
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
    }, 60_000);

    function sendNextRequest() {
      const requestFactory = requests[nextRequestIndex];
      const id = nextRequestIndex + 2;
      nextRequestIndex += 1;
      let request;
      try {
        request = typeof requestFactory === 'function'
          ? requestFactory({ initializeResult, results })
          : requestFactory;
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
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
  const runtimeRoot = join(temporaryRoot, 'runtime');
  mkdirSync(runtimeRoot);
  const packagedEnvironment = {
    ...process.env,
    NODE_PATH: '',
    PUPPETEER_CACHE_DIR: join(temporaryRoot, 'empty-puppeteer-cache'),
    PUPPETEER_EXECUTABLE_PATH: join(temporaryRoot, 'missing-chrome')
  };
  delete packagedEnvironment.MCP_BPMN_DIAGRAMS_PATH;
  const packedWorkflowStep = {
    tools: 0,
    createDiagram: 1,
    autoLayout: 2,
    exportXml: 3,
    exportSvg: 4,
    workspace: 5
  };
  const packagedResult = await runMcpSession(
    installedBin,
    [],
    runtimeRoot,
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
          name: 'auto_layout',
          arguments: {}
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
      },
      {
        method: 'tools/call',
        params: { name: 'get_workspace', arguments: {} }
      }
    ],
    packagedEnvironment
  );

  const createResult = packagedResult.results[packedWorkflowStep.createDiagram];
  const layoutResult = packagedResult.results[packedWorkflowStep.autoLayout];
  const xmlResult = packagedResult.results[packedWorkflowStep.exportXml];
  const svgResult = packagedResult.results[packedWorkflowStep.exportSvg];
  const workspaceResult = packagedResult.results[packedWorkflowStep.workspace];
  if (!layoutResult || layoutResult.isError) {
    const layoutDiagnostic = layoutResult?.content
      ?.find(item => item.type === 'text')?.text ?? JSON.stringify(layoutResult);
    throw new Error(`Packed auto_layout failed: ${layoutDiagnostic}`);
  }
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
  if (workspaceResult?.isError
    || workspaceResult?.structuredContent?.launchCwd !== realpathSync(runtimeRoot)
    || workspaceResult?.structuredContent?.workspace !== realpathSync(runtimeRoot)
    || workspaceResult?.structuredContent?.source !== 'launch_cwd'
    || !readdirSync(runtimeRoot).some(filename => filename.endsWith('.bpmn'))) {
    throw new Error('Packed executable did not use its first client launch cwd as the workspace');
  }
  const packedTools = packagedResult.tools ?? [];
  if (JSON.stringify(packedTools.map(tool => tool.name))
    !== JSON.stringify(expectedPackedToolNames)) {
    throw new Error(
      `Packed tools/list inventory differs: ${packedTools.map(tool => tool.name).join(',')}`
    );
  }
  const packedToolContractFingerprint = schemaFingerprint(packedTools.map(tool => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema
  })));
  if (packedToolContractFingerprint !== expectedPackedToolContractFingerprint) {
    throw new Error(
      `Packed tool contract fingerprint differs: ${packedToolContractFingerprint}`
    );
  }
  for (const [name, [expectedInput, expectedOutput]] of Object.entries(
    expectedPackedWorkflowSchemaFingerprints
  )) {
    const tool = packedTools.find(candidate => candidate.name === name);
    const actual = tool
      ? [schemaFingerprint(tool.inputSchema), schemaFingerprint(tool.outputSchema)]
      : undefined;
    if (JSON.stringify(actual) !== JSON.stringify([expectedInput, expectedOutput])) {
      throw new Error(
        `Packed ${name} schema fingerprints differ: ${JSON.stringify(actual)}`
      );
    }
  }

  const configuredRuntimeRoot = join(temporaryRoot, 'configured-runtime');
  mkdirSync(configuredRuntimeRoot);
  writeFileSync(
    join(configuredRuntimeRoot, '.mcp-bpmn.json'),
    JSON.stringify({ path: 'wiki/processes/assets' })
  );
  const configuredWorkflowStep = {
    workspace: 0,
    createDiagram: 1
  };
  const configuredResult = await runMcpSession(
    installedBin,
    [],
    configuredRuntimeRoot,
    [
      { method: 'tools/call', params: { name: 'get_workspace', arguments: {} } },
      {
        method: 'tools/call',
        params: { name: 'new_bpmn', arguments: { name: 'Configured packed smoke' } }
      }
    ],
    packagedEnvironment
  );
  const configuredWorkspace = join(
    realpathSync(configuredRuntimeRoot),
    'wiki',
    'processes',
    'assets'
  );
  if (configuredResult.results[configuredWorkflowStep.workspace]?.structuredContent?.workspace
      !== configuredWorkspace
    || configuredResult.results[configuredWorkflowStep.workspace]?.structuredContent?.source
      !== 'repository_config'
    || configuredResult.results[configuredWorkflowStep.createDiagram]?.isError
    || !readdirSync(configuredWorkspace).some(filename => filename.endsWith('.bpmn'))) {
    throw new Error('One packed executable did not isolate two repository workspaces');
  }

  const browserExecutable = await puppeteer.executablePath();
  if (!existsSync(browserExecutable)) {
    throw new Error(`Canonical geometry workflow browser is missing: ${browserExecutable}`);
  }
  const geometryRuntimeRoot = join(temporaryRoot, 'agent-geometry-runtime');
  mkdirSync(geometryRuntimeRoot);
  for (const fixture of ['imperfect-process.bpmn', 'imperfect-collaboration.bpmn']) {
    writeFileSync(
      join(geometryRuntimeRoot, fixture),
      readFileSync(join(projectRoot, 'tests', 'fixtures', 'agent-geometry', fixture))
    );
  }
  const geometryEnvironment = {
    ...process.env,
    NODE_PATH: '',
    PUPPETEER_EXECUTABLE_PATH: browserExecutable
  };
  delete geometryEnvironment.MCP_BPMN_DIAGRAMS_PATH;

  const processRepairSet = {
    elementIds: new Set(['Task_Process']),
    connectionIds: new Set(['Flow_Start_Task', 'Flow_Task_End'])
  };
  const processWorkflowStep = {
    tools: 0,
    open: 1,
    listElementsBefore: 2,
    getAnnotationBefore: 3,
    listConnectionsBefore: 4,
    getStartFlowBefore: 5,
    getEndFlowBefore: 6,
    validateBefore: 7,
    analyzeGeometryBefore: 8,
    exportSemanticsBefore: 9,
    updateStartFlow: 10,
    applyGeometryPatch: 11,
    getEndFlowBeforeRouting: 12,
    routeEndFlow: 13,
    applyRouteProposal: 14,
    close: 15,
    reopen: 16,
    validateAfter: 17,
    analyzeGeometryAfter: 18,
    listElementsAfter: 19,
    listConnectionsAfter: 20,
    getStartFlowAfter: 21,
    getEndFlowAfter: 22,
    exportXml: 23,
    exportSvg: 24
  };
  const processWorkflow = await runMcpSession(
    installedBin,
    [],
    geometryRuntimeRoot,
    [
      { method: 'tools/list', params: {} },
      callToolRequest('open_bpmn', { filename: 'imperfect-process.bpmn' }),
      callToolRequest('list_elements'),
      callToolRequest('get_element', { elementId: 'Annotation_Unrelated' }),
      callToolRequest('list_connections'),
      callToolRequest('get_connection', { connectionId: 'Flow_Start_Task' }),
      callToolRequest('get_connection', { connectionId: 'Flow_Task_End' }),
      callToolRequest('validate'),
      callToolRequest('analyze_geometry', { requireOrthogonal: true }),
      callToolRequest('export', { format: 'xml', formatted: true }),
      ({ results }) => {
        const flow = requireToolSuccess(
          results[processWorkflowStep.getStartFlowBefore],
          'inspect imperfect process flow'
        );
        return callToolRequest('update_connection', {
          connectionId: 'Flow_Start_Task',
          sourceId: 'Start_Process',
          targetId: 'Task_Process',
          label: 'begin',
          endpointPolicy: 'snap-to-boundary',
          expectedSemanticRevision: flow.semanticRevision
        });
      },
      ({ results }) => {
        const semanticUpdate = requireToolSuccess(
          results[processWorkflowStep.updateStartFlow],
          'correct process semantics'
        );
        return callToolRequest('apply_geometry_patch', {
          expectedRevision: semanticUpdate.afterRevision,
          elementUpdates: [{
            elementId: 'Task_Process',
            bounds: { x: 250, y: 100, width: 100, height: 80 }
          }],
          connectionUpdates: [
            {
              connectionId: 'Flow_Start_Task',
              waypoints: [
                { x: 136, y: 138 },
                { x: 180, y: 138 },
                { x: 180, y: 140 },
                { x: 250, y: 140 }
              ],
              endpointPolicy: 'exact'
            },
            {
              connectionId: 'Flow_Task_End',
              waypoints: [
                { x: 350, y: 140 },
                { x: 425, y: 140 },
                { x: 425, y: 138 },
                { x: 500, y: 138 }
              ],
              endpointPolicy: 'exact'
            }
          ]
        });
      },
      callToolRequest('get_connection', { connectionId: 'Flow_Task_End' }),
      ({ results }) => {
        const flow = requireToolSuccess(
          results[processWorkflowStep.getEndFlowBeforeRouting],
          'inspect corrected process route'
        );
        return callToolRequest('route_connection', {
          connectionId: 'Flow_Task_End',
          expectedGeometryRevision: flow.geometryRevision
        });
      },
      ({ results }) => {
        const proposal = requireToolSuccess(
          results[processWorkflowStep.routeEndFlow],
          'propose process route'
        );
        return callToolRequest('apply_geometry_patch', proposal.geometryPatch);
      },
      callToolRequest('close'),
      callToolRequest('open_bpmn', { filename: 'imperfect-process.bpmn' }),
      callToolRequest('validate'),
      callToolRequest('analyze_geometry', { requireOrthogonal: true }),
      callToolRequest('list_elements'),
      callToolRequest('list_connections'),
      callToolRequest('get_connection', { connectionId: 'Flow_Start_Task' }),
      callToolRequest('get_connection', { connectionId: 'Flow_Task_End' }),
      callToolRequest('export', { format: 'xml', formatted: true }),
      callToolRequest('export', { format: 'svg' })
    ],
    geometryEnvironment
  );
  if (JSON.stringify(processWorkflow.tools?.map(tool => tool.name))
    !== JSON.stringify(expectedPackedToolNames)) {
    throw new Error('Canonical process workflow did not use the pinned packed tool inventory');
  }
  const processOpened = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.open],
    'open process corpus'
  );
  if (processOpened.elementCount !== 4 || processOpened.connectionCount !== 2) {
    throw new Error('Canonical process corpus inventory changed');
  }
  const processElements = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.listElementsBefore],
    'list process elements'
  );
  if (JSON.stringify(processElements.elements.map(element => element.id).sort())
    !== JSON.stringify([
      'Annotation_Unrelated', 'End_Process', 'Start_Process', 'Task_Process'
    ])) {
    throw new Error('Canonical process element inventory changed');
  }
  const processConnections = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.listConnectionsBefore],
    'list process connections'
  );
  if (JSON.stringify(processConnections.connections.map(connection => connection.id).sort())
    !== JSON.stringify(['Flow_Start_Task', 'Flow_Task_End'])) {
    throw new Error('Canonical process connection inventory changed');
  }
  assertValidation(
    processWorkflow.results[processWorkflowStep.validateBefore],
    ['BPMN_START_EVENT_HAS_INCOMING_FLOW'],
    ['BPMN_PROFILE_MISSING_INCOMING_FLOW', 'BPMN_PROFILE_MISSING_OUTGOING_FLOW'],
    'imperfect process baseline'
  );
  assertDiagnosticCodes(
    processWorkflow.results[processWorkflowStep.analyzeGeometryBefore],
    ['EDGE_SHAPE_COLLISION', 'EDGE_SHAPE_COLLISION', 'SHAPE_OVERLAP'],
    ['NON_ORTHOGONAL_ROUTE', 'NON_ORTHOGONAL_ROUTE'],
    'imperfect process geometry baseline'
  );
  const processPatch = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.applyGeometryPatch],
    'apply process DI patch'
  );
  if (!processPatch.applied || processPatch.introducedDiagnostics.length !== 0) {
    throw new Error('Canonical process DI patch was not cleanly applied');
  }
  const processRoute = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.routeEndFlow],
    'route process flow'
  );
  if (processRoute.applied
    || processRoute.scoreBreakdown.shapeCollisions !== 0
    || processRoute.scoreBreakdown.connectionCrossings !== 0
    || processRoute.introducedDiagnostics.length !== 0) {
    throw new Error('Canonical process route proposal was not collision-free and proposal-only');
  }
  requireToolSuccess(
    processWorkflow.results[processWorkflowStep.applyRouteProposal],
    'apply proposed process route'
  );
  assertValidation(
    processWorkflow.results[processWorkflowStep.validateAfter],
    [],
    [],
    'reopened corrected process'
  );
  assertDiagnosticCodes(
    processWorkflow.results[processWorkflowStep.analyzeGeometryAfter],
    [],
    [],
    'reopened corrected process geometry'
  );
  const processDiBefore = snapshotUnrepairedDi(
    processElements,
    processConnections,
    processRepairSet.elementIds,
    processRepairSet.connectionIds
  );
  const processDiAfter = snapshotUnrepairedDi(
    requireToolSuccess(
      processWorkflow.results[processWorkflowStep.listElementsAfter],
      'list process elements after reopen'
    ),
    requireToolSuccess(
      processWorkflow.results[processWorkflowStep.listConnectionsAfter],
      'list process connections after reopen'
    ),
    processRepairSet.elementIds,
    processRepairSet.connectionIds
  );
  assertUnrepairedDiPreserved(processDiBefore, processDiAfter, 'Process repair');
  const correctedProcessFlow = requireToolSuccess(
    processWorkflow.results[processWorkflowStep.getStartFlowAfter],
    'inspect corrected process semantics'
  );
  if (correctedProcessFlow.sourceId !== 'Start_Process'
    || correctedProcessFlow.targetId !== 'Task_Process'
    || correctedProcessFlow.label !== 'begin') {
    throw new Error('Corrected process connection semantics did not survive reopen');
  }
  const processXml = textToolContent(
    processWorkflow.results[processWorkflowStep.exportXml],
    'export corrected process XML'
  );
  const expectedProcessSemantics = await semanticSnapshot(
    textToolContent(
      processWorkflow.results[processWorkflowStep.exportSemanticsBefore],
      'export process semantics before repair'
    ),
    'Process baseline XML',
    parsed => {
      const flow = parsed.elementsById.Flow_Start_Task;
      flow.sourceRef = parsed.elementsById.Start_Process;
      flow.targetRef = parsed.elementsById.Task_Process;
      flow.name = 'begin';
    }
  );
  const actualProcessSemantics = await semanticSnapshot(
    processXml,
    'Corrected process XML'
  );
  if (actualProcessSemantics !== expectedProcessSemantics) {
    throw new Error('Process repair changed semantics outside the intended flow correction');
  }
  const parsedProcess = await new BpmnModdle().fromXML(processXml);
  if (parsedProcess.warnings.length !== 0) {
    throw new Error(`Corrected process XML has moddle warnings: ${JSON.stringify(parsedProcess.warnings)}`);
  }
  const processRoot = parsedProcess.rootElement.rootElements.find(
    element => element.id === 'Process_AgentProcess'
  );
  const parsedProcessFlow = processRoot?.flowElements?.find(
    element => element.id === 'Flow_Start_Task'
  );
  if (parsedProcessFlow?.sourceRef?.id !== 'Start_Process'
    || parsedProcessFlow?.targetRef?.id !== 'Task_Process'
    || parsedProcessFlow?.name !== 'begin'
    || parsedProcess.elementsById.Annotation_Unrelated?.text !== 'Untouched process note') {
    throw new Error('Corrected process XML did not preserve its intended semantics');
  }
  const processSvg = processWorkflow.results[processWorkflowStep.exportSvg]?.content?.find(
    item => item.type === 'resource' && item.resource?.mimeType === 'image/svg+xml'
  )?.resource?.text;
  if (typeof processSvg !== 'string' || !/^<svg\b/u.test(processSvg)) {
    throw new Error('Corrected process did not render as SVG from the packed server');
  }
  await assertSvgRendersInBrowser(processSvg, 'Corrected process SVG', browserExecutable);

  const collaborationRepairSet = {
    elementIds: new Set(['Data_Request']),
    connectionIds: new Set(['Association_Request_Data', 'Message_Request'])
  };
  const collaborationWorkflowStep = {
    open: 0,
    listElementsBefore: 1,
    getDataBefore: 2,
    getUpperEndBefore: 3,
    listConnectionsBefore: 4,
    getMessageBefore: 5,
    getUpperFlowBefore: 6,
    validateBefore: 7,
    analyzeGeometryBefore: 8,
    exportSemanticsBefore: 9,
    applyDataPatch: 10,
    updateMessage: 11,
    getMessageBeforeRouting: 12,
    routeMessage: 13,
    applyRouteProposal: 14,
    close: 15,
    reopen: 16,
    validateAfter: 17,
    analyzeGeometryAfter: 18,
    listElementsAfter: 19,
    listConnectionsAfter: 20,
    getDataAfter: 21,
    getUpperEndAfter: 22,
    getUpperFlowAfter: 23,
    getMessageAfter: 24,
    exportXml: 25,
    exportSvg: 26
  };
  const collaborationWorkflow = await runMcpSession(
    installedBin,
    [],
    geometryRuntimeRoot,
    [
      callToolRequest('open_bpmn', { filename: 'imperfect-collaboration.bpmn' }),
      callToolRequest('list_elements'),
      callToolRequest('get_element', { elementId: 'Data_Request' }),
      callToolRequest('get_element', { elementId: 'Upper_End' }),
      callToolRequest('list_connections'),
      callToolRequest('get_connection', { connectionId: 'Message_Request' }),
      callToolRequest('get_connection', { connectionId: 'Upper_Flow_2' }),
      callToolRequest('validate'),
      callToolRequest('analyze_geometry', { clearance: 20, requireOrthogonal: true }),
      callToolRequest('export', { format: 'xml', formatted: true }),
      ({ results }) => {
        const opened = requireToolSuccess(
          results[collaborationWorkflowStep.open],
          'open collaboration corpus'
        );
        return callToolRequest('apply_geometry_patch', {
          expectedRevision: opened.revision,
          elementUpdates: [{
            elementId: 'Data_Request',
            bounds: { x: 550, y: 650, width: 36, height: 50 }
          }],
          connectionUpdates: [{
            connectionId: 'Association_Request_Data',
            waypoints: [
              { x: 270, y: 640 },
              { x: 270, y: 675 },
              { x: 550, y: 675 }
            ],
            endpointPolicy: 'exact'
          }]
        });
      },
      ({ results }) => {
        const message = requireToolSuccess(
          results[collaborationWorkflowStep.getMessageBefore],
          'inspect imperfect message flow'
        );
        return callToolRequest('update_connection', {
          connectionId: 'Message_Request',
          sourceId: 'Upper_Send',
          label: null,
          endpointPolicy: 'snap-to-boundary',
          expectedSemanticRevision: message.semanticRevision
        });
      },
      callToolRequest('get_connection', { connectionId: 'Message_Request' }),
      ({ results }) => {
        const message = requireToolSuccess(
          results[collaborationWorkflowStep.getMessageBeforeRouting],
          'inspect corrected message flow'
        );
        return callToolRequest('route_connection', {
          connectionId: 'Message_Request',
          avoidElementIds: ['Data_Request'],
          avoidConnectionIds: ['Lower_Main_Flow_1'],
          expectedGeometryRevision: message.geometryRevision
        });
      },
      ({ results }) => {
        const proposal = requireToolSuccess(
          results[collaborationWorkflowStep.routeMessage],
          'propose message-flow route'
        );
        return callToolRequest('apply_geometry_patch', proposal.geometryPatch);
      },
      callToolRequest('close'),
      callToolRequest('open_bpmn', { filename: 'imperfect-collaboration.bpmn' }),
      callToolRequest('validate'),
      callToolRequest('analyze_geometry', { clearance: 20, requireOrthogonal: true }),
      callToolRequest('list_elements'),
      callToolRequest('list_connections'),
      callToolRequest('get_element', { elementId: 'Data_Request' }),
      callToolRequest('get_element', { elementId: 'Upper_End' }),
      callToolRequest('get_connection', { connectionId: 'Upper_Flow_2' }),
      callToolRequest('get_connection', { connectionId: 'Message_Request' }),
      callToolRequest('export', { format: 'xml', formatted: true }),
      callToolRequest('export', { format: 'svg' })
    ],
    geometryEnvironment
  );
  const collaborationOpened = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.open],
    'open collaboration corpus'
  );
  if (collaborationOpened.elementCount !== 12 || collaborationOpened.connectionCount !== 8) {
    throw new Error('Canonical collaboration corpus inventory changed');
  }
  const collaborationElements = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.listElementsBefore],
    'list collaboration elements'
  );
  const collaborationConnections = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.listConnectionsBefore],
    'list collaboration connections'
  );
  if (!collaborationElements.elements.some(element => element.id === 'Data_Request')
    || !collaborationConnections.connections.some(connection => (
      connection.id === 'Message_Request' && connection.type === 'bpmn:MessageFlow'
    ))) {
    throw new Error('Canonical collaboration tool inventory omitted the reported geometry case');
  }
  assertValidation(
    collaborationWorkflow.results[collaborationWorkflowStep.validateBefore],
    [],
    [],
    'collaboration warning baseline'
  );
  assertDiagnosticCodes(
    collaborationWorkflow.results[collaborationWorkflowStep.analyzeGeometryBefore],
    ['EDGE_EDGE_CROSSING'],
    ['MINIMUM_CLEARANCE', 'NON_ORTHOGONAL_ROUTE', 'NON_ORTHOGONAL_ROUTE'],
    'imperfect collaboration geometry baseline'
  );
  const dataPatch = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.applyDataPatch],
    'apply data-object clearance patch'
  );
  if (!dataPatch.applied || dataPatch.introducedDiagnostics.length !== 0) {
    throw new Error('Data-object clearance patch was not cleanly applied');
  }
  const messageUpdate = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.updateMessage],
    'correct message semantics'
  );
  if (messageUpdate.after.sourceId !== 'Upper_Send'
    || messageUpdate.after.label !== undefined
    || messageUpdate.introducedDiagnostics.length !== 0) {
    throw new Error('Message semantic correction was incomplete or introduced diagnostics');
  }
  const messageRoute = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.routeMessage],
    'route crossing message flow'
  );
  if (messageRoute.applied
    || messageRoute.scoreBreakdown.shapeCollisions !== 0
    || messageRoute.scoreBreakdown.labelCollisions !== 0
    || messageRoute.scoreBreakdown.clearanceFailures !== 0
    || messageRoute.scoreBreakdown.connectionCrossings !== 0
    || messageRoute.diagnostics.length !== 0) {
    throw new Error('Message-flow route proposal did not resolve the reported crossing');
  }
  requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.applyRouteProposal],
    'apply proposed message-flow route'
  );
  assertValidation(
    collaborationWorkflow.results[collaborationWorkflowStep.validateAfter],
    [],
    [],
    'reopened corrected collaboration'
  );
  assertDiagnosticCodes(
    collaborationWorkflow.results[collaborationWorkflowStep.analyzeGeometryAfter],
    [],
    [],
    'reopened corrected collaboration geometry'
  );
  const correctedData = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getDataAfter],
    'inspect corrected data object'
  );
  if (JSON.stringify(correctedData.bounds)
    !== JSON.stringify({ x: 550, y: 650, width: 36, height: 50 })) {
    throw new Error('Data-object clearance correction did not survive reopen');
  }
  const upperEndBefore = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getUpperEndBefore],
    'inspect unrelated collaboration shape before repair'
  );
  const upperEndAfter = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getUpperEndAfter],
    'inspect unrelated collaboration shape after reopen'
  );
  const upperFlowBefore = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getUpperFlowBefore],
    'inspect unrelated collaboration edge before repair'
  );
  const upperFlowAfter = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getUpperFlowAfter],
    'inspect unrelated collaboration edge after reopen'
  );
  for (const [label, before, after, fields] of [
    ['shape', upperEndBefore, upperEndAfter, ['shapeId', 'bounds', 'labelBounds']],
    ['edge', upperFlowBefore, upperFlowAfter, ['edgeId', 'waypoints', 'labelBounds']]
  ]) {
    for (const field of fields) {
      if (JSON.stringify(after[field]) !== JSON.stringify(before[field])) {
        throw new Error(`Collaboration repair changed unrelated ${label} ${field}`);
      }
    }
  }
  const collaborationDiBefore = snapshotUnrepairedDi(
    collaborationElements,
    collaborationConnections,
    collaborationRepairSet.elementIds,
    collaborationRepairSet.connectionIds
  );
  const collaborationDiAfter = snapshotUnrepairedDi(
    requireToolSuccess(
      collaborationWorkflow.results[collaborationWorkflowStep.listElementsAfter],
      'list collaboration elements after reopen'
    ),
    requireToolSuccess(
      collaborationWorkflow.results[collaborationWorkflowStep.listConnectionsAfter],
      'list collaboration connections after reopen'
    ),
    collaborationRepairSet.elementIds,
    collaborationRepairSet.connectionIds
  );
  assertUnrepairedDiPreserved(
    collaborationDiBefore,
    collaborationDiAfter,
    'Collaboration repair'
  );
  const correctedMessage = requireToolSuccess(
    collaborationWorkflow.results[collaborationWorkflowStep.getMessageAfter],
    'inspect corrected message after reopen'
  );
  if (correctedMessage.sourceId !== 'Upper_Send'
    || correctedMessage.targetId !== 'Lower_Receive'
    || correctedMessage.label !== undefined) {
    throw new Error('Corrected message semantics did not survive reopen');
  }
  const collaborationXml = textToolContent(
    collaborationWorkflow.results[collaborationWorkflowStep.exportXml],
    'export corrected collaboration XML'
  );
  const expectedCollaborationSemantics = await semanticSnapshot(
    textToolContent(
      collaborationWorkflow.results[collaborationWorkflowStep.exportSemanticsBefore],
      'export collaboration semantics before repair'
    ),
    'Collaboration baseline XML',
    parsed => {
      const message = parsed.elementsById.Message_Request;
      message.sourceRef = parsed.elementsById.Upper_Send;
      message.name = undefined;
    }
  );
  const actualCollaborationSemantics = await semanticSnapshot(
    collaborationXml,
    'Corrected collaboration XML'
  );
  if (actualCollaborationSemantics !== expectedCollaborationSemantics) {
    throw new Error(
      'Collaboration repair changed semantics outside the intended message-flow correction'
    );
  }
  const parsedCollaboration = await new BpmnModdle().fromXML(collaborationXml);
  if (parsedCollaboration.warnings.length !== 0) {
    throw new Error(
      `Corrected collaboration XML has moddle warnings: ${JSON.stringify(parsedCollaboration.warnings)}`
    );
  }
  const parsedMessage = parsedCollaboration.elementsById.Message_Request;
  const parsedData = parsedCollaboration.elementsById.Data_Request;
  if (parsedMessage?.sourceRef?.id !== 'Upper_Send'
    || parsedMessage?.targetRef?.id !== 'Lower_Receive'
    || parsedMessage?.name !== undefined
    || parsedData?.dataObjectRef?.id !== 'Data_Request_Object'
    || parsedCollaboration.elementsById.Upper_Flow_2_di?.waypoint?.length !== 2) {
    throw new Error('Corrected collaboration XML did not preserve its intended semantics and DI');
  }
  const collaborationSvg = collaborationWorkflow.results[collaborationWorkflowStep.exportSvg]?.content?.find(
    item => item.type === 'resource' && item.resource?.mimeType === 'image/svg+xml'
  )?.resource?.text;
  if (typeof collaborationSvg !== 'string' || !/^<svg\b/u.test(collaborationSvg)) {
    throw new Error('Corrected collaboration did not render as SVG from the packed server');
  }
  await assertSvgRendersInBrowser(
    collaborationSvg,
    'Corrected collaboration SVG',
    browserExecutable
  );

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
