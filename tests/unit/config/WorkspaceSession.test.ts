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

    // The configured directory is the containment boundary, not merely the
    // initial workspace: mcp-bpmn-owa.4 pinned startupBoundary to the launch
    // cwd, which left repository-narrowed storage unenforced.
    expect(session.getInfo()).toEqual({
      launchCwd: root,
      startupBoundary: path.join(root, 'wiki', 'processes', 'assets'),
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
      startupBoundary: override,
      workspace: override,
      source: 'environment'
    });
  });

  it.each(['../escape', 'nested/../escape', './nested']) (
    'refuses repository dot-segment escape %s without applying it',
    async configuredPath => {
      await fs.writeFile(
        path.join(root, '.mcp-bpmn.json'),
        JSON.stringify({ path: configuredPath })
      );

      // mcp-bpmn-a3j.28: this used to assert that fromLaunch() throws, which is
      // what killed the server during module import. The escape is still never
      // applied; the refusal is now carried to the first workspace call.
      const session = WorkspaceSession.fromLaunch(root, {});

      expect(session.getInfo()).toMatchObject({ workspace: root, source: 'launch_cwd' });
      expect(session.getStartupFailure())
        .toContain('relative descendant without dot segments');
      expect(() => session.resolveSelection('anywhere'))
        .toThrow('relative descendant without dot segments');
      await expect(fs.readdir(root)).resolves.toEqual(['.mcp-bpmn.json']);
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
      // mcp-bpmn-a3j.28: the config-driven refusal is carried out of module
      // import rather than thrown there; nothing below the symlink is touched.
      const configured = WorkspaceSession.fromLaunch(root, {});
      expect(configured.getInfo()).toMatchObject({ workspace: root, source: 'launch_cwd' });
      expect(() => configured.resolveSelection('linked/configured'))
        .toThrow('must not traverse symbolic links');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
      await fs.rm(path.join(root, '.mcp-bpmn.json'));

      const session = WorkspaceSession.fromLaunch(root, {});
      expect(() => session.resolveSelection('linked/selected'))
        .toThrow('must not traverse symbolic links');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a selection that does not exist and creates nothing', async () => {
    const session = WorkspaceSession.fromLaunch(root, {});
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(session.path),
      undefined,
      undefined,
      undefined,
      session
    );

    try {
      const rejected = await handler.handleRequest('select_workspace', {
        path: 'brand/new/dirs'
      });

      expect(rejected).toMatchObject({ isError: true });
      expect(rejected.structuredContent).toMatchObject({
        message: expect.stringContaining('does not exist below the startup boundary')
      });
      await expect(fs.readdir(root)).resolves.toEqual([]);
      expect(session.getInfo()).toMatchObject({ workspace: root, source: 'launch_cwd' });
    } finally {
      await handler.shutdown();
    }
  });

  it('creates a selected directory tree only when the caller opts in', async () => {
    const session = WorkspaceSession.fromLaunch(root, {});

    expect(() => session.resolveSelection('brand/new/dirs')).toThrow('does not exist');
    await expect(fs.readdir(root)).resolves.toEqual([]);

    expect(session.resolveSelection('brand/new/dirs', { create: true }))
      .toBe(path.join(root, 'brand', 'new', 'dirs'));
    await expect(fs.stat(path.join(root, 'brand', 'new', 'dirs')))
      .resolves.toMatchObject({});
  });

  it('confines selections to the configured repository workspace', async () => {
    await fs.mkdir(path.join(root, 'src'));
    await fs.mkdir(path.join(root, 'wiki', 'assets', 'nested'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.mcp-bpmn.json'),
      JSON.stringify({ path: 'wiki/assets' })
    );

    const session = WorkspaceSession.fromLaunch(root, {});

    expect(session.resolveSelection('nested')).toBe(path.join(root, 'wiki', 'assets', 'nested'));
    expect(() => session.resolveSelection('src')).toThrow('does not exist');
    expect(() => session.activateSelection(path.join(root, 'src')))
      .toThrow('descendant of the startup boundary');
  });

  describe('an unusable .mcp-bpmn.json', () => {
    // fromLaunch() runs while src/server/index.ts is still being imported,
    // before the transport exists, so throwing there kills the process with a
    // stack trace on stderr and the client never gets a protocol response. The
    // session degrades to the launch cwd and keeps the failure, which the next
    // workspace call reports as an ordinary tool error.
    const unusableConfigs: Array<[string, string]> = [
      ['malformed JSON', '{not json'],
      ['the wrong shape', JSON.stringify({ directory: 'diagrams' })],
      ['a dot-segment escape', JSON.stringify({ path: '../escape' })]
    ];

    it.each(unusableConfigs)('starts on the launch cwd when the config is %s',
      async (_label, contents) => {
        await fs.writeFile(path.join(root, '.mcp-bpmn.json'), contents);

        const session = WorkspaceSession.fromLaunch(root, {});

        expect(session.getInfo()).toMatchObject({
          launchCwd: root,
          startupBoundary: root,
          workspace: root,
          source: 'launch_cwd',
          startupFailure: expect.stringContaining('.mcp-bpmn.json')
        });
        expect(session.getStartupFailure()).toContain('.mcp-bpmn.json');
      });

    it('reports the failure to the MCP client as a tool error, not at import time', async () => {
      await fs.writeFile(path.join(root, '.mcp-bpmn.json'), '{not json');
      await fs.mkdir(path.join(root, 'diagrams'));

      const session = WorkspaceSession.fromLaunch(root, {});
      const handler = new BpmnRequestHandler(
        new SimpleBpmnEngine(session.path),
        undefined,
        undefined,
        undefined,
        session
      );

      try {
        const rejected = await handler.handleRequest('select_workspace', { path: 'diagrams' });

        expect(rejected).toMatchObject({ isError: true });
        expect(rejected.structuredContent).toMatchObject({
          message: expect.stringContaining('must contain valid JSON')
        });
        // The server is still answering calls at all, which is the point.
        const workspace = await handler.handleRequest('get_workspace', {});
        expect(workspace.isError).toBeUndefined();
        expect(workspace.structuredContent).toMatchObject({
          workspace: root,
          source: 'launch_cwd'
        });
      } finally {
        await handler.shutdown();
      }
    });

    // The environment-variable branch runs at the same point in startup and
    // used to throw for exactly the same reason (mcp-bpmn-owa.6).
    const unusableOverrides: Array<[string, (root: string) => Promise<string>]> = [
      ['a relative path', async () => 'diagrams'],
      ['a dot-segment escape', async () => '/tmp/../etc/mcp-bpmn-owa-6'],
      ['a path naming an existing file', async directory => {
        const file = path.join(directory, 'not-a-directory');
        await fs.writeFile(file, 'x');
        return file;
      }]
    ];

    it.each(unusableOverrides)(
      'starts on the launch cwd when MCP_BPMN_DIAGRAMS_PATH is %s',
      async (_label, buildOverride) => {
        const session = WorkspaceSession.fromLaunch(root, {
          MCP_BPMN_DIAGRAMS_PATH: await buildOverride(root)
        });

        expect(session.getInfo()).toMatchObject({
          launchCwd: root,
          startupBoundary: root,
          workspace: root,
          source: 'launch_cwd',
          startupFailure: expect.stringContaining('MCP_BPMN_DIAGRAMS_PATH')
        });
        expect(session.getStartupFailure()).toContain('MCP_BPMN_DIAGRAMS_PATH');
      }
    );

    it('reports a refused startup configuration through get_workspace', async () => {
      // The reason was carried on the session but nothing surfaced it until a
      // workspace switch was attempted and failed (mcp-bpmn-8u0.21).
      await fs.writeFile(path.join(root, '.mcp-bpmn.json'), '{not json');
      const session = WorkspaceSession.fromLaunch(root, {});
      const handler = new BpmnRequestHandler(
        new SimpleBpmnEngine(session.path),
        undefined,
        undefined,
        undefined,
        session
      );

      try {
        const workspace = await handler.handleRequest('get_workspace', {});

        expect(workspace.isError).toBeUndefined();
        expect(workspace.structuredContent).toMatchObject({
          source: 'launch_cwd',
          startupFailure: expect.stringContaining('.mcp-bpmn.json')
        });
      } finally {
        await handler.shutdown();
      }
    });

    it('reports no startup failure when the configuration was applied', async () => {
      await fs.writeFile(
        path.join(root, '.mcp-bpmn.json'),
        JSON.stringify({ path: 'diagrams' })
      );
      await fs.mkdir(path.join(root, 'diagrams'), { recursive: true });
      const session = WorkspaceSession.fromLaunch(root, {});

      expect(session.getInfo()).not.toHaveProperty('startupFailure');
    });

    it('keeps a usable MCP_BPMN_DIAGRAMS_PATH free of any startup failure', async () => {
      const override = path.join(root, 'override');
      await fs.mkdir(override);

      const session = WorkspaceSession.fromLaunch(root, {
        MCP_BPMN_DIAGRAMS_PATH: override
      });

      expect(session.getStartupFailure()).toBeUndefined();
      expect(session.getInfo()).toMatchObject({
        workspace: override,
        source: 'environment'
      });
    });

    it('keeps a usable repository config working and free of any startup failure', async () => {
      await fs.writeFile(
        path.join(root, '.mcp-bpmn.json'),
        JSON.stringify({ path: 'wiki/assets' })
      );
      await fs.mkdir(path.join(root, 'wiki', 'assets', 'nested'), { recursive: true });

      const session = WorkspaceSession.fromLaunch(root, {});

      expect(session.getStartupFailure()).toBeUndefined();
      expect(session.resolveSelection('nested'))
        .toBe(path.join(root, 'wiki', 'assets', 'nested'));
    });

  });

  it('switches only this handler session without changing process cwd', async () => {
    const session = WorkspaceSession.fromLaunch(root, {});
    // select_workspace no longer creates the directory tree (mcp-bpmn-owa.4),
    // so the destination exists before the switch.
    await fs.mkdir(path.join(root, 'wiki', 'processes', 'assets'), { recursive: true });
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
