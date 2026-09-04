import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceSession } from '../../src/config/WorkspaceSession.js';
import { diagramContext } from '../../src/core/DiagramContext.js';
import { SimpleBpmnEngine } from '../../src/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../src/server/handlers.js';

/**
 * `.mcp-bpmn.json` is documented as narrowing where the server may write. These
 * cases hold that boundary against a session that tries to select its way back
 * out of it, and stop an invented path from creating directories in the
 * repository (mcp-bpmn-owa.4).
 */
describe('repository workspace containment', () => {
  let repository: string;
  let handlers: BpmnRequestHandler[];

  beforeEach(async () => {
    repository = await fs.realpath(
      await fs.mkdtemp(path.join(tmpdir(), 'mcp-bpmn-workspace-containment-'))
    );
    handlers = [];
    diagramContext.clear();
  });

  afterEach(async () => {
    for (const handler of handlers) await handler.shutdown();
    diagramContext.clear();
    await fs.rm(repository, { recursive: true, force: true });
  });

  function handlerFor(session: WorkspaceSession): BpmnRequestHandler {
    const handler = new BpmnRequestHandler(
      new SimpleBpmnEngine(session.path),
      undefined,
      undefined,
      undefined,
      session
    );
    handlers.push(handler);
    return handler;
  }

  it('keeps every selection inside the configured workspace', async () => {
    await fs.mkdir(path.join(repository, 'src'));
    await fs.mkdir(path.join(repository, 'wiki', 'assets', 'diagrams'), { recursive: true });
    await fs.writeFile(
      path.join(repository, '.mcp-bpmn.json'),
      JSON.stringify({ path: 'wiki/assets' })
    );
    const session = WorkspaceSession.fromLaunch(repository, {});
    const handler = handlerFor(session);

    const escape = await handler.handleRequest('select_workspace', { path: 'src' });
    const inside = await handler.handleRequest('select_workspace', { path: 'diagrams' });

    expect(escape).toMatchObject({ isError: true });
    expect(inside.isError).toBeUndefined();
    expect(inside.structuredContent).toMatchObject({
      startupBoundary: path.join(repository, 'wiki', 'assets'),
      workspace: path.join(repository, 'wiki', 'assets', 'diagrams')
    });

    await handler.handleRequest('new_bpmn', { name: 'Contained' });
    await expect(fs.readdir(path.join(repository, 'src'))).resolves.toEqual([]);
    const written = await fs.readdir(path.join(repository, 'wiki', 'assets', 'diagrams'));
    expect(written.filter(entry => entry.endsWith('.bpmn'))).toHaveLength(1);
  });

  it('never creates directories for a workspace path the caller invented', async () => {
    await fs.mkdir(path.join(repository, 'wiki'));
    const session = WorkspaceSession.fromLaunch(repository, {});
    const handler = handlerFor(session);

    const invented = await handler.handleRequest('select_workspace', {
      path: 'brand/new/dirs'
    });

    expect(invented).toMatchObject({ isError: true });
    await expect(fs.readdir(repository)).resolves.toEqual(['wiki']);
    expect(session.getInfo()).toMatchObject({ workspace: repository });
  });
});
