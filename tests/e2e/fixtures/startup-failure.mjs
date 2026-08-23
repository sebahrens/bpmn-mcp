import { Server } from '@modelcontextprotocol/sdk/server/index.js';

Server.prototype.connect = async function () {
  throw new Error('Injected startup failure');
};
