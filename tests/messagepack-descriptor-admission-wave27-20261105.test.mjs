// Canonical host wire admission only; no compiled Wasm guest ABI evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage,encodeCollectionV2} from '../transport/messagepack-v2.mjs';

const domain='com.example.WireBoundary.v2';

test('invalid shape descriptors fail before hash or payload encoding',async()=>{
  for(const shape of ['','Q','Igarbage','T[I,]','A[]','T[I','FA[I,,B]']) {
    await assert.rejects(()=>encodeActorMessage(domain,[{id:1,shape}],1,1n),
      /Oreslang MessagePack v2/);
  }
  await assert.rejects(()=>encodeCollectionV2('com.example.Collection','F[]',[]),
    /Oreslang MessagePack v2/);
});

test('invalid envelope domains and duplicate variant IDs are rejected',async()=>{
  for(const domainValue of ['','bad\nid','bad#variant=2','é', 'x'.repeat(231)]) {
    await assert.rejects(()=>encodeActorMessage(domainValue,[{id:1,shape:'I'}],1,1n),
      /Oreslang MessagePack v2/);
  }
  await assert.rejects(()=>encodeActorMessage(domain,[{id:1,shape:'I'},{id:1,shape:'B'}],1,1n),
    /duplicate variant ID/);
  for(const id of [0,-1,1.5,2147483648]) {
    await assert.rejects(()=>encodeActorMessage(domain,[{id,shape:'I'}],id,1n),
      /invalid variant ID/);
  }
});

test('variant getters and indexed-array getters cannot control contract admission',async()=>{
  let invoked=0;
  const variant={id:1};
  Object.defineProperty(variant,'shape',{enumerable:true,get(){invoked++;return 'I';}});
  await assert.rejects(()=>encodeActorMessage(domain,[variant],1,1n),
    /variant entry requires own data ID and shape/);
  const variants=[{id:1,shape:'I'}];
  Object.defineProperty(variants,'0',{enumerable:true,configurable:true,get(){invoked++;return variant;}});
  await assert.rejects(()=>encodeActorMessage(domain,variants,1,1n),
    /variant list requires own data slots/);
  assert.equal(invoked,0);
});