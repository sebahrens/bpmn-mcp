import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporaryRoots: string[] = [];
const helperUrl = pathToFileURL(
  join(process.cwd(), 'scripts', 'release-artifact.mjs')
).href;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-bpmn-artifact-test-'));
  temporaryRoots.push(root);
  return root;
}

function snapshotReleaseArtifact(
  projectRoot: string,
  stagingRoot: string,
  artifactPath?: string,
  digest?: string
): string {
  const environment = { ...process.env };
  if (artifactPath === undefined) delete environment.MCP_BPMN_PACKAGE_TARBALL;
  else environment.MCP_BPMN_PACKAGE_TARBALL = artifactPath;
  if (digest === undefined) delete environment.MCP_BPMN_PACKAGE_SHA256;
  else environment.MCP_BPMN_PACKAGE_SHA256 = digest;

  const output = execFileSync(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { snapshotReleaseArtifact } from ${JSON.stringify(helperUrl)};
     try {
       process.stdout.write(JSON.stringify({
         snapshot: snapshotReleaseArtifact(process.argv[1], process.argv[2]) ?? ''
       }));
     } catch (error) {
       process.stdout.write(JSON.stringify({
         error: error instanceof Error ? error.message : String(error)
       }));
     }`,
    projectRoot,
    stagingRoot
  ], { encoding: 'utf8', env: environment });
  const result = JSON.parse(output) as { snapshot?: string; error?: string };
  if (result.error) throw new Error(result.error);
  return result.snapshot ?? '';
}

describe('release artifact snapshot', () => {
  it('copies and verifies the supplied artifact before returning it', () => {
    const root = temporaryRoot();
    const source = join(root, 'candidate.tgz');
    const staging = join(root, 'staging');
    mkdirSync(staging);
    writeFileSync(source, 'candidate bytes');
    const digest = createHash('sha256').update('candidate bytes').digest('hex');

    const snapshot = snapshotReleaseArtifact(root, staging, source, digest);

    expect(snapshot).toBe(join(staging, 'release-candidate.tgz'));
  });

  it.each([
    ['missing digest', undefined],
    ['malformed digest', 'not-a-digest'],
    ['mismatched digest', 'f'.repeat(64)]
  ])('rejects a supplied artifact with a %s', (_label, digest) => {
    const root = temporaryRoot();
    const source = join(root, 'candidate.tgz');
    const staging = join(root, 'staging');
    mkdirSync(staging);
    writeFileSync(source, 'candidate bytes');

    expect(() => snapshotReleaseArtifact(root, staging, source, digest))
      .toThrow('does not match MCP_BPMN_PACKAGE_SHA256');
  });

  it('rejects symlinked artifacts', () => {
    const root = temporaryRoot();
    const source = join(root, 'candidate.tgz');
    const link = join(root, 'candidate-link.tgz');
    const staging = join(root, 'staging');
    mkdirSync(staging);
    writeFileSync(source, 'candidate bytes');
    symlinkSync(source, link);

    expect(() => snapshotReleaseArtifact(root, staging, link, 'f'.repeat(64)))
      .toThrow('must name an existing, non-symlinked file');
  });

  it('rejects a missing artifact with a stable correction message', () => {
    const root = temporaryRoot();
    const staging = join(root, 'staging');
    mkdirSync(staging);

    expect(() => snapshotReleaseArtifact(
      root,
      staging,
      join(root, 'missing.tgz'),
      'f'.repeat(64)
    )).toThrow('MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file');
  });

  it('rejects a digest without an artifact path', () => {
    const root = temporaryRoot();
    const staging = join(root, 'staging');
    mkdirSync(staging);

    expect(() => snapshotReleaseArtifact(root, staging, undefined, 'f'.repeat(64)))
      .toThrow('MCP_BPMN_PACKAGE_SHA256 requires MCP_BPMN_PACKAGE_TARBALL');
  });
});
