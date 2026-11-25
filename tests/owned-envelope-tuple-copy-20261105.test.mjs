import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from '../transport/owned-envelope.mjs';

const schema=()=>({schemaVersion:1,ownership:'copy',variants:[
 {id:7,name:'Item',fields:[
  {name:'pair',type:{tuple:['i64','bool']}},
  {name:'raw',type:'bytes'}
 ]}
]});
const message=()=>({variant:'Item',fields:{pair:[7n,true],raw:Uint8Array.from([1,2,3])}});

test('tuple, signed-i64 and byte fields snapshot before await and decode to frozen owned values',async()=>{
 const record=message(),pending=encodeMessage(schema(),record);
 record.fields.pair[0]=999n;record.fields.raw[0]=255;
 const wire=await pending;
 assert.ok(wire.length>OWNED_ENVELOPE_V1.headerBytes);
 const decoded=await decodeMessage(schema(),wire);
 assert.equal(decoded.variant,'Item');
 assert.deepEqual(decoded.fields.pair,[7n,true]);
 assert.deepEqual([...decoded.fields.raw],[1,2,3]);
 assert.equal(Object.isFrozen(decoded.fields.pair),true);
 assert.equal(Object.isFrozen(decoded.fields),true);
 wire[OWNED_ENVELOPE_V1.headerBytes]=0;
 assert.deepEqual([...decoded.fields.raw],[1,2,3]);
});

test('sparse/accessor tuple elements and wrong scalar types are never serialized',async()=>{
 const sparse=message();delete sparse.fields.pair[0];
 await assert.rejects(encodeMessage(schema(),sparse),/sparse tuple value/);
 const accessor=message();let calls=0;
 Object.defineProperty(accessor.fields.pair,'0',{get(){calls++;throw Error('getter called')}});
 await assert.rejects(encodeMessage(schema(),accessor),/sparse tuple value/);
 assert.equal(calls,0);
 const wrong=message();wrong.fields.pair=[7,true];
 await assert.rejects(encodeMessage(schema(),wrong),/signed i64 BigInt required/);
});

test('accessor-backed contract descriptors and extra fields fail before hashing',async()=>{
 const c=schema();let called=0;
 Object.defineProperty(c.variants[0].fields[0],'name',{get(){called++;throw Error('malicious schema getter')}});
 await assert.rejects(encodeMessage(c,message()),/invalid field shape/);
 assert.equal(called,0);
 const extra=message();extra.fields.unexpected=true;
 await assert.rejects(encodeMessage(schema(),extra),/invalid message fields shape/);
});
