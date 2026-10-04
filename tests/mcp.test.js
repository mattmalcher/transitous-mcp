import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import worker from '../src/worker.js';
const calls = [];
const env = {MCP_TOKEN: 'fictional-test-token', TRANSITOUS_USER_AGENT: 'fictional-test/1', TRANSITOUS: {
  idFromName: name => name,
  get: () => ({fetch: async (url, init) => {
    const query = JSON.parse(init.body); calls.push(query);
    const data = query.path === 'geocode' ? [{id: 'fictional:station', name: 'Fictional Station', type: 'STOP', lat: 1, lon: 2}] : query.path === 'plan' ? {itineraries: []} : {stopTimes: []};
    return Response.json({data, retrieved_at: '2026-10-01T10:00:00Z', cached: false});
  }}),
}};
test('authentication fails closed, rejects origins and limits body size', async () => {
  const req = (headers = {}, body = '{}') => new Request('https://example.com/mcp', {method: 'POST', headers, body});
  assert.equal((await worker.fetch(req(), {})).status, 503);
  assert.equal((await worker.fetch(req(), env)).status, 401);
  assert.equal((await worker.fetch(req({Authorization: 'Bearer wrong'}), env)).status, 401);
  const auth = {Authorization: `Bearer ${env.MCP_TOKEN}`};
  assert.equal((await worker.fetch(req({...auth, Origin: 'https://evil.example'}), env)).status, 403);
  assert.equal((await worker.fetch(req(auth, 'x'.repeat(32769)), env)).status, 413);
});
test('SDK client initializes, discovers tools, reads guide and runs research over HTTP', async () => {
  const client = new Client({name: 'fictional-test-client', version: '1.0'});
  const transport = new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
    requestInit: {headers: {Authorization: `Bearer ${env.MCP_TOKEN}`}},
    fetch: (url, init) => worker.fetch(new Request(url, init), env),
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name).sort(), ['find_stations', 'plan_journey', 'station_departures']);
    const guide = await client.readResource({uri: 'transitous://guide'});
    assert.match(guide.contents[0].text, /operator/);
    const stations = await client.callTool({name: 'find_stations', arguments: {text: 'Fictional Station'}});
    assert.equal(stations.structuredContent.matches[0].id, 'fictional:station');
    const result = await client.callTool({name: 'plan_journey', arguments: {from: '1,2', to: '3,4', time: '2026-10-10T08:00+01:00'}});
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.itineraries, []);
    assert.match(result.structuredContent.warnings.at(-1), /feed gap/);
    const invalid = await client.callTool({name: 'plan_journey', arguments: {from: '1,2', to: '3,4', time: '2026-10-10T08:00'}});
    assert.equal(invalid.isError, true);
    const count = calls.length;
    const excessive = await client.callTool({name: 'plan_journey', arguments: {from: '1,2', to: '3,4', time: '2026-10-10T08:00Z', limit: 1000}});
    assert.equal(excessive.isError, true); assert.equal(calls.length, count);
  } finally { await client.close(); }
});

test('anonymous clients can discover and call the same bounded tools without a token', async () => {
  const {MCP_TOKEN, ...anonymous} = env;
  const client = new Client({name: 'fictional-anonymous-client', version: '1.0'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'), {
      fetch: (url, init) => worker.fetch(new Request(url, init), anonymous),
    }));
    assert.equal((await client.listTools()).tools.length, 3);
    const result = await client.callTool({name: 'find_stations', arguments: {text: 'Fictional Station'}});
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.matches[0].id, 'fictional:station');
  } finally { await client.close(); }
});
