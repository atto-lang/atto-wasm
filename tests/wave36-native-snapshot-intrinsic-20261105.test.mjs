// Host byte-admission regression: not an Oreslang guest/compiler certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=Uint8Array.from([0,97,115,109,1,0,0,0]);

test('a subview is copied by native byte slots without invoking forged JavaScript hooks',()=>{
  const padded=Uint8Array.from([255,...header,255]);
  const view=padded.subarray(1,9);
  let calls=0;
  for(const key of ['byteLength','byteOffset','buffer',Symbol.iterator]){
    Object.defineProperty(view,key,{configurable:true,get(){calls++;throw Error('forged getter');}});
  }
  const parsed=inspectWasmBytes(view,{maxModuleBytes:8,maxMemoryPages:1});
  assert.equal(parsed.memoryCount,0);
  assert.deepEqual([...parsed.bytes],[...header]);
  assert.equal(calls,0);
  padded[2]=0;
  assert.deepEqual([...parsed.bytes],[...header],'admitted bytes must be owned');
});

test('a non-byte typed view is interpreted only through its native underlying byte range',()=>{
  const storage=Uint8Array.from([255,...header,255,255]);
  const bytes=new DataView(storage.buffer,1,8);
  const parsed=inspectWasmBytes(bytes,{maxModuleBytes:8,maxMemoryPages:1});
  assert.deepEqual([...parsed.bytes],[...header]);
  assert.throws(()=>inspectWasmBytes(bytes,{maxModuleBytes:7,maxMemoryPages:1}),/invalid maximum module size/);
});