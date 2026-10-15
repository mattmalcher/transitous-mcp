// Records real upstream responses once, politely, so CPU measurements can replay them offline.
// Goes through the real TransitousGateway (1 req/s spacing, User-Agent) with in-memory storage.
// Generic fictional route; no real trip data. Run: node spike/record.js
import {writeFileSync, mkdirSync} from 'node:fs';
import {TransitousGateway} from '../src/gateway.js';
import {Research} from '../src/research.js';
import {ROUTE, TIME, LONG, BOARD_STOP_TEXT} from './route.js';

const dir = new URL('./fixtures/', import.meta.url);
mkdirSync(dir, {recursive: true});
const recorded = {};
const values = new Map();
const storage = {
  async get(k) { return structuredClone(values.get(k)); },
  async put(k, v) { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) values.set(a, structuredClone(b)); else values.set(k, structuredClone(v)); },
  async getAlarm() {}, async setAlarm() {}, async delete(k) { values.delete(k); },
};
const gateway = new TransitousGateway({storage}, {TRANSITOUS_USER_AGENT: 'transitous-mcp-cpu-spike/0.1 (+https://github.com/mattmalcher)'}, {
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    const body = await response.text();
    recorded[String(url)] = {status: response.status, body};
    writeFileSync(new URL('transitous.json', dir), JSON.stringify({responses: recorded}));
    console.log(response.status, String(url).slice(0, 110), `${(body.length / 1024).toFixed(0)} KB`);
    return new Response(body, {status: response.status});
  },
});
const get = async (path, params) => {
  const r = await gateway.fetch(new Request('https://internal/query', {method: 'POST', body: JSON.stringify({path, params})}));
  const reply = await r.json();
  if (!r.ok) throw new Error(reply.error);
  return reply;
};
const research = new Research(get);
for (let i = 0; i + 1 < ROUTE.length; i++) await research.plan({from: ROUTE[i], to: ROUTE[i + 1], time: TIME, limit: 6});
// The production guard rejects responses over 1 MB; keep the raw body anyway as a size data point.
await research.plan({from: LONG[0], to: LONG[1], time: TIME, limit: 6}).catch(e => console.log('rejected by gateway:', e.message));
const board = await research.stations(BOARD_STOP_TEXT, 1);
const stopId = board.matches[0].id;
await research.departures({stop_id: stopId, time: TIME, limit: 20});
writeFileSync(new URL('transitous.json', dir), JSON.stringify({stopId, responses: recorded}));

// One seat61 country page (the largest kind, 200-850 KB) for the text-extraction estimate.
const seat61 = await fetch('https://www.seat61.com/France.htm', {headers: {'User-Agent': 'transitous-mcp-cpu-spike/0.1 (+https://github.com/mattmalcher)'}});
writeFileSync(new URL('seat61-France.htm', dir), Buffer.from(await seat61.arrayBuffer()));
console.log(seat61.status, 'seat61 France.htm');
