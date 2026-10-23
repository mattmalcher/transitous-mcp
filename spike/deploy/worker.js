// Throwaway entry for the deployed CPU check: the real Worker plus the plan_route prototype from
// measure.js. Deployed only as transitous-cpu-spike, then deleted. Never deploy as transitous-mcp.
import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {z} from 'zod';
import worker from '../../src/worker.js';
import {makeMcp} from '../../src/mcp.js';
import {Research} from '../../src/research.js';
import {gatewayGet} from '../../src/gateway.js';
import {authenticate} from '../../src/auth.js';
export {TransitousGateway} from '../../src/gateway.js';
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/route') return worker.fetch(request, env);
    const {door, refusal} = await authenticate(request, env);
    if (refusal) return refusal;
    if (door !== 'direct' || request.method !== 'POST') return new Response('Not found', {status: 404});
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
  },
};
