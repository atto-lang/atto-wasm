import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from '../transport/owned-envelope.mjs';

const schema=()=>({schemaVersion:1,ownership:'copy',variants:[
  {id:7,name:'Packet',fields:[{name:'count',type:'i64'}]}]});
const encode=()=>encodeMessage(schema(),{variant:'Packet',fields:{count:42n}});
test('canonical header and i64 roundtrip use an owned immutable value',async()=>{
  const wire=await encode();
  assert.equal(wire.length,OWNED_ENVELOPE_V1.headerBytes+8);
  const result=await decodeMessage(schema(),wire);
  assert.equal(result.variant,'Packet');assert.equal(result.fields.count,42n);
  assert.equal(Object.isFrozen(result.fields),true);
});
test('version and nonzero flags are denied before decoded payload authority',async()=>{
  const wire=await encode();
  for(const i of [4,5]){
    const bad=Uint8Array.from(wire);bad[i]=2;
    await assert.rejects(decodeMessage(schema(),bad),/unknown version\/flags/);
  }
});
test('mismatching variant, length or contract hash cannot decode',async()=>{
  const wire=await encode();
  const variant=Uint8Array.from(wire);variant[6]=8;variant[7]=0;
  await assert.rejects(decodeMessage(schema(),variant),/unknown message variant/);
  const length=Uint8Array.from(wire);length[8]=9;
  await assert.rejects(decodeMessage(schema(),length),/payload length mismatch/);
  const hash=Uint8Array.from(wire);hash[12]^=1;
  await assert.rejects(decodeMessage(schema(),hash),/contract SHA-256 mismatch/);
});
test('truncating canonical body cannot silently materialize a message',async()=>{
  const wire=await encode();
  await assert.rejects(decodeMessage(schema(),wire.subarray(0,-1)),/payload length mismatch/);
});