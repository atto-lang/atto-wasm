// Host wire conformance only, not compiled guest MessagePack execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage,decodeActorMessage} from '../transport/messagepack-v2.mjs';

const domain='com.example.actor.contract.v1';
const variants=()=>[{id:1,shape:'I'},{id:2,shape:'S'},{id:3,shape:'B'}];

test('one actor schema selects the exact variant without aliasing signed i64 or booleans',async()=>{
 const defs=variants();
 for(const v of [-(1n<<63n),-33n,-1n,0n,255n,(1n<<63n)-1n]){
  const wire=await encodeActorMessage(domain,defs,1,v);
  const result=await decodeActorMessage(domain,defs,wire);
  assert.equal(result.variantId,1);
  assert.equal(result.value,v);
  assert.ok(Object.isFrozen(result));
 }
 const binary=await encodeActorMessage(domain,defs,3,false);
 assert.equal((await decodeActorMessage(domain,defs,binary)).value,false);
 const text=await encodeActorMessage(domain,defs,2,'Aé');
 assert.equal((await decodeActorMessage(domain,defs,text)).value,'Aé');
});

test('old frames cannot be replayed under another domain or omitted variant',async()=>{
 const wire=await encodeActorMessage(domain,variants(),1,42n);
 await assert.rejects(()=>decodeActorMessage(domain+'.next',variants(),wire),/undeclared actor schema/);
 await assert.rejects(()=>decodeActorMessage(domain,[{id:2,shape:'S'}],wire),/undeclared actor schema/);
 const trailing=Uint8Array.from([...wire,0]);
 await assert.rejects(()=>decodeActorMessage(domain,variants(),trailing),/trailing message bytes/);
 await assert.rejects(()=>encodeActorMessage(domain,variants(),1,1n<<63n),/signed i64/);
});

test('variant getter and sparse authority are denied without running untrusted code',async()=>{
 let called=0;
 const evil={shape:'I'};
 Object.defineProperty(evil,'id',{get(){called++;throw Error('getter invoked');}});
 await assert.rejects(()=>encodeActorMessage(domain,[evil],1,1n),/own data ID and shape/);
 const sparse=new Array(2);sparse[1]={id:1,shape:'I'};
 await assert.rejects(()=>encodeActorMessage(domain,sparse,1,1n),/own data slots/);
 const duplicate=[{id:1,shape:'I'},{id:1,shape:'S'}];
 await assert.rejects(()=>encodeActorMessage(domain,duplicate,1,1n),/duplicate variant ID/);
 assert.equal(called,0);
});

test('decoding snapshots a caller-owned subview before the async digest',async()=>{
 const frame=await encodeActorMessage(domain,variants(),1,7n);
 const padded=Uint8Array.from([0x55,...frame,0x99]);
 const view=new DataView(padded.buffer,1,frame.length);
 const pending=decodeActorMessage(domain,variants(),view);
 padded.fill(0); // Mutating caller memory cannot mutate the already owned frame
 const value=await pending;
 assert.equal(value.value,7n);
});
