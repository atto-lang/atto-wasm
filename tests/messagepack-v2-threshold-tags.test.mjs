import test from "node:test";
import assert from "node:assert/strict";
import {encodeActorMessage,decodeActorMessage} from "../transport/messagepack-v2.mjs";

const domain="demo.CanonicalThreshold.v1";
const iv=[{id:1,shape:"I"}],sv=[{id:1,shape:"S"}];
const tail=(frame,count)=>Array.from(frame.subarray(frame.length-count));

test("signed-i64 threshold values use exact minimal MessagePack wire encodings",async()=>{
 const cases=[
  [-32n,[0xe0]],[-33n,[0xd0,0xdf]],[-128n,[0xd0,0x80]],
  [-129n,[0xd1,0xff,0x7f]],[-32768n,[0xd1,0x80,0x00]],
  [0n,[0x00]],[127n,[0x7f]],[128n,[0xcc,0x80]],
  [255n,[0xcc,0xff]],[256n,[0xcd,0x01,0x00]],
  [65535n,[0xcd,0xff,0xff]],[65536n,[0xce,0,1,0,0]],
  [4294967295n,[0xce,255,255,255,255]],
  [4294967296n,[0xcf,0,0,0,1,0,0,0,0]]
 ];
 for(const [value,wire] of cases){
  const frame=await encodeActorMessage(domain,iv,1,value);
  assert.deepEqual(tail(frame,wire.length),wire,String(value));
  assert.equal((await decodeActorMessage(domain,iv,frame)).value,value);
 }
});

test("UTF-8 string lengths use fixstr, str8, and str16 exactly at thresholds",async()=>{
 const cases=[[31,[0xbf]],[32,[0xd9,32]],[255,[0xd9,255]],
   [256,[0xda,1,0]]];
 for(const [length,header] of cases){
  const value="a".repeat(length);
  const frame=await encodeActorMessage(domain,sv,1,value);
  const encoded=tail(frame,length+header.length);
  assert.deepEqual(encoded.slice(0,header.length),header);
  assert.equal((await decodeActorMessage(domain,sv,frame)).value,value);
 }
});
