import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=Uint8Array.from([0,97,115,109,1,0,0,0]);

test('module-byte budget accepts the exact minimum and rejects noninteger, nonfinite and excessive limits',()=>{
  assert.deepEqual(Array.from(inspectWasmBytes(header,{maxModuleBytes:8}).bytes),Array.from(header));
  for(const limit of [0,7,-1,7.5,NaN,Infinity,-Infinity,16*1024*1024+1,'8',null]) {
    assert.throws(()=>inspectWasmBytes(header,{maxModuleBytes:limit}),
      /invalid maximum module size/,String(limit));
  }
});

test('memory-page configuration fails before inspecting caller-supplied byte getters',()=>{
  let getterCalls=0;
  const view=header.slice();
  Object.defineProperty(view,'byteLength',{get(){getterCalls++;throw Error('hostile getter');}});
  Object.defineProperty(view,Symbol.iterator,{value:function*(){getterCalls++;throw Error('hostile iterator');}});
  for(const limit of [0,-1,1.5,NaN,Infinity,257,'32',null]){
    assert.throws(()=>inspectWasmBytes(view,{maxMemoryPages:limit}),
      /invalid maximum memory pages/,String(limit));
  }
  assert.equal(getterCalls,0);
  assert.equal(inspectWasmBytes(view,{maxModuleBytes:8,maxMemoryPages:1}).memoryCount,0);
  assert.equal(getterCalls,0);
});

test('already compiled modules are refused instead of bypassing the original-byte gate',()=>{
  const compiled=new WebAssembly.Module(header);
  assert.throws(()=>inspectWasmBytes(compiled),/precompiled WebAssembly.Module cannot be inspected/);
});
