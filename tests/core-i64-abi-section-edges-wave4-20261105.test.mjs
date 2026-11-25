import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

const header=[0,97,115,109,1,0,0,0];
const section=(id,body)=>[id,body.length,...body];
const main=()=>Uint8Array.from([...header,
  ...section(1,[1,0x60,0,1,0x7e]),
  ...section(3,[1,0]),
  ...section(7,[1,4,109,97,105,110,0,0]),
  ...section(10,[1,4,0,0x42,42,0x0b])]);

test('canonical valid i64 module survives a harmless custom section', () => {
  const ordinary=main();
  const extra=Uint8Array.from([...header, ...section(0,[1,120]), ...ordinary.slice(8)]);
  assert.equal(WebAssembly.validate(ordinary), true);
  assert.equal(WebAssembly.validate(extra), true);
  assert.doesNotThrow(() => assertCoreI64Entry(extra,'main'));
});

test('entry-point identity is case-sensitive and exact', () => {
  assert.doesNotThrow(() => assertCoreI64Entry(main(),'main'));
  assert.throws(() => assertCoreI64Entry(main(),'Main'), /exact \(\) -> i64 signature/);
  assert.throws(() => assertCoreI64Entry(main(),'main '), /exact \(\) -> i64 signature/);
});

test('noncanonical section sizes are rejected instead of aliased', () => {
  const bad=Uint8Array.from([...header,1,0x81,0x00,0x00]);
  assert.throws(() => assertCoreI64Entry(bad,'main'), /noncanonical Wasm ABI integer/);
  const truncated=Uint8Array.from([...header,7,100,1]);
  assert.throws(() => assertCoreI64Entry(truncated,'main'), /truncated Wasm ABI section/);
});
