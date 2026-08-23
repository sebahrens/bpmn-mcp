import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { BpmnSvgRenderer } from '../../../dist/core/BpmnSvgRenderer.js';
import { BpmnAutoLayoutV2Adapter } from '../../../dist/core/layout/BpmnLayoutAdapter.js';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const layout = BpmnAutoLayoutV2Adapter.prototype.layout;
BpmnAutoLayoutV2Adapter.prototype.layout = async function (...args) {
  const marker = process.env.MCP_BPMN_TEST_LAYOUT_PID;
  if (!marker) return layout.apply(this, args);

  const helper = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 250)'], {
    stdio: 'ignore'
  });
  await writeFile(marker, String(helper.pid));
  const helperExit = new Promise((resolve, reject) => {
    helper.once('error', reject);
    helper.once('close', resolve);
  });
  const [result] = await Promise.all([layout.apply(this, args), helperExit]);
  return result;
};

const launchBrowser = BpmnSvgRenderer.prototype.launchBrowser;
BpmnSvgRenderer.prototype.launchBrowser = async function (...args) {
  const browser = await launchBrowser.apply(this, args);
  const marker = process.env.MCP_BPMN_TEST_BROWSER_PID;
  const browserProcess = browser.process();
  if (marker && browserProcess?.pid) {
    await writeFile(marker, String(browserProcess.pid));
    await delay(250);
  }
  return browser;
};
