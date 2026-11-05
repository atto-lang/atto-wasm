import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectWasmBytes} from '../scripts/inspect-core-memory.mjs';

const header=[0,97,115,109,1,0,0,0];
const bytes=(...tail)=>Uint8Array.from([...header,...tail]);

test('declared section length cannot exceed owned bytes',()=>{
 assert.throws(()=>inspectWasmBytes(bytes(0,5,1,97,0)),/section extends beyond module/);
});
test('nonterminated and oversized u32 section lengths fail closed',()=>{
 assert.throws(()=>inspectWasmBytes(bytes(0,0x80)),/truncated unsigned integer/);
 assert.throws(()=>inspectWasmBytes(bytes(0,0xff,0xff,0xff,0xff,0x1f)),/invalid u32 encoding/);
});
test('a bounded start section still cannot execute before admission',()=>{
 assert.throws(()=>inspectWasmBytes(bytes(8,1,0)),/start section is forbidden/);
});
