export const instructions = `Research journeys with Transitous. Resolve ambiguous names with find_stations before planning; prefer coordinates for routes and a stop ID for departure boards. Always supply an ISO timestamp with Z or an explicit UTC offset; do not guess the timezone. For arrival deadlines use arrive_by. Keep searches to a few alternatives for the user's actual journey; never enumerate a network or sweep dates. Results are provisional feed-based findings, not tickets or proof of a bookable connection. Check operator sources for connection minima, disruptions, fares, berths and availability before finalising travel. No results does not prove no service exists. Coaches and walking legs must be explicit. Preserve source links and retrieval time.`;
export const caveats = [
  'Provisional aggregator results; verify with the operator before committing travel.',
  'Transfers are routing suggestions, not guarantees of through-ticketing or sufficient check-in time.',
  'No fares, ticket or berth availability. Feed gaps can omit valid journeys.',
];
export function timestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('time must be an ISO timestamp with Z or an explicit UTC offset, e.g. 2026-10-10T08:00:00+01:00');
  }
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days) throw new Error('time has an invalid calendar date');
  return new Date(value).toISOString();
}
export function coordinates(value) {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(value);
  if (!match) return null;
  const lat = Number(match[1]), lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Coordinates are outside latitude/longitude bounds');
  return `${lat},${lon}`;
}
const pick = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const stop = value => pick(value, ['name', 'stopId', 'lat', 'lon', 'tz', 'arrival', 'departure', 'scheduledArrival', 'scheduledDeparture', 'scheduledTrack', 'track', 'cancelled', 'alerts']);
const station = value => pick(value, ['id', 'name', 'type', 'lat', 'lon', 'tz']);
const leg = value => ({...pick(value, ['mode', 'startTime', 'endTime', 'scheduledStartTime', 'scheduledEndTime', 'duration', 'displayName', 'routeShortName', 'routeLongName', 'tripShortName', 'agencyName', 'agencyUrl', 'routeUrl', 'headsign', 'realTime', 'cancelled', 'alerts']), from: stop(value.from), to: stop(value.to)});
// Keeps only the fields the tools return. Run in the Durable Object so the large upstream body
// (polylines, intermediate stops) is parsed once and never cached or sent to the Worker.
export const compactPlan = data => ({itineraries: (data.itineraries || []).map(i => ({...pick(i, ['startTime', 'endTime', 'duration', 'transfers']), legs: (i.legs || []).map(leg)}))});
// Route view of a compacted plan: a few itineraries, one line of fields per leg. Also run in the
// Durable Object, so a multi-leg route sends the Worker a few KB per leg rather than tens.
const routeLeg = l => pick({mode: l.mode, from: l.from?.name, to: l.to?.name, departure: l.from?.departure ?? l.startTime, arrival: l.to?.arrival ?? l.endTime, line: l.displayName || l.routeShortName || l.tripShortName, agency: l.agencyName, headsign: l.headsign, track: l.from?.track ?? l.from?.scheduledTrack, cancelled: l.cancelled || undefined, realTime: l.realTime || undefined}, ['mode', 'from', 'to', 'departure', 'arrival', 'line', 'agency', 'headsign', 'track', 'cancelled', 'realTime']);
export const routePlan = (data, limit) => ({itineraries: (data.itineraries || []).slice(0, limit).map(i => ({...pick(i, ['startTime', 'endTime', 'duration', 'transfers']), legs: (i.legs || []).map(routeLeg)}))});
export class Research {
  constructor(get) { this.get = get; }
  async stations(text, limit = 8) {
    const reply = await this.get('geocode', {text});
    const hits = reply.data;
    if (!Array.isArray(hits)) throw new Error('Unexpected Transitous geocoder response');
    return {matches: [...hits.filter(h => h.type === 'STOP'), ...hits.filter(h => h.type !== 'STOP')].slice(0, limit).map(station), sources: [this.source(reply)]};
  }
  source(reply) {
    return {name: 'Transitous', url: 'https://transitous.org/sources/', attribution: '© OpenStreetMap contributors', attribution_url: 'https://www.openstreetmap.org/copyright', retrieved_at: reply.retrieved_at, cached: reply.cached};
  }
  async resolve(text) {
    const coords = coordinates(text);
    if (coords) return {place: coords, selected: {coordinates: coords}, sources: []};
    const result = await this.stations(text);
    if (!result.matches.length) throw new Error(`No match for ${text}; use find_stations or coordinates`);
    const selected = result.matches[0];
    if (!Number.isFinite(selected.lat) || !Number.isFinite(selected.lon)) throw new Error('Station has no usable coordinates');
    return {place: `${selected.lat},${selected.lon}`, selected, alternatives: result.matches.slice(1, 4), sources: result.sources};
  }
  async plan({from, to, time, arrive_by = false, direct = false, max_transfers, limit = 4}) {
    // Validate the time before issuing any upstream requests.
    const utc = timestamp(time);
    const origin = await this.resolve(from), destination = await this.resolve(to);
    const reply = await this.get('plan', {fromPlace: origin.place, toPlace: destination.place, time: utc, arriveBy: arrive_by ? 'true' : undefined, numItineraries: limit, maxTransfers: direct ? 0 : max_transfers});
    if (!Array.isArray(reply.data.itineraries)) throw new Error('Unexpected Transitous journey response');
    const itineraries = reply.data.itineraries.filter(i => !(direct || max_transfers === 0) || i.transfers === 0).slice(0, limit).map(i => ({...pick(i, ['startTime', 'endTime', 'duration', 'transfers']), legs: (i.legs || []).map(leg)}));
    return {origin, destination, query: {time: utc, arrive_by, direct: direct || max_transfers === 0}, itineraries, sources: [this.source(reply)], warnings: [...caveats, ...(!itineraries.length ? ['No matching itineraries; this can indicate a feed gap, not an impossible journey.'] : [])]};
  }
  // Plans consecutive legs between up to 6 stops. Each stop is resolved once; sources and caveats appear once.
  async route({stops, time, limit = 3}) {
    const utc = timestamp(time);
    const places = [];
    for (const text of stops) {
      const resolved = await this.resolve(text);
      places.push({query: text, place: resolved.place, name: resolved.selected.name, id: resolved.selected.id});
    }
    const legs = [];
    let reply;
    for (let i = 0; i + 1 < places.length; i++) {
      reply = await this.get('plan', {fromPlace: places[i].place, toPlace: places[i + 1].place, time: utc, numItineraries: limit}, {view: 'route', limit});
      if (!Array.isArray(reply.data.itineraries)) throw new Error('Unexpected Transitous journey response');
      legs.push({from: places[i].name || places[i].query, to: places[i + 1].name || places[i + 1].query, itineraries: reply.data.itineraries});
    }
    const empty = legs.filter(l => !l.itineraries.length).map(l => `${l.from} → ${l.to}`);
    return {stops: places.map(p => pick(p, ['query', 'name', 'id'])), time: utc, legs, note: 'Each leg is planned from the same start time; check that connections between legs line up.', sources: [this.source(reply)], warnings: [...caveats, ...(empty.length ? [`No itineraries for ${empty.join(', ')}; this can indicate a feed gap, not an impossible journey.`] : [])]};
  }
  async departures({stop_id, time, limit = 10}) {
    const reply = await this.get('stoptimes', {stopId: stop_id, time: timestamp(time), n: limit});
    if (!Array.isArray(reply.data.stopTimes)) throw new Error('Unexpected Transitous departure response');
    return {stop_id, departures: reply.data.stopTimes.slice(0, limit).map(row => ({...pick(row, ['mode', 'displayName', 'routeShortName', 'routeLongName', 'tripShortName', 'agencyName', 'headsign', 'realTime', 'cancelled']), place: stop(row.place)})), sources: [this.source(reply)], warnings: caveats};
  }
}
