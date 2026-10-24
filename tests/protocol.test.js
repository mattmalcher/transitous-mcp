import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {handleResearchMcp} from '../src/protocol.js';

const calls=[];
const binding={idFromName:name=>name,get:()=>({fetch:async(url,init)=>{
  const query=JSON.parse(init.body);calls.push(query);
  const data=query.path==='geocode'?[{id:'fictional:stop',name:'Fictional Station',type:'STOP',lat:1,lon:2}]:{stopTimes:[]};
  return Response.json({data,retrieved_at:'2026-10-24T08:00:00Z',cached:false});
}})};
test('shared lean protocol works with the real SDK and preserves departure boards',async()=>{
  const client=new Client({name:'test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('https://example.com/mcp'),{fetch:(url,init)=>handleResearchMcp(new Request(url,init),binding)}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['find_stations','plan_journey','station_departures']);
    assert.match((await client.readResource({uri:'transitous://guide'})).contents[0].text,/operator/);
    const station=await client.callTool({name:'find_stations',arguments:{text:'Fictional Station'}});
    assert.equal(station.structuredContent.matches[0].id,'fictional:stop');
    const board=await client.callTool({name:'station_departures',arguments:{stop_id:'fictional:stop',time:'2026-11-04T08:00Z'}});
    assert.deepEqual(board.structuredContent.departures,[]);
    assert.equal(calls.at(-1).path,'stoptimes');
    const before=calls.length;
    for(const name of ['constructor','__proto__','load_trip']) assert.equal((await client.callTool({name,arguments:{}})).isError,true);
    assert.equal((await client.callTool({name:'find_stations',arguments:{text:'Fictional Station',limit:100}})).isError,true);
    assert.equal(calls.length,before);
    await client.ping();
  } finally {await client.close();}
});
test('shared protocol limits body bytes before dispatch',async()=>{
  const response=await handleResearchMcp(new Request('https://example.com/mcp',{method:'POST',body:'x'.repeat(32769)}),binding);
  assert.equal(response.status,413);
});
