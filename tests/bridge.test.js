import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import worker from '../src/worker.js';
test('desktop stdio bridge forwards discovery, resources and tools to authenticated HTTP', async () => {
  const env = {MCP_TOKEN: 'fictional-bridge-token', TRANSITOUS_USER_AGENT: 'fictional-test/1', TRANSITOUS: {
    idFromName: name => name, get: () => ({fetch: async () => Response.json({data: [{id: 'fictional:stop', name: 'Fictional station', type: 'STOP', lat: 1, lon: 2}], retrieved_at: '2026-10-01T10:00:00Z', cached: false})}),
  }};
  const host = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, {method: req.method, headers: req.headers, ...(req.method === 'POST' ? {body: Buffer.concat(chunks)} : {})}), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  host.listen(0, '127.0.0.1'); await once(host, 'listening');
  const client = new Client({name: 'fictional-bridge-test', version: '1.0'});
  try {
    await client.connect(new StdioClientTransport({command: process.execPath, args: ['src/stdio.js'], env: {PATH: process.env.PATH, TRANSITOUS_MCP_TOKEN: env.MCP_TOKEN, TRANSITOUS_MCP_URL: `http://127.0.0.1:${host.address().port}/mcp`}, stderr: 'pipe'}));
    assert.equal((await client.listTools()).tools.length, 3);
    assert.match((await client.readResource({uri: 'transitous://guide'})).contents[0].text, /operator/);
    const result = await client.callTool({name: 'find_stations', arguments: {text: 'Fictional station'}});
    assert.equal(result.structuredContent.matches[0].id, 'fictional:stop');
  } finally {
    await client.close();
    await new Promise(resolve => host.close(resolve));
  }
});
