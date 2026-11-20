import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from '../transport/owned-envelope.mjs';

const schema={schemaVersion:1,ownership:'copy',variants:[{id:7,name:'Packet',
  fields:[{name:'flag',type:'bool'},{name:'payload',type:'bytes'}]}]};
const message=payload=>({variant:'Packet',fields:{flag:true,payload}});

test('owned payload remains independent of caller and decoder mutations',async()=>{
  const source=Uint8Array.of(3,4);
  const encoded=await encodeMessage(schema,message(source));
  source[0]=99;
  const decoded=await decodeMessage(schema,encoded);
  assert.equal(decoded.fields.flag,true);
  assert.deepStrictEqual(Array.from(decoded.fields.payload),[3,4]);
  const before=Array.from(encoded);
  decoded.fields.payload[0]=42;
  assert.deepStrictEqual(Array.from(encoded),before);
  assert.equal(Object.isFrozen(decoded.fields),true);
});
test('noncanonical bool payload is rejected after bounded schema check',async()=>{
  const encoded=await encodeMessage(schema,message(Uint8Array.of(1)));
  encoded[OWNED_ENVELOPE_V1.headerBytes]=2;
  await assert.rejects(decodeMessage(schema,encoded),/noncanonical bool/);
});
test('getter-backed message field never executes at admission',async()=>{
  let called=0;
  const fields={get flag(){called++;return true},payload:Uint8Array.of(1)};
  await assert.rejects(encodeMessage(schema,{variant:'Packet',fields}),/invalid message fields shape/);
  assert.equal(called,0);
});
test('view offset and snapshot are preserved during async decoding',async()=>{
  const wire=await encodeMessage(schema,message(Uint8Array.of(5)));
  const outer=new Uint8Array(wire.length+2);
  outer.set(wire,1);
  const view=outer.subarray(1,1+wire.length);
  const pending=decodeMessage(schema,view);
  view[OWNED_ENVELOPE_V1.headerBytes]=2;
  const decoded=await pending;
  assert.equal(decoded.fields.flag,true);
  assert.deepStrictEqual(Array.from(decoded.fields.payload),[5]);
});
