import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

const projectRoot = process.cwd();
const packageMetadata = JSON.parse(
  readFileSync(join(projectRoot, 'package.json'), 'utf8')
);

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

for (const entrypoint of declaredEntrypoints) {
  if (!existsSync(join(projectRoot, entrypoint))) {
    throw new Error(`Declared package entrypoint is missing: ${entrypoint}`);
  }
}

const dryRun = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
)[0];
const packedFiles = new Set(dryRun.files.map(({ path }) => normalize(path)));

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
              finish(undefined, response.result);
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
  const sourceTreeResult = await initialize(
    'npm',
    ['start', '--silent'],
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

  const installedBin = join(
    installRoot,
    'node_modules',
    '.bin',
    'mcp-bpmn-server'
  );
  const packagedResult = await initialize(installedBin, [], installRoot);

  if (sourceTreeResult.serverInfo.version !== packageMetadata.version) {
    throw new Error(
      `npm start reports ${sourceTreeResult.serverInfo.version}; expected ${packageMetadata.version}`
    );
  }

  if (packagedResult.serverInfo.version !== packageMetadata.version) {
    throw new Error(
      `Packaged server reports ${packagedResult.serverInfo.version}; expected ${packageMetadata.version}`
    );
  }

  if (JSON.stringify(packagedResult.serverInfo) !== JSON.stringify(sourceTreeResult.serverInfo)) {
    throw new Error('npm start and the packaged executable report different server metadata');
  }

  console.log(
    `Package smoke test passed for ${packageMetadata.name}@${packageMetadata.version}`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
