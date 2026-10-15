// Two doors to one server, each with its own secret, both closed unless configured:
//  - direct: `Authorization: Bearer <MCP_TOKEN>` from agents and desktop clients. The token is the identity.
//  - site:   `Authorization: Bearer <SITE_TOKEN>` from a ChatGPT Site bridge, which also relays the
//            Sites-verified user in USER_HEADER. Discovery needs only the token; anything else needs the
//            user to be in ALLOWED_USER_IDS.
// With neither secret set the server answers 503. Equal secrets are refused, since the direct door would
// otherwise bypass the site door's allowlist.
export const USER_HEADER = 'Travel-Site-User';
const discovery = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list']);
const secret = value => typeof value === 'string' && value.trim() ? value : null;
const digest = async value => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
async function sameSecret(actual, expected) {
  const [a, b] = await Promise.all([digest(actual), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
/** {door: 'direct' | 'site'} when the bearer token is valid, otherwise {refusal: Response}. */
export async function authenticate(request, env) {
  const direct = secret(env.MCP_TOKEN), site = secret(env.SITE_TOKEN);
  if ((!direct && !site) || direct === site) return {refusal: new Response('Server is not configured', {status: 503})};
  const header = request.headers.get('Authorization') || '';
  const [isDirect, isSite] = await Promise.all([
    direct ? sameSecret(header, `Bearer ${direct}`) : false,
    site ? sameSecret(header, `Bearer ${site}`) : false,
  ]);
  if (isDirect) return {door: 'direct'};
  if (isSite) return {door: 'site'};
  return {refusal: new Response('Unauthorized', {status: 401, headers: {'WWW-Authenticate': 'Bearer'}})};
}
/** Site door, after the body is read: null when allowed, otherwise the refusal. Unparseable bodies and batches are not discovery. */
export function checkSiteUser(request, env, body) {
  let method;
  try { method = JSON.parse(new TextDecoder().decode(body)).method; } catch { method = undefined; }
  if (typeof method === 'string' && (discovery.has(method) || method.startsWith('notifications/'))) return null;
  const user = request.headers.get(USER_HEADER);
  const allowed = (env.ALLOWED_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  if (user && allowed.includes(user)) return null;
  console.log(`Site user not allowlisted: ${user || '(none)'}`); // an ID is not a secret; lets the owner find theirs with wrangler tail
  return new Response('This account is not allowed to use this server', {status: 403});
}
