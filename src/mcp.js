import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { z } from 'zod';
import { instructions } from './research.js';
const text = z.string().trim().min(1).max(200);
const time = z.string().max(40).describe('ISO timestamp with explicit UTC offset or Z; never an unqualified local time.');
export function makeMcp(research) {
  const server = new McpServer({name: 'transitous-mcp', version: '0.1.0'}, {instructions, jsonSchemaValidator: new CfWorkerJsonSchemaValidator()});
  const register = (name, description, inputSchema, run) => server.registerTool(name, {description, inputSchema, annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true}}, async args => {
    try {
      const result = await run(args);
      return {content: [{type: 'text', text: JSON.stringify(result)}], structuredContent: result};
    } catch (error) {
      return {isError: true, content: [{type: 'text', text: error.message}]};
    }
  });
  register('find_stations', 'Find station/place candidates and coordinates. STOP matches first; inspect ambiguous names before choosing. Returns IDs for departure boards.', {text, limit: z.number().int().min(1).max(8).default(8)}, args => research.stations(args.text, args.limit));
  register('plan_journey', 'Research a few journey options, with train numbers, operators, platforms, walking and coach legs. Provisional: verify connections and availability with operators. Empty results are not proof of no service.', {from: text.describe('Name or latitude,longitude; inspect ambiguous names with find_stations.'), to: text, time, arrive_by: z.boolean().default(false), direct: z.boolean().default(false), max_transfers: z.number().int().min(0).max(6).optional(), limit: z.number().int().min(1).max(6).default(4)}, args => research.plan(args));
  register('station_departures', 'Departure board for an exact STOP ID from find_stations; do not pass coordinates or guess an ID. Platforms and real-time data where provided by the feed.', {stop_id: text, time, limit: z.number().int().min(1).max(20).default(10)}, args => research.departures(args));
  server.registerResource('research-guide', 'transitous://guide', {mimeType: 'text/plain', description: 'Journey research rules and limits'}, async uri => ({contents: [{uri: uri.href, mimeType: 'text/plain', text: instructions}]}));
  return server;
}
