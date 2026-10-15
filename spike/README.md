# Spike: can research tools fit the Workers Free 10 ms CPU limit?

Branch `spike/cpu-budget`, 15 October 2026. Local only: nothing was deployed, and
the live `transitous-mcp` Worker is untouched.

## Method

- `record.js` made 14 polite live requests through the real gateway code (1 req/s,
  User-Agent), plus one seat61 page, and saved them to `fixtures/`. The route is a
  generic five-leg Paris → Lyon → Genève → Zürich → München → Wien rail trip, not
  a real one. The seat61 page isn't committed, because it is third-party
  content. `record.js` fetches it again locally.
- `measure.js` replays those responses through the real Worker `fetch` handler
  (auth, MCP SDK, zod) and the real `TransitousGateway` Durable Object class,
  in-process. All I/O resolves immediately, so busy wall time on the JS thread
  approximates CPU. The Worker and the DO are timed separately, because in
  production each is its own invocation with its own 10 ms budget.
- `plan_route` is a minimal prototype of the planned composite tool: resolve
  every stop and plan every leg in one Worker invocation (15 DO calls).
- Results are in `results-baseline.txt` (code as it is) and
  `results-trimmed.txt` (with the change below).

## Results

Measured on an i5-12600K (up to 4.9 GHz), Node 24, 30 runs per scenario, p95 in ms:

| Scenario | Worker, as is | Worker, trimmed | DO per call, as is | DO per call, trimmed |
|---|---|---|---|---|
| `find_stations` | 1.4 | 1.5 | 0.6 | 0.6 |
| `plan_journey`, worst leg (533 KB upstream) | 3.3 | 2.0 | 4.9 | 2.7 |
| `plan_journey`, worst leg, cached | 3.4 | 1.9 | 3.1 | 0.5 |
| `station_departures`, n=20 | 1.4 | 1.3 | 0.9 | 0.8 |
| `plan_route`, 5 legs | **8.8** (max 10.1) | **3.6** | 5.3 | 2.3 |
| `plan_route`, 5 legs, cached | 7.9 | 3.7 | 3.0 | 0.5 |

| seat61 France page (837 KB) | p50 | max |
|---|---|---|
| Clean every section (as `seat61.py` does) | 5.6 | 9.0 |
| Split on headings only | 1.8 | 2.7 |
| Split on headings, clean only sections matching "Lyon" (54 of 287) | 3.8 | 4.7 |

## Findings

1. **The size of Transitous plan responses is the main cost.** They're
   250–530 KB per leg, mostly `legGeometry` polylines and `intermediateStops`,
   which the tools throw away. As is, the DO parses each body, caches it whole
   and sends it to the Worker, which parses it again.
2. **Trimming in the DO fixes it.** `compactPlan` in `src/research.js` keeps
   only the fields the tools return, and the DO applies it before caching
   (`src/gateway.js`). The 5-leg `plan_route` drops from about 8.8 ms to
   3.6 ms in the Worker, and a cached DO hit from about 3 ms to 0.5 ms. The 22
   existing tests still pass.
3. **seat61 needs the cheaper parse.** Cleaning a whole country page is too
   close to the limit. Split on headings, clean only the requested sections and
   cap their number. `windows-1252` decoding works in workerd (checked locally
   with `wrangler dev` in `workerd/`, never deployed).
4. **The 1 MB response guard rejects a long query.** A direct Paris → Wien
   plan came back at 1.35 MB and failed. With trimming in the DO, parsing that
   costs about 2 ms, so the guard could be raised, or applied after trimming.
5. **Cold isolates are the big unknown.** The very first call in a fresh
   process took about 44 ms, mostly lazy compilation of the MCP SDK and zod.
   It can't be judged locally how much of that Cloudflare charges to a cold
   isolate's first request. `travel_plugin` already runs on Free with the same
   SDK, which is encouraging.

## Verdict

**Viable on Free, with the DO trimming change**, for Transitous including
`plan_route`, and for seat61 with the cheaper parse. The margins are about 2.5–5×
on this machine. Cloudflare's servers are likely slower per core than this
desktop, so the margin in production is smaller. That's acceptable but not
generous for `plan_route`. Keep it to 5 legs and a few itineraries per leg.

Not tested: D1 FTS lookups for stations. The query runs in D1, so the Worker
should mostly be waiting on I/O, but this is unmeasured.

## The definitive check (needs a deploy)

Deploy this branch under a **different name** (for example
`transitous-cpu-spike`) so the live `transitous-mcp` is unaffected. Give it its
own `MCP_TOKEN`, so it fails closed. Turn on observability, run the five-leg
route a few times, then read CPU time per invocation in Workers Logs, including
cold starts. Delete the Worker afterwards.
