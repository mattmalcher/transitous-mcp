import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const endpoint = process.env.TRANSITOUS_MCP_URL;
const token = process.env.TRANSITOUS_MCP_TOKEN;
if (!endpoint || !token?.trim()) throw new Error('Set TRANSITOUS_MCP_URL and TRANSITOUS_MCP_TOKEN');
const client = new Client({name: 'transitous-smoke-check', version: '0.1.0'});
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {requestInit: {headers: {Authorization: `Bearer ${token}`}}}));
  assert.equal((await client.listTools()).tools.length, 3);
  assert.match((await client.readResource({uri: 'transitous://guide'})).contents[0].text, /operator/);
  const invalid = await client.callTool({name: 'plan_journey', arguments: {from: '1,2', to: '3,4', time: 'invalid'}});
  assert.equal(invalid.isError, true);
  console.log('Worker MCP initialization, discovery, guide and input validation passed.');
  if (process.argv.includes('--live-lookup')) {
    // One geocode lookup and one cached repeat. No routing or real trip output.
    const first = await client.callTool({name: 'find_stations', arguments: {text: 'Innsbruck', limit: 2}});
    assert.ok(!first.isError, first.content?.[0]?.text);
    assert.ok(first.structuredContent.matches.length > 0);
    const second = await client.callTool({name: 'find_stations', arguments: {text: 'Innsbruck', limit: 2}});
    assert.ok(!second.isError, second.content?.[0]?.text);
    assert.equal(second.structuredContent.sources[0].cached, true);
    console.log('Live station lookup and Durable Object cache repeat passed.');
  }
} finally { await client.close(); }
