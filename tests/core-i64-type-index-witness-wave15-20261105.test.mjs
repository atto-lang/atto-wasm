import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry as check} from '../scripts/core-i64-abi.mjs';

const header=[0,97,115,109,1,0,0,0];
const sec=(id,data)=>[id,data.length,...data];
const moduleBytes=(exportIndex=[1],kind=0)=>Uint8Array.from([
  ...header,
  ...sec(1,[2,0x60,0,1,0x7f,0x60,0,1,0x7e]),
  ...sec(3,[2,0,1]),
  ...sec(7,[1,4,109,97,105,110,kind,...exportIndex]),
  ...sec(10,[2,4,0,0x41,42,0x0b,4,0,0x42,42,0x0b])
]);

test('real function index selects the second i64 type instead of first i32 type',()=>{
  const valid=moduleBytes([1]);
  assert.equal(WebAssembly.validate(valid),true);
  assert.doesNotThrow(()=>check(valid,'main'));
  const wrong=moduleBytes([0]);
  assert.equal(WebAssembly.validate(wrong),true);
  assert.throws(()=>check(wrong,'main'),/exact \(\) -> i64 signature/);
});

test('out-of-range index, wrong export kind and missing entry cannot gain authority',()=>{
  assert.throws(()=>check(moduleBytes([2]),'main'),/exact \(\) -> i64 signature/);
  assert.throws(()=>check(moduleBytes([1],2),'main'),/core Wasm entry is not a function/);
  assert.throws(()=>check(moduleBytes([1]),'Main'),/exact \(\) -> i64 signature/);
});

test('noncanonical padded varuint alias rejected even when Wasm engine accepts it',()=>{
  const padded=moduleBytes([0x81,0]);
  assert.equal(WebAssembly.validate(padded),true);
  assert.throws(()=>check(padded,'main'),/noncanonical Wasm ABI integer/);
  assert.doesNotThrow(()=>check(moduleBytes([1]),'main'));
});
