import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage} from '../transport/owned-envelope.mjs';

const schema=()=>({schemaVersion:1,ownership:'copy',variants:[
  {id:1,name:'Data',fields:[{name:'payload',type:'bytes'},{name:'count',type:'i64'}]}]});
const value=(payload,count)=>({variant:'Data',fields:{payload,count}});
test('i64 signed endpoints survive exact byte wire round trips',async()=>{
  for(const count of [-(1n<<63n),0n,(1n<<63n)-1n]){
    const wire=await encodeMessage(schema(),value(Uint8Array.of(1),count));
    const out=await decodeMessage(schema(),wire);
    assert.equal(out.fields.count,count);
  }
});
test('i64 overflow and non-BigInt values fail before hashing',async()=>{
  for(const count of [-(1n<<63n)-1n,1n<<63n,42,'42']){
    await assert.rejects(encodeMessage(schema(),value(Uint8Array.of(1),count)),/signed i64 BigInt/);
  }
});
test('subview byte offsets are respected and copied on both edges',async()=>{
  const backing=Uint8Array.of(99,4,5,6,88);
  const wire=await encodeMessage(schema(),value(backing.subarray(1,4),7n));
  backing.fill(0);
  const padded=new Uint8Array(wire.length+7);
  padded.set(wire,4);
  const decoded=await decodeMessage(schema(),padded.subarray(4,4+wire.length));
  assert.deepEqual(Array.from(decoded.fields.payload),[4,5,6]);
  padded.fill(0);
  assert.deepEqual(Array.from(decoded.fields.payload),[4,5,6]);
});
test('schema renaming is not silently compatible with pinned wire hash',async()=>{
  const wire=await encodeMessage(schema(),value(Uint8Array.of(1),2n));
  const different=schema();different.variants[0].name='Other';
  await assert.rejects(decodeMessage(different,wire),/contract SHA-256 mismatch/);
});