import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from '../transport/owned-envelope.mjs';

const schema=()=>({schemaVersion:1,ownership:'copy',
  variants:[{id:1,name:'Data',fields:[{name:'payload',type:'bytes'}]}]});
test('owned byte payload is snapshotted from caller before asynchronous hashing',async()=>{
  const input=Uint8Array.from([1,2,3]);
  const wire=await encodeMessage(schema(),{variant:'Data',fields:{payload:input}});
  input.fill(9);
  const decoded=await decodeMessage(schema(),wire);
  assert.deepEqual(Array.from(decoded.fields.payload),[1,2,3]);
  wire.fill(0);
  assert.deepEqual(Array.from(decoded.fields.payload),[1,2,3]);
});
test('exact wire byte limit includes the header and payload length prefix',async()=>{
  const value={variant:'Data',fields:{payload:Uint8Array.of(7,8)}};
  const wire=await encodeMessage(schema(),value,{maxBytes:50});
  assert.equal(wire.length,50);
  await assert.rejects(encodeMessage(schema(),value,{maxBytes:49}),/byte budget exceeded/);
  await assert.rejects(decodeMessage(schema(),wire,{maxBytes:49}),/invalid message size/);
});
test('getter-backed schema authority is rejected without invocation',async()=>{
  let reads=0;
  const invalid=schema();
  Object.defineProperty(invalid,'variants',{enumerable:true,get(){reads++;throw Error('poisoned');}});
  await assert.rejects(encodeMessage(invalid,{variant:'Data',fields:{payload:Uint8Array.of()}}),/invalid contract shape/);
  assert.equal(reads,0);
});
test('sparse contract variant rows fail before hashing',async()=>{
  const invalid=schema();
  invalid.variants=new Array(1);
  await assert.rejects(encodeMessage(invalid,{variant:'Data',fields:{payload:Uint8Array.of()}}),/sparse variants/);
});