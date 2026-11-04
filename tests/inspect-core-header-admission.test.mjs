import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const emptyCore=[0,97,115,109,1,0,0,0];
const parse=bytes=>inspectWasmBytes(Uint8Array.from(bytes),{maxModuleBytes:64});

test('canonical empty core header admits an unchanged owned snapshot',()=>{
 const original=Uint8Array.from(emptyCore);
 assert.equal(WebAssembly.validate(original),true);
 const parsed=inspectWasmBytes(original,{maxModuleBytes:8});
 assert.equal(parsed.memoryCount,0);
 assert.deepEqual([...parsed.bytes],emptyCore);
 original[1]=0;
 assert.equal(parsed.bytes[1],97,'admitted bytes cannot alias the caller');
});

test('every corrupted header byte and each truncated prefix fails closed',()=>{
 for(let i=0;i<emptyCore.length;i++){
  const changed=emptyCore.slice();changed[i]^=1;
  assert.throws(()=>parse(changed),/invalid core module header/,`byte ${i}`);
  assert.throws(()=>parse(emptyCore.slice(0,i)),/invalid core module header/,`prefix ${i}`);
 }
});

test('header refusal cannot invoke a caller-defined iterator or fake byteLength',()=>{
 const hostile=Uint8Array.from(emptyCore);hostile[4]=2;
 let accessed=0;
 Object.defineProperty(hostile,Symbol.iterator,{get(){accessed++;throw Error('iterator executed');}});
 Object.defineProperty(hostile,'byteLength',{get(){accessed++;throw Error('length executed');}});
 assert.throws(()=>inspectWasmBytes(hostile,{maxModuleBytes:8}),/invalid core module header/);
 assert.equal(accessed,0);
});
