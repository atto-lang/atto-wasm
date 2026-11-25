import test from "node:test";
import assert from "node:assert/strict";
import {encodeActorMessage,decodeActorMessage} from "../transport/messagepack-v2.mjs";

const domain="demo.Actor.Contract.v1";
test("variant entry accessors cannot change validated value shape after schema hashing",async()=>{
 let invoked=0;
 for(const key of ["id","shape"]){
  const entry={id:1,shape:"I"};
  Object.defineProperty(entry,key,{enumerable:true,get(){
    invoked++;return key==="id"?1:(invoked===1?"I":"S");
  }});
  await assert.rejects(encodeActorMessage(domain,[entry],1,42n),
    /variant entry requires own data ID and shape/);
  await assert.rejects(decodeActorMessage(domain,[entry],Uint8Array.of(1,2,3)),
    /variant entry requires own data ID and shape/);
 }
 assert.equal(invoked,0);
});

test("variant list uses own numeric slots, never caller iterator or sparse-array accessors",async()=>{
 let invoked=0;
 const entries=[{id:1,shape:"I"}];
 Object.defineProperty(entries,Symbol.iterator,{get(){
   invoked++;throw Error("malicious iterator getter");
 }});
 const encoded=await encodeActorMessage(domain,entries,1,42n);
 const decoded=await decodeActorMessage(domain,entries,encoded);
 assert.equal(decoded.value,42n);
 assert.equal(invoked,0);
 const sparse=Array(1);
 await assert.rejects(encodeActorMessage(domain,sparse,1,42n),
  /variant list requires own data slots/);
 const getterArray=Array(1);
 Object.defineProperty(getterArray,0,{get(){
   invoked++;throw Error("malicious element getter");
 }});
 await assert.rejects(encodeActorMessage(domain,getterArray,1,42n),
  /variant list requires own data slots/);
 assert.equal(invoked,0);
});
