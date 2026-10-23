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

const N = 300;
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
// Profiles the cached plan_route Worker path only (DO cache primed once).
const env = makeEnv();
await routeWorker.fetch(rpc('plan_route', {stops: ROUTE, time: TIME, limit: 6}), env).then(r => r.text());
const t0 = performance.now();
for (let i = 0; i < N; i++) await routeWorker.fetch(rpc('plan_route', {stops: ROUTE, time: TIME, limit: 6}), env).then(r => r.text());
console.log(`plan_route cached: ${((performance.now() - t0) / N).toFixed(2)} ms per call incl. DO`);
