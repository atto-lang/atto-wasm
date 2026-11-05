import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const empty = Uint8Array.from([0,97,115,109,1,0,0,0]);

for (const key of ['maxModuleBytes', 'maxMemoryPages']) {
  test(`budget getter that returns a valid number is still rejected: ${key}`, () => {
    let invoked = 0;
    const options = {};
    Object.defineProperty(options, key, {enumerable:true, get() {invoked++; return key === 'maxModuleBytes' ? 8 : 1;}});
    assert.throws(() => inspectWasmBytes(empty, options), /invalid Wasm inspection options/);
    assert.equal(invoked, 0);
  });
}

test('unknown getter is refused without execution', () => {
  let invoked = 0;
  const options = Object.defineProperty({}, 'evil', {
    enumerable:true, get() {invoked++; throw Error('getter ran');}
  });
  assert.throws(() => inspectWasmBytes(empty, options), /invalid Wasm inspection options/);
  assert.equal(invoked, 0);
});

test('revoked Proxy is rejected without any inspection or traps', () => {
  const {proxy, revoke} = Proxy.revocable({}, {ownKeys() {throw Error('proxy trap ran');}});
  revoke();
  assert.throws(() => inspectWasmBytes(empty, proxy), /invalid Wasm inspection options/);
});

test('primitive option records do not silently box', () => {
  for (const options of [1, 0, true, 'hi', Symbol('x'), ()=>{}, null]) {
    assert.throws(() => inspectWasmBytes(empty, options), /invalid Wasm inspection options/);
  }
});

test('explicit undefined preserves documented default budget behavior', () => {
  for (const options of [{maxModuleBytes:undefined},{maxMemoryPages:undefined},
     {maxModuleBytes:undefined,maxMemoryPages:undefined}]) {
    const result=inspectWasmBytes(empty,options);
    assert.equal(result.bytes.length,8);
    assert.equal(result.memoryCount,0);
  }
});
