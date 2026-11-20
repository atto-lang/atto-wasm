import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];

test('genuine foreign-realm ArrayBuffer and DataView slots are snapshotted without aliasing',()=>{
 for(const value of [runInNewContext('new ArrayBuffer(8)'),runInNewContext('new DataView(new ArrayBuffer(8))')]){
  const backing=ArrayBuffer.isView(value)?value.buffer:value;
  new Uint8Array(backing).set(header);
  const admitted=inspectWasmBytes(value,{maxModuleBytes:8});
  assert.deepEqual([...admitted.bytes],header);
  new Uint8Array(backing)[1]=0;
  assert.equal(admitted.bytes[1],97);
 }
});

test('foreign-realm typed arrays use native offsets and not overridden iterator',()=>{
 const view=runInNewContext('new Uint8Array(new ArrayBuffer(16),4,8)');
 new Uint8Array(view.buffer,4,8).set(header);
 let invoked=0;
 Object.defineProperty(view,Symbol.iterator,{get(){invoked++;throw Error('untrusted iterator');}});
 const admitted=inspectWasmBytes(view,{maxModuleBytes:8});
 assert.equal(invoked,0);
 assert.deepEqual([...admitted.bytes],header);
});

test('detached native byte sources cannot be admitted as previously valid Wasm',()=>{
 for(const kind of ['typed','data','buffer']){
  const array=Uint8Array.from(header);
  const input=kind==='typed'?array:kind==='data'?new DataView(array.buffer):array.buffer;
  structuredClone(array.buffer,{transfer:[array.buffer]});
  assert.throws(()=>inspectWasmBytes(input,{maxModuleBytes:8}),undefined,kind);
 }
});
