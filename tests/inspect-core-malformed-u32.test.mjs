import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const moduleWith=tail=>Uint8Array.from([...header,...tail]);

test('truncated, overflowing and out-of-bounds section lengths fail closed',()=>{
  const invalid=[
    [[0,0x80],/truncated unsigned integer/],
    [[0,0xff,0xff,0xff,0xff,0x10],/invalid u32 encoding/],
    [[0,5,0],/section extends beyond module/],
    [[5,1,0x80],/truncated unsigned integer/]
  ];
  for(const [tail,expected] of invalid)
    assert.throws(()=>inspectWasmBytes(moduleWith(tail),{maxModuleBytes:64}),expected,tail.join(','));
});

test('invalid memory count and feature flags reject before guest instantiation',()=>{
  for(const [tail,expected] of [
    [[5,1,2],/more than one memory/],
    [[5,3,1,2,0],/memory requires fixed initial and maximum limits/],
    [[5,3,1,3,0],/memory requires fixed initial and maximum limits/]
  ])assert.throws(()=>inspectWasmBytes(moduleWith(tail),{maxModuleBytes:64}),expected);
});

test('a canonical empty-name custom section remains an allowed no-execution control',()=>{
  const bytes=moduleWith([0,1,0]);
  assert.equal(WebAssembly.validate(bytes),true);
  const parsed=inspectWasmBytes(bytes,{maxModuleBytes:bytes.length});
  assert.equal(parsed.memoryCount,0);
  assert.deepEqual(Array.from(parsed.bytes),Array.from(bytes));
});
