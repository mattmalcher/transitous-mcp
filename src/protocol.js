// Shared stateless research protocol. Authentication belongs to the embedding host.
// No SDK, zod, Dropbox binding or trip store enters this module.
import {Research, instructions} from './research.js';
import {gatewayGet} from './gateway.js';


const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const time = {type: 'string', maxLength: 40, description: 'ISO timestamp with explicit UTC offset or Z; never an unqualified local time.'};
const text = {type: 'string', minLength: 1, maxLength: 200};
const annotations = {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true};
export const tools = [
  {name: 'find_stations', description: 'Find station/place candidates and coordinates. STOP matches first; inspect ambiguous names before choosing. Returns IDs for departure boards.', inputSchema: {type: 'object', properties: {text, limit: {type: 'integer', minimum: 1, maximum: 8, default: 8}}, required: ['text']}, annotations},
  {name: 'plan_journey', description: 'Research a few journey options, with train numbers, operators, platforms, walking and coach legs. Provisional: verify connections and availability with operators. Empty results are not proof of no service.', inputSchema: {type: 'object', properties: {from: {...text, description: 'Name or latitude,longitude; inspect ambiguous names with find_stations.'}, to: text, time, arrive_by: {type: 'boolean', default: false}, direct: {type: 'boolean', default: false}, max_transfers: {type: 'integer', minimum: 0, maximum: 6}, limit: {type: 'integer', minimum: 1, maximum: 6, default: 4}}, required: ['from', 'to', 'time']}, annotations},
  {name: 'station_departures', description: 'Departure board for an exact STOP ID from find_stations. Provisional feed data; verify with operators.', inputSchema: {type: 'object', properties: {stop_id: text, time, limit: {type: 'integer', minimum: 1, maximum: 20, default: 10}}, required: ['stop_id', 'time']}, annotations},
];
const toolList = JSON.stringify(tools); // serialised once per isolate

class Invalid extends Error {}
const str = (v, name, max = 200) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Invalid(`${name} must be a non-empty string of at most ${max} characters`); return v.trim(); };
const int = (v, name, min, max, fallback) => { if (v === undefined) return fallback; if (!Number.isInteger(v) || v < min || v > max) throw new Invalid(`${name} must be an integer from ${min} to ${max}`); return v; };
const bool = (v, name) => { if (v === undefined) return false; if (typeof v !== 'boolean') throw new Invalid(`${name} must be true or false`); return v; };
const run = {
  find_stations: (r, a) => r.stations(str(a.text, 'text'), int(a.limit, 'limit', 1, 8, 8)),
  plan_journey: (r, a) => r.plan({from: str(a.from, 'from'), to: str(a.to, 'to'), time: str(a.time, 'time', 40), arrive_by: bool(a.arrive_by, 'arrive_by'), direct: bool(a.direct, 'direct'), max_transfers: int(a.max_transfers, 'max_transfers', 0, 6, undefined), limit: int(a.limit, 'limit', 1, 6, 4)}),
  station_departures: (r, a) => r.departures({stop_id: str(a.stop_id, 'stop_id'), time: str(a.time, 'time', 40), limit: int(a.limit, 'limit', 1, 20, 10)}),
};
const reply = (id, body) => new Response(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},${body}}`, {headers: {'Content-Type': 'application/json'}});
const result = (id, value) => reply(id, `"result":${typeof value === 'string' ? value : JSON.stringify(value)}`);
const failure = (id, code, message) => reply(id ?? null, `"error":${JSON.stringify({code, message})}`);

export async function callResearch(binding, params) {
  const handler = Object.hasOwn(run, params?.name) ? run[params.name] : undefined;
  if (!handler) return {isError: true, content: [{type: 'text', text: `Unknown tool ${params?.name}`}]};
  try {
    const value = await handler(new Research(gatewayGet(binding)), params.arguments || {});
    return {content: [{type: 'text', text: JSON.stringify(value)}], structuredContent: value};
  } catch (error) {
    return {isError: true, content: [{type: 'text', text: error.message}]};
  }
}

// The host authenticates and authorizes before calling this transport.
export async function handleResearchMcp(request, binding, serverInfo = {name: 'transitous-mcp', version: '0.1.0'}) {
    if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST'}});
    const reader = request.body?.getReader();
    if (!reader) return new Response('Request body required', {status: 400});
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) { await reader.cancel(); return new Response('Request too large', {status: 413}); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = new TextDecoder().decode(bytes);
    let message;
    try { message = JSON.parse(body); } catch { return failure(null, -32700, 'Parse error'); }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(message?.id, -32600, 'Invalid request');
    if (message.id === undefined) return new Response(null, {status: 202}); // notifications
    const {id, method, params} = message;
    switch (method) {
      case 'initialize': return result(id, {protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0], capabilities: {tools: {listChanged: false}, resources: {listChanged: false}}, serverInfo, instructions});
      case 'ping': return result(id, {});
      case 'tools/list': return result(id, `{"tools":${toolList}}`);
      case 'tools/call': return result(id, await callResearch(binding, params));
      case 'resources/list': return result(id, {resources: [{uri: 'transitous://guide', name: 'research-guide', mimeType: 'text/plain', description: 'Journey research rules and limits'}]});
      case 'resources/read': return params?.uri === 'transitous://guide' ? result(id, {contents: [{uri: 'transitous://guide', mimeType: 'text/plain', text: instructions}]}) : failure(id, -32002, 'Resource not found');
      default: return failure(id, -32601, `Method not found: ${method}`);
    }
}
