// Desktop bridge: research runs on the hosted Worker. stdout is MCP only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const endpoint = process.env.TRANSITOUS_MCP_URL;
const token = process.env.TRANSITOUS_MCP_TOKEN;
if (!endpoint || !token?.trim()) {
  console.error('Set TRANSITOUS_MCP_URL and TRANSITOUS_MCP_TOKEN to connect the desktop bridge.');
  process.exit(1);
}
const url = new URL(endpoint);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
  console.error('The MCP URL must use HTTPS (HTTP is allowed only on loopback for development).');
  process.exit(1);
}
const remote = new Client({name: 'transitous-desktop-bridge', version: '0.1.0'});
try {
  await remote.connect(new StreamableHTTPClientTransport(url, {requestInit: {headers: {Authorization: `Bearer ${token}`}}}));
  const server = new Server({name: 'transitous-mcp', version: '0.1.0'}, {capabilities: {tools: {}, resources: {}}, instructions: remote.getInstructions()});
  server.setRequestHandler(ListToolsRequestSchema, request => remote.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, request => remote.callTool(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, request => remote.listResources(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, request => remote.readResource(request.params));
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await server.close(); await remote.close(); };
  process.on('SIGINT', () => stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => stop().then(() => process.exit(0)));
  process.stdin.on('end', () => stop());
  await server.connect(new StdioServerTransport());
} catch {
  console.error('Unable to connect to Transitous MCP; check URL, token and server availability.');
  process.exit(1);
}
