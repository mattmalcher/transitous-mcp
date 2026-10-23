import test from 'node:test';
import assert from 'node:assert/strict';
import {Research, timestamp, coordinates, routePlan} from '../src/research.js';
const reply = data => ({data, retrieved_at: '2026-10-01T10:00:00Z', cached: false});
test('requires explicit offset, converts correctly and rejects invalid coordinates', () => {
  assert.equal(timestamp('2026-10-10T08:00+02:00'), '2026-10-10T06:00:00.000Z');
  assert.throws(() => timestamp('2026-10-10T08:00'));
  assert.throws(() => timestamp('tomorrow'));
  assert.throws(() => timestamp('2026-02-31T08:00Z'));
  assert.throws(() => coordinates('91,2'));
  assert.equal(coordinates(' 51.5, -0.1 '), '51.5,-0.1');
});
test('resolves names to coordinates, keeps ambiguity, arrival cutoff and direct filtering', async () => {
  const calls = [];
  const research = new Research(async (path, params) => {
    calls.push({path, params});
    if (path === 'geocode') return reply([{id: 'place', type: 'ADDRESS', name: 'Fictional place', lat: 1, lon: 2}, {id: 'stop', type: 'STOP', name: 'Fictional station', lat: 3, lon: 4}]);
    return reply({itineraries: [{transfers: 1, legs: []}, {transfers: 0, startTime: '2026-10-10T07:00:00Z', legs: [{mode: 'RAIL', agencyName: 'Fictional Rail', tripShortName: 'TEST 1', from: {name: 'A', scheduledTrack: '2'}, to: {name: 'B'}, intermediateStops: new Array(100).fill({})}]}]});
  });
  const result = await research.plan({from: 'Fictional station', to: '5,6', time: '2026-10-10T08:00+01:00', arrive_by: true, direct: true});
  assert.equal(calls[1].params.fromPlace, '3,4');
  assert.equal(calls[1].params.arriveBy, 'true');
  assert.equal(calls[1].params.maxTransfers, 0);
  assert.equal(result.origin.alternatives[0].type, 'ADDRESS');
  assert.equal(result.itineraries.length, 1);
  assert.equal(result.itineraries[0].legs[0].from.scheduledTrack, '2');
  assert.equal(result.itineraries[0].legs[0].intermediateStops, undefined);
  assert.match(result.sources[0].attribution, /OpenStreetMap/);
});
test('invalid times fail before lookup and empty results retain uncertainty', async () => {
  let calls = 0;
  const research = new Research(async () => { calls++; return reply({itineraries: []}); });
  await assert.rejects(research.plan({from: 'A', to: 'B', time: 'not a date'}));
  assert.equal(calls, 0);
  const result = await research.plan({from: '1,2', to: '3,4', time: '2026-10-10T08:00Z'});
  assert.match(result.warnings.at(-1), /feed gap/);
});
test('boards pass exact stop ID and return bounded rows with platform data', async () => {
  const research = new Research(async (path, params) => {
    assert.equal(path, 'stoptimes'); assert.equal(params.stopId, 'fictional:stop'); assert.equal(params.n, 1);
    return reply({stopTimes: [{headsign: 'Fictional town', place: {departure: '2026-10-10T08:00Z', track: '4'}}, {}]});
  });
  const result = await research.departures({stop_id: 'fictional:stop', time: '2026-10-10T08:00Z', limit: 1});
  assert.equal(result.departures.length, 1); assert.equal(result.departures[0].place.track, '4');
});
test('route resolves each stop once, plans consecutive legs with the route view, and states caveats once', async () => {
  const calls = [];
  const research = new Research(async (path, params, view) => {
    calls.push({path, params, view});
    if (path === 'geocode') return reply([{id: `id-${params.text}`, type: 'STOP', name: `Fictional ${params.text}`, lat: 1, lon: 2}]);
    return reply({itineraries: params.fromPlace === '7,8' ? [] : [{transfers: 0, legs: [{mode: 'RAIL', line: 'TEST 1'}]}]});
  });
  const result = await research.route({stops: ['A', 'B', '7,8', 'D'], time: '2026-10-10T08:00+01:00', limit: 2});
  assert.equal(calls.filter(c => c.path === 'geocode').length, 3);
  const plans = calls.filter(c => c.path === 'plan');
  assert.equal(plans.length, 3);
  assert.deepEqual(plans[0].view, {view: 'route', limit: 2});
  assert.equal(plans[0].params.numItineraries, 2);
  assert.equal(result.legs[1].to, '7,8');
  assert.deepEqual(result.stops[0], {query: 'A', name: 'Fictional A', id: 'id-A'});
  assert.equal(result.sources.length, 1);
  assert.match(result.warnings.at(-1), /No itineraries for 7,8 → Fictional D;/);
  await assert.rejects(research.route({stops: ['A', 'B'], time: '2026-10-10T08:00'}), /explicit UTC offset/);
});
test('route view keeps a few itineraries and one line per leg', () => {
  const leg = {mode: 'RAIL', startTime: 's', endTime: 'e', displayName: 'TGV 1', agencyName: 'Fictional Rail', headsign: 'Somewhere', from: {name: 'A', departure: 'd', scheduledTrack: '4', lat: 1}, to: {name: 'B', arrival: 'a', alerts: [{}]}};
  const data = {itineraries: [1, 2, 3, 4].map(n => ({duration: n, transfers: 0, legs: [leg]}))};
  const view = routePlan(data, 2);
  assert.equal(view.itineraries.length, 2);
  assert.deepEqual(view.itineraries[0].legs[0], {mode: 'RAIL', from: 'A', to: 'B', departure: 'd', arrival: 'a', line: 'TGV 1', agency: 'Fictional Rail', headsign: 'Somewhere', track: '4'});
});
