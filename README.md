# Transitous MCP

A basic MCP shim for [Transitous](https://transitous.org/), exposing station
search, journey planning and departure boards to AI assistants.

The goal is to make it easier for more people to use public transport when travelling.
This is an independent project, not affiliated with or endorsed by Transitous.

**Transitous:** [Website](https://transitous.org/) ·
[Terms and usage policy](https://transitous.org/api/#usage-policy) ·
[Matrix chat](https://matrix.to/#/%23transitous:matrix.spline.de) ·
[GitHub](https://github.com/public-transport/transitous) ·
[Data sources and attribution](https://transitous.org/sources/)

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

## Hosting

Run locally with Wrangler (see [Develop and verify](#develop-and-verify)), or
deploy your own instance in your own Cloudflare account. Designed to fit within
Cloudflare Workers Free limits; this project does not provide a shared hosted
endpoint. See [PERFORMANCE.md](PERFORMANCE.md) for measurements and design choices.

## Before deploying

To follow [Transitous's usage policy](https://transitous.org/api/#usage-policy):

- Publish the code you deploy, including any changes, and keep the MIT licence
  notice. Light prototype testing before publication is fine.
- Keep your use of the Transitous API non-commercial.
- Contact Transitous in its [Matrix channel](https://matrix.to/#/%23transitous:matrix.spline.de)
  before routing or other potentially resource-intensive use. The limits below
  do not replace this requirement.
- Set `TRANSITOUS_USER_AGENT` with the application name, version and your own
  contact URL or email.
- Ensure your client visibly links to [Transitous sources](https://transitous.org/sources/)
  and credits [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright).
  Follow any additional conditions from the data sources.

## Upstream load and caching

Transitous is an open, volunteer-run project providing shared public transport
infrastructure. We aim to respect its resources by keeping requests modest,
reusing cached results and avoiding bulk queries or automatic retries.

One SQLite Durable Object enforces these limits across all clients:

| Limit | Value |
|---|---|
| Upstream request spacing | At least 1 second |
| Upstream attempts | 30/minute; 200/UTC day |
| Active queue | 8 requests |
| Journey/station lookup cache | 24 hours |
| Departure board cache | 60 seconds |
| Cache storage | 64 responses, up to 1 MB each |

Failed attempts count; cache hits do not. At the daily limit, only cached
queries work until midnight UTC. Cached results retain their retrieval time
and report `cached: true`. Check boards or operators for current conditions.
Expired entries are removed by alarms.

Tool schemas bound query sizes and do not expose arbitrary upstream URLs.
Authenticated clients can still exhaust the shared budget or generate Worker
traffic; these controls cap upstream load, not Cloudflare costs or denial of service.

## Develop and verify

Node 20+ and a Cloudflare account with Workers/Durable Objects support.

```sh
npm ci
npm run check
```

`check` runs offline fixture tests, HTTP/stdio integration tests and a Wrangler
dry-run bundle. It never calls Transitous; the bridge test uses a loopback port.

For local development, put a random `MCP_TOKEN` in an ignored `.dev.vars`, then
run `npm run dev`. Wrangler prints the endpoint. Keep credentials, real journey
outputs and caches out of version control.

Set `TRANSITOUS_MCP_URL` and `TRANSITOUS_MCP_TOKEN`, then run:

- `npm run smoke`: checks initialization, discovery, guide access and validation
  without upstream calls.
- `npm run smoke -- --live-lookup`: also checks one station lookup and its cache.

Both passed locally under workerd. Deployed routing and departure boards still
need a live smoke test.

## Data and privacy

The shared cache can contain searched names and coordinates; host it in your
own Cloudflare account.
Worker observability is off by default, and errors omit raw upstream bodies.
Cloudflare may retain platform metadata.

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

Authentication failures:

- Missing or incorrect token: 401.
- Neither token configured, or both tokens identical: 503; no upstream calls.
- Site user absent from `ALLOWED_USER_IDS`: 403, except for discovery.

Use distinct tokens to prevent direct access bypassing the Site allowlist.
Rotate or delete a secret with Wrangler to change or close access. To find a
Site user's ID, make a refused call and inspect `npx wrangler tail`.

The public `/` endpoint serves metadata. The Worker has no accounts or OAuth;
the Site handles ChatGPT login. Direct HTTP, desktop and Site bridges are
supported; native Claude web/mobile installation is unverified. There is no
browser CORS access or legacy SSE endpoint.

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

Use the Worker's `MCP_TOKEN` and keep the client configuration private. The
bridge forwards tools and resources over HTTPS (HTTP is allowed for loopback
development). stdout is reserved for MCP messages. Bridge tests pass;
installation in desktop applications still needs a manual check.

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

## Reuse the research modules

The MIT-licensed modules can be embedded in other hosts:

| Module | Role |
|---|---|
| `src/research.js` | Research queries |
| `src/gateway.js` | Shared cache and upstream rate limits |
| `src/register.js` | MCP SDK tool/resource registration |
| `src/protocol.js` | Stateless, SDK-free transport with bounded reads and guarded dispatch |

Embedding hosts must authenticate and authorize requests before passing research
queries and the upstream binding to these modules. When vendoring, include the
licence and record the source commit and file hashes. Maintain fixes here and
run `npm run check` before pushing.

The default upstream User-Agent identifies this repository:
`transitous-mcp/0.1.0 (+https://github.com/mattmalcher/transitous-mcp)`.
See [PERFORMANCE.md](PERFORMANCE.md) for CPU measurements and design choices.

## Architecture

`mcp.js` defines the tools, `worker.js` handles authentication and HTTP transport,
and `stdio.js` bridges desktop clients to the Worker. The MCP SDK uses a
Workers-compatible schema validator without runtime code generation.

Upstream calls follow MOTIS 2.10.2: `v1/geocode`, `v6/plan` and `v6/stoptimes`.
Version 6 supports correct zero-transfer semantics.

References: [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/),
[MOTIS API schema](https://github.com/motis-project/motis/blob/v2.10.2/openapi.yaml).
