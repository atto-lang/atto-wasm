import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const core=[0,97,115,109,1,0,0,0];
const wire=tail=>Uint8Array.from([...core,...tail]);

const padded=[
 ['custom-section length',wire([0,0x81,0,0])],
 ['memory count',wire([5,5,0x81,0,1,0,0])],
 ['memory minimum',wire([5,5,1,1,0x80,0,1])]
];

test('reject non-shortest LEB128 section and memory integers before accepting WebAssembly bytes',()=>{
 for(const [name,bytes] of padded){
  assert.equal(WebAssembly.validate(bytes),true,name+' is a valid Wasm encoding');
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:bytes.length,maxMemoryPages:1}),
    /Wasm admission denied: noncanonical unsigned integer/,name);
 }
});

test('retain canonical no-memory, inert-custom and fixed-memory modules',()=>{
 for(const bytes of [wire([]),wire([0,1,0]),wire([5,4,1,1,0,1])]){
  assert.equal(WebAssembly.validate(bytes),true);
  const snap=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length,maxMemoryPages:1});
  assert.deepEqual([...snap.bytes],[...bytes]);
 }
});

test('bounded parser must still reject over-width and truncated LEB128',()=>{
 for(const bytes of [wire([0,0x80]),wire([0,0xff,0xff,0xff,0xff,0x10])])
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:bytes.length}),
    /Wasm admission denied:/);
});

test('retain canonical multi-byte section lengths, including 128-byte payload',()=>{
 const bytes=wire([0,0x80,0x01,0,...new Array(127).fill(0)]);
 assert.equal(WebAssembly.validate(bytes),true);
 assert.deepEqual([...inspectWasmBytes(bytes,{maxModuleBytes:bytes.length}).bytes],[...bytes]);
});
