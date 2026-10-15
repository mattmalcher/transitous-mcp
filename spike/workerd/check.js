// Local-only workerd check (wrangler dev, never deployed): is windows-1252 decoding available?
import {find} from '../seat61.js';
export default { async fetch(req) {
  let decoder; try { new TextDecoder('windows-1252'); decoder = 'windows-1252 supported'; } catch (e) { decoder = 'windows-1252 NOT supported: ' + e.message; }
  if (req.method !== 'POST') return Response.json({decoder});
  const r = find(new Uint8Array(await req.arrayBuffer()), 'Lyon');
  return Response.json({decoder, headings: r.headings.length, matches: r.matches.length, sample: r.matches[0]?.[1].slice(0, 120)});
}};
