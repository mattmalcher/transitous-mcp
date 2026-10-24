import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { registerResearch } from './register.js';
import { instructions } from './research.js';
export function makeMcp(research) {
  const server = new McpServer({name: 'transitous-mcp', version: '0.1.0'}, {instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator()});
  registerResearch(server, research);
  return server;
}
