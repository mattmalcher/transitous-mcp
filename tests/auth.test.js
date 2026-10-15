import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
let upstream = 0;
const base = {TRANSITOUS_USER_AGENT: 'fictional-test/1', TRANSITOUS: {
  idFromName: name => name,
  get: () => ({fetch: async () => { upstream++; return Response.json({data: [{id: 'fictional:stop', name: 'Fictional station', type: 'STOP', lat: 1, lon: 2}], retrieved_at: '2026-10-01T10:00:00Z', cached: false}); }}),
}};
const call = {jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'find_stations', arguments: {text: 'Fictional station'}}};
const list = {jsonrpc: '2.0', id: 2, method: 'tools/list'};
const send = (env, {token, user, body = call, method = 'POST'} = {}) => worker.fetch(new Request('https://example.com/mcp', {
  method, headers: {'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(user ? {'Travel-Site-User': user} : {})},
  ...(method === 'POST' ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {}),
}), env);
const only = (env, expected, options) => send(env, options).then(response => assert.equal(response.status, expected));
const site = {...base, SITE_TOKEN: 'fictional-site-token', ALLOWED_USER_IDS: ' user-a , user-b '};
const direct = {...base, MCP_TOKEN: 'fictional-direct-token'};
const both = {...site, MCP_TOKEN: direct.MCP_TOKEN};

test('with no secret configured every request is refused before upstream access', async () => {
  const before = upstream;
  for (const env of [base, {...base, MCP_TOKEN: '  ', SITE_TOKEN: ''}, {...base, ALLOWED_USER_IDS: 'user-a'}]) {
    for (const method of ['POST', 'GET', 'DELETE']) await only(env, 503, {token: 'anything', user: 'user-a', method});
  }
  assert.equal(upstream, before);
});

test('identical door secrets are refused, so the direct door cannot bypass the allowlist', async () => {
  await only({...both, SITE_TOKEN: both.MCP_TOKEN}, 503, {token: both.MCP_TOKEN});
});

test('direct door: its token is enough, others are rejected', async () => {
  await only(direct, 200, {token: direct.MCP_TOKEN});
  await only(direct, 200, {token: direct.MCP_TOKEN, body: list});
  await only(direct, 401, {});
  await only(direct, 401, {token: 'wrong'});
  await only(direct, 401, {token: site.SITE_TOKEN, user: 'user-a'});
});

test('site door: discovery needs the token only, anything else needs an allowlisted user', async () => {
  await only(site, 200, {token: site.SITE_TOKEN, body: list});
  await only(site, 202, {token: site.SITE_TOKEN, body: {jsonrpc: '2.0', method: 'notifications/initialized'}}); // accepted, per the MCP spec
  await only(site, 401, {body: list});
  await only(site, 401, {token: direct.MCP_TOKEN, user: 'user-a'});
  const before = upstream;
  for (const options of [{}, {user: 'someone-else'}, {user: 'user-'}, {body: [call]}, {body: 'not json'},
                         {body: {jsonrpc: '2.0', id: 3, method: 'resources/read', params: {uri: 'transitous://guide'}}}]) {
    await only(site, 403, {token: site.SITE_TOKEN, ...options});
  }
  assert.equal(upstream, before);
  await only(site, 200, {token: site.SITE_TOKEN, user: 'user-b'});
  assert.equal(upstream, before + 1);
});

test('site door with an empty allowlist still answers discovery but refuses every tool call', async () => {
  for (const ALLOWED_USER_IDS of [undefined, '', ' , ']) {
    const env = {...site, ALLOWED_USER_IDS};
    await only(env, 200, {token: site.SITE_TOKEN, body: list});
    await only(env, 403, {token: site.SITE_TOKEN, user: 'user-a'});
  }
});

test('both doors configured: each secret opens only its own door', async () => {
  await only(both, 200, {token: both.MCP_TOKEN});
  await only(both, 403, {token: both.SITE_TOKEN});
  await only(both, 200, {token: both.SITE_TOKEN, user: 'user-a'});
  await only(both, 401, {token: 'wrong', user: 'user-a'});
});

test('browser origins are refused even with a valid token', async () => {
  const response = await worker.fetch(new Request('https://example.com/mcp', {method: 'POST', headers: {Authorization: `Bearer ${direct.MCP_TOKEN}`, Origin: 'https://evil.example'}, body: '{}'}), direct);
  assert.equal(response.status, 403);
});
