# Performance findings

Measurements from October 2026 informed the current research modules and their
suitability for Cloudflare Workers Free. These are historical observations,
not guarantees about every deployment or workload.

## Keep upstream data small

Raw journey responses can contain hundreds of kilobytes of geometry and
intermediate stops that the tools do not use. `compactPlan` in
`src/research.js` removes those fields inside the Durable Object before caching
and returning the result. This avoids repeatedly parsing and transferring the
full upstream response.

A long journey response exceeded the original 1 MB raw-response guard. The
current gateway allows plan bodies up to 5,000,000 characters before parsing,
then caps the serialized compacted reply at 1,000,000 characters. Other
upstream bodies retain the smaller raw limit.

## Multi-leg routes need bounded output and a lean transport

A five-leg synthetic route was used to compare three implementations deployed
as temporary Workers. Each stop was resolved once in the lean variants, with
three itineraries per leg, a compact line per journey leg, and shared source
metadata and caveats.

| Implementation | Typical reply size | Cached route CPU, median / maximum | First pass CPU, maximum |
|---|---|---|---|
| Original SDK prototype, six itineraries per leg | 230–280 KB | 15 / 25 ms | 26.9 ms |
| Compact route output with SDK | 25–30 KB | 10 / 19 ms | 21.6 ms |
| Compact route output without SDK | 25–30 KB | 5 / 8 ms | 9.9 ms |

The cached comparison used twelve route calls per implementation. The first
pass included cache misses and fresh isolates. Cached Durable Object calls
were 0–2 ms. All observed invocations completed successfully.

Compact output roughly halved route CPU cost; combining it with an SDK-free
handler provided more margin against the 10 ms Free-plan CPU budget used in
these experiments. The reusable route logic and view are in `src/research.js`;
`src/protocol.js` provides the lean transport. The standalone Worker retains
its SDK transport and exposes the three single-query tools, not `plan_route`.

## Measure on the deployed runtime

Local in-process timings understated deployed CPU costs by about five times
in the initial comparison. Lazy compilation and cold isolates also affected
results. Local timings are useful for comparing implementations, but deployment
measurements are needed to assess CPU headroom. Successful individual calls
above a nominal budget do not establish that sustained overruns will work.

Keep query counts and output sizes bounded, measure both cold and cached calls,
and retain upstream rate limits while testing.

## Route semantics remain provisional

`Research.route` plans each consecutive leg using the same requested start
time. It does not chain the next departure after the preceding arrival.
Connections must therefore be checked separately; the result is research
material rather than a validated end-to-end itinerary.
