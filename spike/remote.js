// Drives the deployed transitous-cpu-spike Worker so CPU per invocation can be read from Workers Logs.
// About 25 polite upstream requests in total (the DO spaces them 1 s apart). Generic route, not a real trip.
// Run: SPIKE_URL=https://transitous-cpu-spike.<subdomain>.workers.dev SPIKE_TOKEN=... node spike/remote.js
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ROUTE, LONG, TIME, BOARD_STOP_TEXT} from './route.js';
const base = process.env.SPIKE_URL, token = process.env.SPIKE_TOKEN;
if (!base || !token) throw new Error('Set SPIKE_URL and SPIKE_TOKEN');
const connect = async path => {
  const client = new Client({name: 'cpu-spike', version: '0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(path, base), {requestInit: {headers: {Authorization: `Bearer ${token}`}}}));
  return client;
};
const mcp = await connect('/mcp'), route = await connect('/route');
async function call(client, label, name, args) {
  const start = Date.now();
  const result = await client.callTool({name, arguments: args}, undefined, {timeout: 120000});
  const text = result.content?.[0]?.text || '';
  console.log(`${new Date().toISOString()}  ${label.padEnd(36)} ${result.isError ? 'ERROR ' + text.slice(0, 120) : `ok ${Math.round(text.length / 1024)} KB`}  ${Date.now() - start} ms wall`);
  return result;
}
// SPIKE_SHIFT moves every query by whole hours, so a second run misses the plan cache.
const shift = Number(process.env.SPIKE_SHIFT || 0);
const later = hours => new Date(Date.parse(TIME) + (hours + shift) * 3600000).toISOString().replace('.000Z', 'Z');
const board = await call(mcp, 'find_stations', 'find_stations', {text: BOARD_STOP_TEXT, limit: 8});
await call(mcp, 'find_stations (cached)', 'find_stations', {text: BOARD_STOP_TEXT, limit: 8});
for (let i = 0; i + 1 < ROUTE.length; i++) await call(mcp, `plan_journey leg ${i + 1}`, 'plan_journey', {from: ROUTE[i], to: ROUTE[i + 1], time: later(0), limit: 6});
await call(mcp, 'plan_journey leg 4 (cached)', 'plan_journey', {from: ROUTE[3], to: ROUTE[4], time: later(0), limit: 6});
await call(mcp, 'plan_journey long Paris-Wien', 'plan_journey', {from: LONG[0], to: LONG[1], time: later(0), limit: 6});
const stopId = board.structuredContent.matches.find(m => m.type === 'STOP').id;
await call(mcp, 'station_departures n=20', 'station_departures', {stop_id: stopId, time: later(0), limit: 20});
for (const hours of [0, 2, 4]) {
  await call(route, `plan_route 5 legs +${hours}h`, 'plan_route', {stops: ROUTE, time: later(hours), limit: 6});
  await call(route, `plan_route 5 legs +${hours}h (cached)`, 'plan_route', {stops: ROUTE, time: later(hours), limit: 6});
}
await mcp.close(); await route.close();
