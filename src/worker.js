import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { makeMcp } from './mcp.js';
import { Research } from './research.js';
import { gatewayGet } from './gateway.js';
export { TransitousGateway } from './gateway.js';
async function tokenMatches(actual, expected) {
  const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const a = new Uint8Array(await digest(actual)), b = new Uint8Array(await digest(expected));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') return Response.json({name: 'transitous-mcp', version: '0.1.0', endpoint: '/mcp', transport: 'Streamable HTTP', attribution: ['https://transitous.org/sources/', 'https://www.openstreetmap.org/copyright']});
    if (url.pathname !== '/mcp') return new Response('Not found', {status: 404});
    if (!env.TRANSITOUS_USER_AGENT || !env.TRANSITOUS) return new Response('Server is not configured', {status: 503});
    if (env.MCP_TOKEN && !await tokenMatches(request.headers.get('Authorization') || '', `Bearer ${env.MCP_TOKEN}`)) return new Response('Unauthorized', {status: 401, headers: {'WWW-Authenticate': 'Bearer'}});
    if (request.headers.has('Origin')) return new Response('Browser origins are not enabled; use an MCP client', {status: 403});
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST, GET, DELETE'}});
    if (request.method === 'POST') {
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
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      request = new Request(request.url, {method: 'POST', headers: request.headers, body});
    }
    const server = makeMcp(new Research(gatewayGet(env.TRANSITOUS)));
    const transport = new WebStandardStreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true});
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } catch {
      return new Response('MCP request failed', {status: 500});
    } finally {
      await server.close();
    }
  },
};
