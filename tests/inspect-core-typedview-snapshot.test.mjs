import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];

test('typed-array subviews use native slots, never attacker-owned getters or iterators',()=>{
  const padded=Uint8Array.from([255,...header,254]);
  const view=new Uint8Array(padded.buffer,1,header.length);
  let called=0;
  for(const key of ['buffer','byteOffset','byteLength']){
    Object.defineProperty(view,key,{get(){called++;throw Error('hostile '+key);}});
  }
  Object.defineProperty(view,Symbol.iterator,{value:function*(){
    called++;throw Error('hostile iterator');
  }});
  const result=inspectWasmBytes(view,{maxModuleBytes:8});
  assert.deepEqual(Array.from(result.bytes),header);
  assert.equal(called,0);
  padded[1]=255;
  assert.equal(result.bytes[0],0,'the admitted snapshot must not alias source memory');
});

test('Node Buffer subarray cannot expose bytes outside its original view',()=>{
  const padded=Buffer.from([253,...header,252]);
  const view=padded.subarray(1,9);
  let called=0;
  Object.defineProperty(view,Symbol.iterator,{value:function*(){
    called++;throw Error('untrusted iterator');
  }});
  const result=inspectWasmBytes(view,{maxModuleBytes:8});
  assert.deepEqual(Array.from(result.bytes),header);
  assert.equal(called,0);
  assert.equal(result.bytes.length,8);
});
