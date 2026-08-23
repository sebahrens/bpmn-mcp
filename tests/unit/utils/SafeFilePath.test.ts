import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { SafeFileStore } from '../../../src/utils/SafeFilePath.js';

interface InspectableSafeFileStore {
  worker?: {
    child?: {
      pid?: number;
      kill(): boolean;
    };
  };
}

describe('SafeFileStore worker lifecycle', () => {
  let root: string;
  let store: SafeFileStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-bpmn-safe-file-store-'));
    store = new SafeFileStore(root);
  });

  afterEach(async () => {
    const inspectable = store as unknown as InspectableSafeFileStore;
    inspectable.worker?.child?.kill();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reuses its anchored worker across ordinary request gaps', async () => {
    await store.write('diagram.bpmn', ['.bpmn'], '<xml />', false);
    const inspectable = store as unknown as InspectableSafeFileStore;
    const initialPid = inspectable.worker?.child?.pid;

    expect(initialPid).toEqual(expect.any(Number));
    await new Promise(resolve => setTimeout(resolve, 250));

    await expect(store.read('diagram.bpmn', ['.bpmn'], 1024)).resolves.toBe('<xml />');
    expect(inspectable.worker?.child?.pid).toBe(initialPid);
  });
});
