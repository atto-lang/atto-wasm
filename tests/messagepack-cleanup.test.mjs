import test from "node:test";
import assert from "node:assert/strict";
import {encodeActorMessageV2,decodeActorMessageV2} from "../transport/messagepack-v2.mjs";

const contract={schemaId:"example.Compute#variant=1",descriptor:"T[S,I]"};

test("successful and malformed decode scrub private byte snapshots but preserve caller input",async()=>{
 const frame=await encodeActorMessageV2({...contract,value:["private message",42n]});
 const pristine=Uint8Array.from(frame);
 const malformed=Uint8Array.from(frame);malformed[1]=1;
 const original=Uint8Array.from;
 const captured=[];
 Uint8Array.from=function(source,...rest){
  const copy=Reflect.apply(original,Uint8Array,[source,...rest]);
  captured.push(copy);return copy;
 };
 try{
  assert.deepEqual(await decodeActorMessageV2({...contract,bytes:frame}),["private message",42n]);
  await assert.rejects(decodeActorMessageV2({...contract,bytes:malformed}),/version\/envelope mismatch/);
  assert.equal(captured.length,2,"each decode allocates one owned snapshot");
  for(const copy of captured)assert.ok(copy.every(byte=>byte===0),"owned decode snapshot was not wiped");
  assert.deepEqual(frame,pristine,"caller-owned DATA input is unchanged");
 }finally{Uint8Array.from=original}
});

test("encoder scrubs all intermediate typed buffers without corrupting returned frame",async()=>{
 const fill=Uint8Array.prototype.fill;
 const cleared=[];
 Uint8Array.prototype.fill=function(...args){
  cleared.push(this);
  return Reflect.apply(fill,this,args);
 };
 let frame;
 try{frame=await encodeActorMessageV2({...contract,value:["secret payload",99n]})}
 finally{Uint8Array.prototype.fill=fill}
 assert.ok(frame.some(b=>b!==0),"returned frame must remain usable");
 assert.ok(cleared.length>=3,"encoder intermediate buffers must be cleared");
 for(const bytes of cleared)assert.ok(bytes.every(b=>b===0),"encoder retained uncleared intermediate");
 assert.deepEqual(await decodeActorMessageV2({...contract,bytes:frame}),["secret payload",99n]);
});
