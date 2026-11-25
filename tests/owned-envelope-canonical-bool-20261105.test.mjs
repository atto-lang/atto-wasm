import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from '../transport/owned-envelope.mjs';

const schema=()=>({schemaVersion:1,ownership:'copy',
 variants:[{id:1,name:'Flag',fields:[{name:'ok',type:'bool'}]}]});
const message=()=>({variant:'Flag',fields:{ok:true}});

test('ORM1 typed boolean remains copied before async hashing and decodes to a frozen value',async()=>{
 const m=message(),promised=encodeMessage(schema(),m);
 m.fields.ok=false;
 const bytes=await promised;
 assert.equal(bytes.length,OWNED_ENVELOPE_V1.headerBytes+1);
 const result=await decodeMessage(schema(),bytes);
 assert.equal(result.variant,'Flag');
 assert.equal(result.fields.ok,true);
 assert.equal(Object.isFrozen(result),true);
 assert.equal(Object.isFrozen(result.fields),true);
});

test('noncanonical boolean payload is rejected even with an otherwise valid contract hash',async()=>{
 const bytes=await encodeMessage(schema(),message());
 const poisoned=Uint8Array.from(bytes);
 poisoned[OWNED_ENVELOPE_V1.headerBytes]=2;
 await assert.rejects(decodeMessage(schema(),poisoned),/noncanonical bool/);
 const wrongHash=Uint8Array.from(bytes);
 wrongHash[12]^=0xff;
 await assert.rejects(decodeMessage(schema(),wrongHash),/contract SHA-256 mismatch/);
});

test('malformed ORM1 headers and byte budgets never decode as valid typed messages',async()=>{
 const bytes=await encodeMessage(schema(),message());
 const invalidVersion=Uint8Array.from(bytes);
 invalidVersion[4]=2;
 await assert.rejects(decodeMessage(schema(),invalidVersion),/unknown version\/flags/);
 for(const limit of [0,43,1048577,1.5])
  await assert.rejects(encodeMessage(schema(),message(),{maxBytes:limit}),/invalid maxBytes/);
 await assert.rejects(decodeMessage(schema(),bytes,{maxBytes:44}),/invalid message size/);
});
