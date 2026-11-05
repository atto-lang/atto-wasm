import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage} from '../transport/messagepack-v2.mjs';

test('duplicate, out-of-range and missing variant identifiers are denied',async()=>{
 for(const alternatives of [
  [{id:1,shape:'I'},{id:1,shape:'S'}],
  [{id:0,shape:'I'}],[{id:2147483648,shape:'I'}],
  [{shape:'I'}],[{id:1}],[]
 ])await assert.rejects(encodeActorMessage('Actor',alternatives,1,1n),
   /duplicate variant ID|invalid variant ID|own data ID and shape|expected 1-64 alternatives/);
});

test('variant getters and custom alternative iterators never execute',async()=>{
 let hits=0;
 const hostile={id:1,shape:'I'};
 Object.defineProperty(hostile,'shape',{get(){hits++;throw Error('getter fired');}});
 await assert.rejects(encodeActorMessage('Actor',[hostile],1,1n),/own data ID and shape/);
 const alternatives=[{id:1,shape:'I'}];
 Object.defineProperty(alternatives,Symbol.iterator,{get(){hits++;throw Error('iterator fired');}});
 await assert.rejects(encodeActorMessage('Actor',alternatives,2,1n),/undeclared message variant/);
 assert.equal(hits,0);
});

test('malformed descriptors fail before digesting or publishing binary frames',async()=>{
 for(const shape of ['Q','Iextra','T[I','A[]','S,S','FA[I,'])
  await assert.rejects(encodeActorMessage('Actor',[{id:1,shape}],1,1n),
    /unsupported shape type|trailing shape descriptor|invalid bracket in descriptor|variable sequence requires one type/);
});