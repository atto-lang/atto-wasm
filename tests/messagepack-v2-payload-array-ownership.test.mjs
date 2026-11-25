import test from "node:test";
import assert from "node:assert/strict";
import {encodeCollectionV2,decodeCollectionV2} from "../transport/messagepack-v2.mjs";

const schema="demo.TypedSequence.v2";
test("caller sequence getters and sparse payloads never execute during encoding",async()=>{
 let called=0;
 const malicious=[42n];
 Object.defineProperty(malicious,0,{enumerable:true,get(){
  called++;throw Error("untrusted payload getter");
 }});
 await assert.rejects(encodeCollectionV2(schema,"T[I]",malicious),
   /payload sequence requires own data slots/);
 const nested=[[42n]];
 Object.defineProperty(nested[0],0,{enumerable:true,get(){
  called++;return 42n;
 }});
 await assert.rejects(encodeCollectionV2(schema,"T[L[I]]",nested),
   /payload sequence requires own data slots/);
 assert.equal(called,0);
 const sparse=new Array(1);
 await assert.rejects(encodeCollectionV2(schema,"T[I]",sparse),
   /payload sequence must contain only own data slots|payload sequence requires own data slots/);
});
test("plain arrays encode/decode canonically and custom sequence iterators cannot execute",async()=>{
 let calls=0;
 const values=[[1n,2n],[3n]];
 const encoded=await encodeCollectionV2(schema,"T[L[I],L[I]]",values);
 assert.deepEqual(await decodeCollectionV2(schema,"T[L[I],L[I]]",encoded),values);
 const array=[42n];
 Object.defineProperty(array,Symbol.iterator,{get(){
  calls++;throw Error("iterator invoked");
 }});
 await assert.rejects(encodeCollectionV2(schema,"T[I]",array),
   /payload sequence must contain only own data slots/);
 assert.equal(calls,0);
});
