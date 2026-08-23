import { SimpleBpmnEngine } from '../../../dist/core/SimpleBpmnEngine.js';
import { BpmnRequestHandler } from '../../../dist/server/handlers.js';
import { writeFile } from 'node:fs/promises';

const DELAY_MS = 150;
const delay = (milliseconds = DELAY_MS) => (
  new Promise(resolve => setTimeout(resolve, milliseconds))
);

const createProcess = SimpleBpmnEngine.prototype.createProcess;
SimpleBpmnEngine.prototype.createProcess = async function (name, ...args) {
  if (name === 'Slow create') await delay();
  return createProcess.call(this, name, ...args);
};

const createElement = SimpleBpmnEngine.prototype.createElement;
SimpleBpmnEngine.prototype.createElement = async function (processId, definition) {
  if (definition.name === 'Slow mutation' || definition.name === 'Never mutation') {
    if (process.env.MCP_BPMN_TEST_OPERATION_MARKER) {
      await writeFile(process.env.MCP_BPMN_TEST_OPERATION_MARKER, 'started');
    }
    if (definition.name === 'Never mutation') {
      await new Promise(() => undefined);
    }
    await delay();
  }
  return createElement.call(this, processId, definition);
};

const loadDiagram = SimpleBpmnEngine.prototype.loadDiagram;
SimpleBpmnEngine.prototype.loadDiagram = async function (...args) {
  await delay();
  return loadDiagram.call(this, ...args);
};

const executeRequest = BpmnRequestHandler.prototype.executeRequest;
BpmnRequestHandler.prototype.executeRequest = async function (name, args) {
  if (name === 'export') await delay();
  if (name === 'close') await delay(25);
  if (name === 'injected_queue_rejection') {
    throw new Error('Injected queue rejection');
  }
  return executeRequest.call(this, name, args);
};
