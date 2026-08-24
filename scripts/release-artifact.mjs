import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';

export function snapshotReleaseArtifact(projectRoot, temporaryRoot, environment = process.env) {
  const rawPath = environment.MCP_BPMN_PACKAGE_TARBALL;
  if (!rawPath) {
    if (environment.MCP_BPMN_PACKAGE_SHA256) {
      throw new Error('MCP_BPMN_PACKAGE_SHA256 requires MCP_BPMN_PACKAGE_TARBALL');
    }
    return undefined;
  }

  const requestedPath = resolve(projectRoot, rawPath);
  let descriptor;
  try {
    descriptor = openSync(requestedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('MCP_BPMN_PACKAGE_TARBALL must name an existing, non-symlinked file');
  }

  let artifactBytes;
  try {
    const sourceStat = fstatSync(descriptor);
    if (!sourceStat.isFile() || sourceStat.size > 100 * 1024 * 1024) {
      throw new Error('MCP_BPMN_PACKAGE_TARBALL must be a regular file no larger than 100 MiB');
    }
    artifactBytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  const snapshotPath = join(temporaryRoot, 'release-candidate.tgz');
  writeFileSync(snapshotPath, artifactBytes, { flag: 'wx', mode: 0o600 });

  const expectedDigest = environment.MCP_BPMN_PACKAGE_SHA256?.toLowerCase();
  const actualDigest = createHash('sha256')
    .update(artifactBytes)
    .digest('hex');
  if (!expectedDigest || !/^[a-f0-9]{64}$/.test(expectedDigest)
    || actualDigest !== expectedDigest) {
    throw new Error('Supplied release tarball does not match MCP_BPMN_PACKAGE_SHA256');
  }

  return snapshotPath;
}
