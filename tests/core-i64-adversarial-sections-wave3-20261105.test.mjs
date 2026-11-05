import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const head=[0,97,115,109,1,0,0,0];
const sec=(id,body)=>[id,body.length,...body];
function moduleBytes(kind=0,resultType=0x7e){
  const bytes=[109,97,105,110];
  return Uint8Array.from([...head,
    ...sec(1,[1,0x60,0,1,resultType]),
    ...sec(3,[1,0]),
    ...sec(7,[1,bytes.length,...bytes,kind,0]),
    ...sec(10,[1,4,0,resultType===0x7e?0x42:0x41,42,0x0b])
  ]);
}

test('valid () -> i64 function export is admitted, not an i32 function',()=>{
  const valid=moduleBytes();
  assert.equal(WebAssembly.validate(valid),true);
  assert.doesNotThrow(()=>assertCoreI64Entry(valid,'main'));
  const wrong=moduleBytes(0,0x7f);
  assert.equal(WebAssembly.validate(wrong),true);
  assert.throws(()=>assertCoreI64Entry(wrong,'main'),/exact \(\) -> i64 signature/);
});

test('entry name never authorizes a nonfunction export kind',()=>{
  assert.throws(()=>assertCoreI64Entry(moduleBytes(2),'main'),/not a function/);
  assert.throws(()=>assertCoreI64Entry(moduleBytes(0),'Main'),/exact \(\) -> i64 signature/);
});

test('oversized section lengths and invalid u32 encodings fail closed',()=>{
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,99,1]),'main'),/truncated Wasm ABI section/);
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,0x80,0x80,0x80,0x80,0x80]),'main'),/invalid Wasm ABI integer/);
  assert.throws(()=>assertCoreI64Entry(Uint8Array.from([...head,7,0xff,0xff,0xff,0xff,0x10]),'main'),/invalid Wasm ABI integer/);
});
