// Estimates per-invocation CPU for the Worker and its Durable Object, replaying recorded upstream
// responses so no network is used. All I/O is in-memory and resolves immediately, so busy wall time
// on the single JS thread approximates CPU time. Production splits the work into separate
// invocations (Worker request, each DO request), each with its own 10 ms Free-plan CPU budget.
// Run: node --expose-gc spike/measure.js [iterations]
import {readFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import worker from '../src/worker.js';
import {TransitousGateway} from '../src/gateway.js';
import {makeMcp} from '../src/mcp.js';
import {Research} from '../src/research.js';
import {gatewayGet} from '../src/gateway.js';
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import {ROUTE, TIME, LONG} from './route.js';
import {sections} from './seat61.js';

const N = Number(process.argv[2] || 30);
const {stopId, responses} = JSON.parse(readFileSync(new URL('./fixtures/transitous.json', import.meta.url)));
const TOKEN = 'fictional-spike-token';

// One shared DO instance, as in production (idFromName('shared-upstream')). Time spent inside
// gateway.fetch is the DO invocation; everything else is the Worker invocation.
let doMs = [];
function makeEnv() {
  const values = new Map();
  const storage = {
    async get(k) { return structuredClone(values.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) values.set(a, structuredClone(b)); else values.set(k, structuredClone(v)); },
    async getAlarm() {}, async setAlarm() {}, async delete(k) { values.delete(k); },
  };
  let now = Date.parse('2026-10-15T08:00:00Z');
  const gateway = new TransitousGateway({storage}, {TRANSITOUS_USER_AGENT: 'spike/0'}, {
    now: () => now, sleep: async ms => { now += ms; },
    fetch: async url => {
      const hit = responses[String(url)];
      if (!hit) throw new Error(`No fixture for ${url}`);
      return new Response(hit.body, {status: hit.status});
    },
  });
  const stub = {fetch: async (url, init) => {
    const start = performance.now();
    const response = await gateway.fetch(new Request(url, init));
    // Production streams the body across the binding; reading it here is part of the DO's serialisation.
    const body = await response.arrayBuffer();
    doMs.push(performance.now() - start);
    return new Response(body, {status: response.status, headers: response.headers});
  }};
  return {MCP_TOKEN: TOKEN, TRANSITOUS_USER_AGENT: 'spike/0', TRANSITOUS: {idFromName: n => n, get: () => stub}};
}

const rpc = (name, args) => new Request('https://spike.example/mcp', {
  method: 'POST',
  headers: {Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18'},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}}),
});

// The planned plan_route composite: resolve every stop, plan every consecutive leg, in ONE Worker
// invocation. Same shape as worker.js, with the extra tool registered.
const routeWorker = {async fetch(request, env) {
  const research = new Research(gatewayGet(env.TRANSITOUS));
  const server = makeMcp(research);
  server.registerTool('plan_route', {description: 'spike', inputSchema: {stops: z.array(z.string()).min(2).max(6), time: z.string(), limit: z.number().int().min(1).max(6).default(3)}}, async ({stops, time, limit}) => {
    const legs = [];
    for (let i = 0; i + 1 < stops.length; i++) legs.push(await research.plan({from: stops[i], to: stops[i + 1], time, limit}));
    const result = {legs};
    return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result};
  });
  const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
  await server.connect(transport);
  try { return await transport.handleRequest(request); } finally { await server.close(); }
}};

async function once(handler, env, name, args) {
  doMs = [];
  globalThis.gc?.();
  const start = performance.now();
  const response = await handler.fetch(rpc(name, args), env);
  const text = await response.text();
  const total = performance.now() - start;
  if (response.status !== 200 || /"isError":true/.test(text)) throw new Error(`${name} failed: ${response.status} ${text.slice(0, 300)}`);
  const doTotal = doMs.reduce((a, b) => a + b, 0);
  return {worker: total - doTotal, doMax: Math.max(0, ...doMs), doCalls: doMs.length, bytesOut: text.length};
}

const stats = xs => { const s = [...xs].sort((a, b) => a - b); const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return {p50: q(0.5), p95: q(0.95), max: s[s.length - 1]}; };
const f = x => x.toFixed(2).padStart(6);
const rows = [];
async function scenario(label, handler, name, args, {warmCache = false} = {}) {
  const cold = [], warm = [];
  for (let i = 0; i < N; i++) {
    const env = makeEnv();
    if (warmCache) await once(handler, env, name, args); // prime the DO cache
    (i === 0 && !rows.length ? cold : warm).push(await once(handler, env, name, args));
  }
  const all = [...cold, ...warm];
  const w = stats(warm.map(r => r.worker)), d = stats(warm.map(r => r.doMax));
  rows.push({label, w, d, calls: all[0].doCalls, out: all[0].bytesOut, first: cold[0]});
}

// Warm the module graph once so the first scenario isn't charged for one-off JIT of everything.
const firstEnv = makeEnv();
const first = await once(worker, firstEnv, 'find_stations', {text: ROUTE[0], limit: 8});

await scenario('find_stations (miss)', worker, 'find_stations', {text: ROUTE[0], limit: 8});
await scenario('find_stations (cached)', worker, 'find_stations', {text: ROUTE[0], limit: 8}, {warmCache: true});
for (let i = 0; i + 1 < ROUTE.length; i++) await scenario(`plan_journey leg ${i + 1} (miss)`, worker, 'plan_journey', {from: ROUTE[i], to: ROUTE[i + 1], time: TIME, limit: 6});
await scenario('plan_journey leg 4 (cached)', worker, 'plan_journey', {from: ROUTE[3], to: ROUTE[4], time: TIME, limit: 6}, {warmCache: true});
await scenario('station_departures n=20 (miss)', worker, 'station_departures', {stop_id: stopId, time: TIME, limit: 20});
await scenario('plan_route 5 legs (miss)', routeWorker, 'plan_route', {stops: ROUTE, time: TIME, limit: 6});
await scenario('plan_route 5 legs (cached)', routeWorker, 'plan_route', {stops: ROUTE, time: TIME, limit: 6}, {warmCache: true});

console.log(`Node ${process.version}, ${N} iterations per scenario, fresh DO state each iteration. Times in ms.`);
console.log(`Very first call in a fresh process (module JIT): Worker ${first.worker.toFixed(2)}, DO ${first.doMax.toFixed(2)}\n`);
console.log('Scenario'.padEnd(34), 'Worker p50    p95    max', ' | ', 'DO/call p50    p95    max', ' | DO calls  reply KB');
for (const r of rows) console.log(r.label.padEnd(34), '      ', f(r.w.p50), f(r.w.p95), f(r.w.max), ' | ', '       ', f(r.d.p50), f(r.d.p95), f(r.d.max), ' |', String(r.calls).padStart(8), String(Math.round(r.out / 1024)).padStart(9));

// Raw cost of parsing the upstream bodies, the dominant term, including the >1 MB one the guard rejects.
console.log('\nJSON.parse alone (median of 20):');
for (const [url, {body}] of Object.entries(responses).filter(([u]) => u.includes('/plan?')).sort((a, b) => a[1].body.length - b[1].body.length)) {
  const t = []; for (let i = 0; i < 20; i++) { const s = performance.now(); JSON.parse(body); t.push(performance.now() - s); }
  console.log(`  ${String(Math.round(body.length / 1024)).padStart(5)} KB  ${f(stats(t).p50)} ms${body.length > 1e6 ? '  (rejected by the 1 MB guard today)' : ''}`);
}

// seat61: decode a whole country page (cp1252) and split it into sections, the work seat61.py does.
const page = readFileSync(new URL('./fixtures/seat61-France.htm', import.meta.url));
const t = []; let count = 0;
for (let i = 0; i < 20; i++) { const s = performance.now(); count = sections(page).length; t.push(performance.now() - s); }
console.log(`\nseat61 France.htm (${Math.round(page.length / 1024)} KB, ${count} sections): p50 ${f(stats(t).p50)} ms, max ${f(stats(t).max)} ms`);
const { find } = await import('./seat61.js');
for (const term of [undefined, 'Lyon', 'sleeper']) {
  const t2 = []; let r;
  for (let i = 0; i < 20; i++) { const s = performance.now(); r = find(page, term); t2.push(performance.now() - s); }
  console.log(`seat61 headings-only split${term ? `, find '${term}'` : ''} (${r.matches.length} matching sections): p50 ${f(stats(t2).p50)} ms, max ${f(stats(t2).max)} ms`);
}
