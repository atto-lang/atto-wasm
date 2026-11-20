// Host MessagePack v2 wire validation, not compiled Wasm guest ABI evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage,decodeActorMessage} from '../transport/messagepack-v2.mjs';

const domain='com.example.CanonicalSigned.v2';
const variants=[{id:1,shape:'I'}];
const replaceTail=(frame,oldBytes,encoded)=>Uint8Array.from([
 ...frame.subarray(0,frame.length-oldBytes),...encoded
]);

test('nonminimal unsigned fixed-width encodings cannot alias canonical i64',async()=>{
 for(const [value,noncanonical] of [
  [0n,[0xcc,0]],[127n,[0xcd,0,127]],[128n,[0xcd,0,128]],
  [255n,[0xce,0,0,0,255]],[65535n,[0xce,0,0,255,255]],
  [65536n,[0xcf,0,0,0,0,0,1,0,0]]
 ]){
  const frame=await encodeActorMessage(domain,variants,1,value);
  const parsed=await decodeActorMessage(domain,variants,frame);
  assert.equal(parsed.value,value);
  const oldBytes=value<=127n?1:value<=255n?2:value<=65535n?3:5;
  await assert.rejects(()=>decodeActorMessage(domain,variants,
    replaceTail(frame,oldBytes,noncanonical)),/noncanonical integer encoding/);
 }
});

test('nonminimal signed negative widths cannot alias canonical negative i64',async()=>{
 for(const [value,oldBytes,alternate] of [
  [-1n,1,[0xd0,255]],[-32n,1,[0xd1,255,224]],
  [-33n,2,[0xd1,255,223]],[-128n,2,[0xd2,255,255,255,128]],
  [-129n,3,[0xd2,255,255,255,127]]
 ]){
  const frame=await encodeActorMessage(domain,variants,1,value);
  assert.equal((await decodeActorMessage(domain,variants,frame)).value,value);
  await assert.rejects(()=>decodeActorMessage(domain,variants,
    replaceTail(frame,oldBytes,alternate)),/noncanonical integer encoding/);
 }
});

test('appending any trailing bytes never grants a second payload identity',async()=>{
 for(const n of [-1n,0n,128n,(1n<<63n)-1n]){
  const original=await encodeActorMessage(domain,variants,1,n);
  const appended=Uint8Array.from([...original,0,0]);
  await assert.rejects(()=>decodeActorMessage(domain,variants,appended),/trailing message bytes/);
 }
});
