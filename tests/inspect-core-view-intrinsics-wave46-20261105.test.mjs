import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const head = [0, 97, 115, 109, 1, 0, 0, 0];

test('typed-array own buffer and offset getters cannot replace its internal slots', () => {
  const host = Uint8Array.from([255, ...head, 254]);
  const view = host.subarray(1, 9);
  let traps = 0;
  for (const prop of ['buffer', 'byteOffset', 'byteLength']) {
    Object.defineProperty(view, prop, {get() {traps++; throw Error('caller getter ran');}});
  }
  const receipt = inspectWasmBytes(view, {maxModuleBytes: 8});
  assert.deepEqual([...receipt.bytes], head);
  assert.equal(traps, 0);
  host.fill(0);
  assert.deepEqual([...receipt.bytes], head);
});

test('DataView own buffer and offset getters cannot affect its bounded snapshot', () => {
  const host = Uint8Array.from([255, ...head, 254]);
  const view = new DataView(host.buffer, 1, 8);
  let traps = 0;
  for (const prop of ['buffer', 'byteOffset', 'byteLength']) {
    Object.defineProperty(view, prop, {get() {traps++; throw Error('caller getter ran');}});
  }
  const receipt = inspectWasmBytes(view, {maxModuleBytes: 8});
  assert.deepEqual([...receipt.bytes], head);
  assert.equal(traps, 0);
});

test('a proxy cannot impersonate a backed typed array view at admission', () => {
  let getterCalls = 0;
  const proxy = new Proxy(Uint8Array.from(head), {
    get() {getterCalls++; throw Error('proxy get should not run');}
  });
  assert.throws(() => inspectWasmBytes(proxy), /expected a Wasm ArrayBuffer or typed array/);
  assert.equal(getterCalls, 0);
});
