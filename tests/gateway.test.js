import test from 'node:test';
import assert from 'node:assert/strict';
import {TransitousGateway} from '../src/gateway.js';
function setup(fetchReply = () => Response.json([])) {
  const values = new Map();
  let now = 1800000000000;
  const calls = [];
  const storage = {
    async get(k) { return structuredClone(values.get(k)); },
    async put(k, v) { if (typeof k === 'object') { for (const [key, value] of Object.entries(k)) values.set(key, structuredClone(value)); } else values.set(k, structuredClone(v)); },
    async getAlarm() { return values.get('alarm'); },
    async setAlarm(time) { values.set('alarm', time); },
    async delete(k) { values.delete(k); },
  };
  const gateway = new TransitousGateway({storage}, {TRANSITOUS_USER_AGENT: 'fictional-test/1 (+https://example.com)'}, {
    now: () => now, sleep: async ms => { now += ms; },
    fetch: async (url, init) => { calls.push({url: String(url), init, time: now}); return fetchReply(); },
  });
  const request = (path = 'geocode', params = {text: 'Fictional station'}) => gateway.fetch(new Request('https://internal/query', {method: 'POST', body: JSON.stringify({path, params})}));
  return {calls, values, request, gateway, advance: ms => { now += ms; }};
}
test('serializes concurrent cache misses, identifies requests and retains retrieval time', async () => {
  const {request, calls} = setup();
  const responses = await Promise.all([request(), request(), request('geocode', {text: 'Another fictional station'})]);
  const first = await responses[0].json(), cached = await responses[1].json();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].time - calls[0].time >= 1000);
  assert.equal(cached.cached, true); assert.equal(cached.retrieved_at, first.retrieved_at);
  assert.match(calls[0].init.headers['User-Agent'], /fictional-test/);
});
test('departure cache expires in a minute and routing cache in a day', async () => {
  const {request, calls, advance} = setup(() => Response.json({stopTimes: []}));
  await request('stoptimes', {stopId: 'test'}); advance(61000); await request('stoptimes', {stopId: 'test'});
  assert.equal(calls.length, 2);
  await request('plan', {fromPlace: '1,2', toPlace: '3,4'}); advance(61000); await request('plan', {fromPlace: '1,2', toPlace: '3,4'});
  assert.equal(calls.length, 3); advance(86400000); await request('plan', {fromPlace: '1,2', toPlace: '3,4'});
  assert.equal(calls.length, 4);
});
test('does not cache upstream failures or reflect their private body', async () => {
  const {request, calls} = setup(() => new Response('secret upstream content', {status: 500}));
  const result = await request(); assert.equal(result.status, 502); assert.doesNotMatch(await result.text(), /secret/);
  await request(); assert.equal(calls.length, 2);
});
test('rejects arbitrary upstream endpoints and caps minute budget', async () => {
  const {request, calls, values} = setup();
  assert.equal((await request('https://example.com')).status, 400);
  values.set('quota', {window: Math.floor(1800000000000 / 60000), count: 30});
  assert.equal((await request()).status, 429); assert.equal(calls.length, 0);
});
test('cache remains bounded', async () => {
  const {request, values} = setup();
  for (let i = 0; i < 70; i++) {
    values.delete('quota');
    await request('geocode', {text: `Fictional ${i}`});
  }
  assert.equal(values.get('keys').length, 64);
  assert.equal([...values.keys()].filter(k => k.startsWith('cache:')).length, 64);
});

test('alarm removes expired stored responses without another lookup', async () => {
  const {request, values, gateway, advance} = setup();
  await request('stoptimes', {stopId: 'test'});
  advance(61000);
  await gateway.alarm();
  assert.equal(values.get('keys').length, 0);
  assert.equal([...values.keys()].filter(k => k.startsWith('cache:')).length, 0);
});

test('daily budget persists, excludes cache hits and resets at midnight UTC', async () => {
  const {request, values, calls, gateway, advance} = setup();
  const first = await request();
  assert.equal(first.status, 200);
  const daily = values.get('daily');
  values.set('daily', {...daily, count: 200});
  assert.equal((await request()).status, 200);
  assert.equal(calls.length, 1);
  const denied = await request('geocode', {text: 'Different fictional station'});
  assert.equal(denied.status, 429);
  assert.match((await denied.json()).error, /midnight UTC/);
  // An isolate restart cannot reset stored counters.
  const original = gateway.storage;
  const restarted = new TransitousGateway({storage: original}, gateway.env, {now: gateway.now, sleep: gateway.sleep, fetch: gateway.fetchUpstream});
  const body = JSON.stringify({path: 'geocode', params: {text: 'Different fictional station'}});
  assert.equal((await restarted.fetch(new Request('https://internal/query', {method: 'POST', body}))).status, 429);
  advance(86400000);
  assert.equal((await request('geocode', {text: 'Different fictional station'})).status, 200);
  assert.equal(values.get('daily').count, 1);
});
