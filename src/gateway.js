import { compactPlan } from './research.js';
const API = 'https://api.transitous.org/api/';
const endpoints = {geocode: 'v1/geocode', plan: 'v6/plan', stoptimes: 'v6/stoptimes'};
const allowed = new Set(['geocode', 'plan', 'stoptimes']);
export class TransitousGateway {
  constructor(state, env, dependencies = {}) {
    this.storage = state.storage;
    this.env = env;
    this.fetchUpstream = dependencies.fetch || globalThis.fetch.bind(globalThis);
    this.sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = dependencies.now || Date.now;
    this.queue = Promise.resolve();
    this.pending = 0;
  }
  async fetch(request) {
    if (this.pending >= 8) return Response.json({error: 'Research queue is busy; retry shortly'}, {status: 429});
    this.pending++;
    const result = this.queue.then(() => this.run(request));
    this.queue = result.catch(() => {});
    try { return await result; }
    catch { return Response.json({error: 'Transitous is unavailable; try again later'}, {status: 502}); }
    finally { this.pending--; }
  }
  async alarm() {
    const work = this.queue.then(async () => {
      const keys = await this.storage.get('keys') || [];
      const retained = [];
      let next = Infinity;
      for (const key of keys) {
        const entry = await this.storage.get(key);
        if (!entry || entry.expires <= this.now()) await this.storage.delete(key);
        else { retained.push(key); next = Math.min(next, entry.expires); }
      }
      await this.storage.put('keys', retained);
      if (Number.isFinite(next)) await this.storage.setAlarm(next);
    });
    this.queue = work.catch(() => {});
    await work;
  }
  async run(request) {
    const {path, params} = await request.json();
    if (!allowed.has(path)) return Response.json({error: 'Unsupported upstream endpoint'}, {status: 400});
    const url = new URL(endpoints[path], API);
    for (const [key, value] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
    const key = `cache:${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')}`;
    const cached = await this.storage.get(key);
    if (cached && cached.expires > this.now()) return Response.json({...cached.reply, cached: true});
    // Singleton queue coordinates all Worker isolates and persists its last request time.
    const last = await this.storage.get('last') || 0;
    await this.sleep(Math.max(0, 1000 - (this.now() - last)));
    const now = this.now(), window = Math.floor(now / 60000);
    const quota = await this.storage.get('quota') || {window, count: 0};
    if (quota.window !== window) { quota.window = window; quota.count = 0; }
    if (quota.count >= 30) return Response.json({error: 'Upstream request budget reached; retry next minute'}, {status: 429});
    const day = Math.floor(now / 86400000);
    const daily = await this.storage.get('daily') || {day, count: 0};
    if (daily.day !== day) { daily.day = day; daily.count = 0; }
    if (daily.count >= 200) return Response.json({error: 'Shared daily upstream budget reached; retry after midnight UTC. Cached queries still work.'}, {status: 429});
    await this.storage.put({last: now, quota: {window, count: quota.count + 1}, daily: {day, count: daily.count + 1}});
    const response = await this.fetchUpstream(url, {headers: {'User-Agent': this.env.TRANSITOUS_USER_AGENT, Accept: 'application/json'}, signal: AbortSignal.timeout(20000)});
    if (!response.ok) return Response.json({error: `Transitous returned HTTP ${response.status}; try again later`}, {status: response.status === 429 ? 429 : 502});
    const body = await response.text();
    // Plan bodies are mostly polylines that compactPlan drops, so they get a larger raw allowance;
    // what is cached and sent to the Worker is capped at 1 MB either way.
    if (body.length > (path === 'plan' ? 5000000 : 1000000)) return Response.json({error: 'Transitous response too large; narrow your query'}, {status: 502});
    const parsed = JSON.parse(body);
    const reply = {data: path === 'plan' ? compactPlan(parsed) : parsed, retrieved_at: new Date(this.now()).toISOString(), cached: false};
    if (path === 'plan' && JSON.stringify(reply).length > 1000000) return Response.json({error: 'Transitous response too large; narrow your query'}, {status: 502});
    const keys = (await this.storage.get('keys') || []).filter(k => k !== key);
    keys.push(key);
    if (keys.length > 64) await this.storage.delete(keys.shift());
    const expires = this.now() + (path === 'stoptimes' ? 60000 : 86400000);
    await this.storage.put(key, {expires, reply});
    const alarm = await this.storage.getAlarm();
    if (!alarm || alarm > expires) await this.storage.setAlarm(expires);
    await this.storage.put('keys', keys);
    return Response.json(reply);
  }
}
export function gatewayGet(binding) {
  const stub = binding.get(binding.idFromName('shared-upstream'));
  return async (path, params) => {
    const response = await stub.fetch('https://transitous.internal/query', {method: 'POST', body: JSON.stringify({path, params})});
    const reply = await response.json();
    if (!response.ok) throw new Error(reply.error || 'Transitous request failed');
    return reply;
  };
}
