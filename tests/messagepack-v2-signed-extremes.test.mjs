import test from "node:test";
import assert from "node:assert/strict";
import {encodeActorMessage,decodeActorMessage} from "../transport/messagepack-v2.mjs";

const domain="demo.Extreme.v1",alternatives=[{id:1,shape:"I"}];
test("i64 minimum and maximum encode exact full-width canonical MessagePack payloads",async()=>{
 for(const [value,wire] of [
  [-(1n<<63n),[0xd3,0x80,0,0,0,0,0,0,0]],
  [(1n<<63n)-1n,[0xcf,0x7f,255,255,255,255,255,255,255]],
  [-2147483649n,[0xd3,255,255,255,255,0x7f,255,255,255]],
  [2147483648n,[0xce,0x80,0,0,0]]
 ]){
  const frame=await encodeActorMessage(domain,alternatives,1,value);
  assert.deepEqual(Array.from(frame.subarray(-wire.length)),wire,String(value));
  assert.equal((await decodeActorMessage(domain,alternatives,frame)).value,value);
 }
});
test("i64 values just outside the signed domain fail before wire materialization",async()=>{
 for(const value of [-(1n<<63n)-1n,1n<<63n])
  await assert.rejects(encodeActorMessage(domain,alternatives,1,value),
   /signed i64 BigInt required/);
});
