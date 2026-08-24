import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceSession } from '../../../src/config/WorkspaceSession.js';
import { SimpleBpmnEngine } from '../../../src/core/SimpleBpmnEngine.js';
import { diagramContext } from '../../../src/core/DiagramContext.js';
import { BpmnRequestHandler } from '../../../src/server/handlers.js';

describe('WorkspaceSession', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'mcp-bpmn-workspace-'));
    root = await fs.realpath(root);
    diagramContext.clear();
  });

  afterEach(async () => {
    diagramContext.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the canonical launch cwd when no override or repository config exists', () => {
    const session = WorkspaceSession.fromLaunch(root, {});

    expect(session.getInfo()).toEqual({
      launchCwd: root,
      startupBoundary: root,
      workspace: root,
      source: 'launch_cwd'
    });
  });

  it('resolves a repository config path below the launch boundary', async () => {
    await fs.writeFile(
      path.join(root, '.mcp-bpmn.json'),
      JSON.stringify({ path: 'wiki/processes/assets' })
    );

    const session = WorkspaceSession.fromLaunch(root, {});

    expect(session.getInfo()).toEqual({
      launchCwd: root,
      startupBoundary: root,
      workspace: path.join(root, 'wiki', 'processes', 'assets'),
      source: 'repository_config',
      configPath: path.join(root, '.mcp-bpmn.json')
    });
    await expect(fs.stat(session.path)).resolves.toMatchObject({});
  });

  it('gives an explicit absolute environment override highest precedence', async () => {
    const override = path.join(root, 'explicit');
    await fs.writeFile(
      path.join(root, '.mcp-bpmn.json'),
      JSON.stringify({ path: 'configured' })
    );

    const session = WorkspaceSession.fromLaunch(root, {
      MCP_BPMN_DIAGRAMS_PATH: override
    });

    expect(session.getInfo()).toMatchObject({
      launchCwd: root,
      startupBoundary: root,
      workspace: override,
      source: 'environment'
    });
  });

  it.each(['../escape', 'nested/../escape', './nested']) (
    'rejects repository dot-segment escape %s',
    async configuredPath => {
      await fs.writeFile(
        path.join(root, '.mcp-bpmn.json'),
        JSON.stringify({ path: configuredPath })
      );

      expect(() => WorkspaceSession.fromLaunch(root, {}))
        .toThrow('relative descendant without dot segments');
    }
  );

  it('rejects repository config and selection paths that traverse symlinks', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'mcp-bpmn-workspace-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'linked'));
      await fs.writeFile(
        path.join(root, '.mcp-bpmn.json'),
        JSON.stringify({ path: 'linked/configured' })
      );
      expect(() => WorkspaceSession.fromLaunch(root, {}))
        .toThrow('must not traverse symbolic links');
      await fs.rm(path.join(root, '.mcp-bpmn.json'));

      const session = WorkspaceSession.fromLaunch(root, {});
      expect(() => session.resolveSelection('linked/selected'))
        .toThrow('must not traverse symbolic links');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('switches only this handler session without changing process cwd', async () => {
    const session = WorkspaceSession.fromLaunch(root, {});
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(session.path),
      undefined,
      undefined,
      undefined,
      session
    );
    const cwd = process.cwd();

    const created = await handler.handleRequest('new_bpmn', { name: 'Before switch' });
    expect(created.isError).toBeUndefined();
    const selected = await handler.handleRequest('select_workspace', {
      path: 'wiki/processes/assets'
    });
    expect(selected.structuredContent).toMatchObject({
      launchCwd: root,
      startupBoundary: root,
      workspace: path.join(root, 'wiki', 'processes', 'assets'),
      source: 'selection',
      changed: true
    });
    expect(diagramContext.hasCurrent()).toBe(false);
    expect(process.cwd()).toBe(cwd);

    await handler.handleRequest('new_bpmn', { name: 'After switch' });
    const files = await fs.readdir(path.join(root, 'wiki', 'processes', 'assets'));
    expect(files.filter(filename => filename.endsWith('.bpmn'))).toHaveLength(1);
    await handler.shutdown();
  });
});
