# Transitous MCP

Standalone, read-only journey research MCP, ready to host on a Cloudflare Worker.
Standard Streamable HTTP at `/mcp`; a bundled stdio bridge supports desktop
clients. No Site, plugin wrapper, planner checkout or Python runtime is needed.

The research modules can be reused under the MIT licence.

`register.js` is the SDK tool/resource registration shared with the standalone
server. `protocol.js` is the SDK-free stateless research transport, promoted
from the CPU experiment, including departure
boards, bounded request reads and guarded tool dispatch. Its host must perform
authentication and authorization first. The standalone Worker's existing SDK
and auth paths remain in place. Embedding hosts supply their own authentication.

The default User-Agent points at this repository:
`transitous-mcp/0.1.0 (+https://github.com/mattmalcher/transitous-mcp)`.
Before making the repository public, review its fixtures and history; the
User-Agent URL alone does not make a private repository accessible.

## Tools

- `find_stations`: up to eight stop/place matches, IDs, coordinates and timezones.
- `plan_journey`: up to six alternatives, depart-after or arrive-by, optional
  direct routes and a transfer limit. Names resolve to coordinates, avoiding a
  route anchored to the wrong bus stop. The response includes selected places
  and alternative matches so ambiguity is visible.
- `station_departures`: up to twenty departures for a STOP ID from station lookup.

All time inputs require an ISO timestamp with an explicit UTC offset or `Z`,
e.g. `2026-10-10T08:00:00+01:00`. Time outputs retain the API's UTC timestamps
and place timezones where supplied. Interpret local dates using those timezones.
Arrival searches take the offset of the arrival deadline, not the origin.

Responses retain route display names, train numbers, operators, walking/coach
legs, scheduled/current platforms, cancellation information and source/retrieval
metadata where supplied. Geometry, intermediate stops and large raw responses
are omitted. These are feed-based findings: verify transfer minima, check-in,
fares, disruption and availability against operators before committing travel.
No results does not prove no service exists. `transitous://guide` and MCP server
instructions explain these research rules. This MVP does not perform operator
verification or modify itineraries.

## Develop and verify

Node 20+ and a Cloudflare account with Workers/Durable Objects support.

```sh
npm ci
npm run check
```

`check` runs offline fictional-fixture tests (including an SDK HTTP client and
a desktop stdio bridge round trip) and a Wrangler dry-run bundle. Tests never
call Transitous. The bridge test binds an ephemeral loopback port.

For local work, create an ignored `.dev.vars` containing a random development
`MCP_TOKEN`, then run `npm run dev`. The endpoint is printed by Wrangler.
Never commit `.dev.vars`, client credentials, real journey outputs or caches.

With `TRANSITOUS_MCP_URL` and `TRANSITOUS_MCP_TOKEN` set, `npm run smoke`
checks MCP initialization, discovery, guide access and validation without any
upstream call. `npm run smoke -- --live-lookup` additionally makes one station
lookup and checks its cached repeat. The actual local workerd runtime passed
both checks during implementation. Live routing/departure results and deployment
in a Cloudflare account remain to be smoke-tested; offline fixtures cover those
operations without imposing routing load on Transitous.

## Deploy

The Worker requires at least one door secret, a contact-bearing
`TRANSITOUS_USER_AGENT` and its Durable Object binding. All MCP connections
require authentication, and each door is closed unless its secret is set.

| Door | Secret | Used by | Access |
|---|---|---|---|
| Direct | `MCP_TOKEN` | Claude Code, Codex, desktop bridge | The token is the identity. |
| Site | `SITE_TOKEN` and `ALLOWED_USER_IDS` | A ChatGPT Site bridge that relays the Sites-verified user in `Travel-Site-User` | Discovery needs the token only. Any other call needs the user to be in the comma-separated allowlist. |

1. Review `wrangler.jsonc`: Worker name and your public contact URL in
   `TRANSITOUS_USER_AGENT`. A source repository URL is preferable once published.
2. Authenticate Wrangler with `npx wrangler login` if required.
3. Set secrets **before** deploying code that enforces them:
   `npx wrangler secret put MCP_TOKEN`, and for a Site
   `npx wrangler secret put SITE_TOKEN` and `npx wrangler secret put ALLOWED_USER_IDS`.
   Use different random values for the two tokens.
4. Run `npm run deploy`. Use the printed `https://…workers.dev/mcp` endpoint.

Missing or incorrect tokens get 401. With neither `MCP_TOKEN` nor `SITE_TOKEN`
set (or blank), or with both set to the same value, `/mcp` returns 503 without
handling MCP requests or contacting upstream. Equal values are refused because
the direct door would otherwise bypass the Site allowlist. A Site token with an
empty or missing allowlist still answers discovery but refuses every other call
(403). The public `/` metadata endpoint remains available. Rotate a token with
the secret command; deleting it closes that door. To find a ChatGPT user ID for
`ALLOWED_USER_IDS`, call from the Site once and read the refusal in
`npx wrangler tail` (an ID is not a secret). There are no accounts or OAuth
login on the Worker; a Site provides the ChatGPT-facing login.
The endpoint is designed for direct MCP clients, a desktop bridge and a Site
bridge; native Claude web/mobile connector installation remains unverified.
No CORS/browser origins are enabled. No legacy SSE endpoint is provided.

## Connect a desktop client (including Claude Desktop)

Install dependencies locally and configure a standard stdio MCP entry using
absolute paths on that machine. For example:

```json
{
  "mcpServers": {
    "transitous": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/transitous_mcp/src/stdio.js"],
      "env": {
        "TRANSITOUS_MCP_URL": "https://YOUR-WORKER.workers.dev/mcp",
        "TRANSITOUS_MCP_TOKEN": "YOUR-SECRET-TOKEN"
      }
    }
  }
}
```

Set `TRANSITOUS_MCP_TOKEN` to the Worker secret in the client environment
and keep that configuration private. The bridge forwards tools and resources
to the Worker; it never routes against Transitous independently. HTTPS is
required except for loopback development. stdout contains MCP messages only.
The protocol bridge is tested; installation in the actual desktop applications
remains a manual smoke check after deployment.

## Connect Claude Code / other HTTP clients

Connect Claude Code with the Worker token:

```sh
claude mcp add --transport http transitous https://YOUR-WORKER.workers.dev/mcp --header 'Authorization: Bearer YOUR-SECRET-TOKEN'
```

Keep the token in private client configuration. Other Streamable HTTP clients
can use the same URL.
See [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).

Try: “Find stations matching Fictional Town”, then “Compare four journeys
between these coordinates, departing after this timestamp” or “Find the last
connection that arrives before this timestamp”. Supply real places only in your
private client session, not fixtures or committed logs.

## Upstream load, caching and data

A singleton SQLite Durable Object serializes upstream requests across all
Worker isolates, spaces starts at least one second apart, caps upstream misses
at thirty per minute and 200 per UTC calendar day, and limits its active queue
to eight requests. These limits are shared by everyone, including authenticated
clients. Failed upstream attempts count; cache hits do not. Exhausting the daily
budget blocks fresh lookups until midnight UTC while cached queries still work. Responses
are cached for 24 hours (journeys/lookups) or 60 seconds (departure boards).
Cached results preserve their original retrieval time and explicitly report
`cached: true`. Journey responses can therefore be stale for a day; check a
short-lived board or the operator for current conditions.

At most 64 raw upstream responses are stored; each is capped at 1 MB before
storage. Alarms remove expired entries. The cache is shared across all callers and may contain searched names/coordinates, so it belongs in
your own Cloudflare account. It stores no itinerary documents or credentials.
Worker observability is disabled by default; tool errors do not include raw
upstream bodies. Cloudflare infrastructure may retain platform metadata.

Transitous requires open-source, non-commercial use, request identification,
source attribution and modest load. Light prototype testing is allowed before
publication. This source carries the MIT licence; publish it before
regular use, and follow its requirement to contact the operators before routing
or substantial load. Tool schemas bound query sizes and do not expose arbitrary upstream URLs or bulk
operations. Authenticated clients can still automate allowed calls, exhaust the
shared budget or generate Worker traffic; these controls cap upstream load, not
Cloudflare costs or denial of service. There is no automatic retry loop here.
See [Transitous API policy](https://transitous.org/api/).

Attribution: [Transitous sources](https://transitous.org/sources/) and
[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

## Architecture and later wrapper

`research.js` contains the portable research operations; `mcp.js` describes the
MCP tools; `worker.js` handles authentication/transport; `gateway.js` coordinates
upstream caching/load; `stdio.js` connects a desktop stdio host to remote HTTP.
The installed MCP SDK uses a Workers-compatible schema validator rather than
runtime code generation. API endpoints follow the published MOTIS 2.10.2 schema:
`v1/geocode`, `v6/plan`, `v6/stoptimes`. Version 6 has correct zero-transfer
semantics.

Embedding applications can proxy the tools with their own authentication.

References: [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/),
[MOTIS API schema](https://github.com/motis-project/motis/blob/v2.10.2/openapi.yaml).
