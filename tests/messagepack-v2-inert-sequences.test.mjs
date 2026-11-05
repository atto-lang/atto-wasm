import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeCollectionV2,decodeCollectionV2} from '../transport/messagepack-v2.mjs';
const encode=(value,descriptor='A[I]')=>encodeCollectionV2('Demo',descriptor,value);
const decode=(bytes,descriptor='A[I]')=>decodeCollectionV2('Demo',descriptor,bytes);
test('own index accessors must not execute during payload encoding',async()=>{
 let reads=0;const input=[7n];
 Object.defineProperty(input,'0',{enumerable:true,get(){reads++;return 7n;}});
 await assert.rejects(encode(input),/sequence requires own data slots/);
 assert.equal(reads,0);
});
test('sparse and noncanonical array metadata fail closed without iterator access',async()=>{
 await assert.rejects(encode(new Array(1)),/sequence requires own data slots/);
 const extra=[7n];extra.extra=1;
 await assert.rejects(encode(extra),/sequence requires own data slots/);
 let called=0;const iter=[7n];
 Object.defineProperty(iter,Symbol.iterator,{get(){called++;throw Error('iterator ran');}});
 await assert.rejects(encode(iter),/sequence requires own data slots/);
 assert.equal(called,0);
});
test('recursive array accessors do not execute',async()=>{
 let reads=0;const child=[7n];
 Object.defineProperty(child,'0',{enumerable:true,get(){reads++;return 7n;}});
 await assert.rejects(encode([child],'A[A[I]]'),/sequence requires own data slots/);
 assert.equal(reads,0);
});
test('ordinary frozen variable and fixed arrays preserve canonical roundtrip',async()=>{
 for(const [payload,shape] of [[Object.freeze([7n,8n]),'A[I]'],[Object.freeze([7n,8n]),'T[I,I]'],[Object.freeze([]),'A[I]']]){
  const encoded=await encode(payload,shape),decoded=await decode(encoded,shape);
  assert.deepEqual([...decoded],[...payload]);
  assert.equal(Object.isFrozen(decoded),true);
 }
});
