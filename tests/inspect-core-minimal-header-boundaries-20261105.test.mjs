import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const empty=Uint8Array.from([0,97,115,109,1,0,0,0]);

test('minimal eight-byte core header admits an owned snapshot',()=>{
 assert.equal(WebAssembly.validate(empty),true);
 const source=empty.slice();
 const parsed=inspectWasmBytes(source,{maxModuleBytes:8,maxMemoryPages:1});
 assert.equal(parsed.memoryCount,0);
 assert.equal(parsed.bytes.length,8);
 source[1]=0;
 assert.equal(parsed.bytes[1],97);
});

test('empty-name inert custom section obeys the exact module byte quota',()=>{
 const input=Uint8Array.from([...empty,0,1,0]);
 assert.equal(WebAssembly.validate(input),true);
 assert.equal(inspectWasmBytes(input,{maxModuleBytes:11,maxMemoryPages:1}).memoryCount,0);
 assert.throws(()=>inspectWasmBytes(input,{maxModuleBytes:10,maxMemoryPages:1}),
  /maximum byte size/);
});

test('invalid magic, version and truncation are rejected',()=>{
 for(const bytes of [
  [0,97,115,109,2,0,0,0],
  [1,97,115,109,1,0,0,0],
  [0,97,115,109,1,0,0]
 ])assert.throws(()=>inspectWasmBytes(Uint8Array.from(bytes),
  {maxModuleBytes:64,maxMemoryPages:1}),/invalid core module header/);
});

test('native typed-array byte slots reject caller spoofing',()=>{
 const source=empty.slice();
 let calls=0;
 Object.defineProperty(source,'byteLength',{get(){calls++;throw Error('hostile getter');}});
 assert.equal(inspectWasmBytes(source,{maxModuleBytes:8,maxMemoryPages:1}).bytes.length,8);
 assert.equal(calls,0);
 assert.throws(()=>inspectWasmBytes(source,{maxModuleBytes:7,maxMemoryPages:1}),
  /invalid maximum module size/);
 assert.equal(calls,0);
});

test('precompiled WebAssembly.Module cannot skip original-byte admission',()=>{
 assert.throws(()=>inspectWasmBytes(new WebAssembly.Module(empty)),
  /precompiled WebAssembly.Module cannot be inspected/);
});
