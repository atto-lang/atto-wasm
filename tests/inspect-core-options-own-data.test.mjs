import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const minimalCore = Uint8Array.from([0,97,115,109,1,0,0,0]);

function rejectsWithoutRunning(label, options) {
  test(label, () => {
    let reached = 0;
    const input = minimalCore.subarray();
    Object.defineProperty(input, Symbol.iterator, {
      get() { reached++; throw Error('hostile byte iterator invoked'); }
    });
    assert.throws(() => inspectWasmBytes(input, options), /invalid Wasm inspection options/);
    assert.equal(reached, 0, 'must fail before touching input iterator');
  });
}

test('own budget getters are rejected without invocation', () => {
  for (const name of ['maxModuleBytes', 'maxMemoryPages']) {
    let calls = 0;
    const options = Object.create(null);
    Object.defineProperty(options, name, {
      enumerable: true,
      get() { calls++; throw Error('hostile budget getter invoked'); }
    });
    assert.throws(() => inspectWasmBytes(minimalCore, options), /invalid Wasm inspection options/);
    assert.equal(calls, 0, name);
  }
});

test('Proxy options are denied without triggering reflective traps', () => {
  let calls = 0;
  const options = new Proxy({}, {
    getPrototypeOf() { calls++; throw Error('proxy getPrototypeOf trap executed'); },
    ownKeys() { calls++; throw Error('proxy ownKeys trap executed'); },
    getOwnPropertyDescriptor() { calls++; throw Error('proxy descriptor trap executed'); },
    get() { calls++; throw Error('proxy property trap executed'); }
  });
  assert.throws(() => inspectWasmBytes(minimalCore, options), /invalid Wasm inspection options/);
  assert.equal(calls, 0);
});

rejectsWithoutRunning('unknown budget option rejected', {maxModuleBytes:8, override:1});
rejectsWithoutRunning('non-enumerable budget option rejected',
  Object.defineProperty({}, 'maxModuleBytes', {value:8, enumerable:false}));
rejectsWithoutRunning('inherited budget option rejected',
  Object.create({maxModuleBytes:8}));
rejectsWithoutRunning('symbol budget option rejected',
  {[Symbol.toStringTag]:'x'});
rejectsWithoutRunning('array budget option rejected', []);
rejectsWithoutRunning('null budget option rejected', null);

test('frozen and null-prototype inert option records still accept exact Wasm control', () => {
  for (const options of [Object.freeze({maxModuleBytes:8,maxMemoryPages:1}),
                         Object.assign(Object.create(null), {maxModuleBytes:8,maxMemoryPages:1}),
                         undefined]) {
    const inspected = inspectWasmBytes(minimalCore,options);
    assert.equal(inspected.bytes.length, 8);
    assert.equal(inspected.memoryCount, 0);
    assert.equal(WebAssembly.validate(inspected.bytes), true);
  }
});

test('invalid own-data budgets still fail their explicit numeric limits', () => {
  for (const options of [{maxModuleBytes:7},{maxModuleBytes:16*1024*1024+1},
                         {maxMemoryPages:0},{maxMemoryPages:257},
                         {maxModuleBytes:Infinity}])
    assert.throws(() => inspectWasmBytes(minimalCore,options), /invalid maximum/);
});
