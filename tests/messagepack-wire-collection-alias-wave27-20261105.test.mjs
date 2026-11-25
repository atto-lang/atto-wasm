// Host MessagePack v2 collection contracts, not a compiled guest transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {encodeCollectionV2,decodeCollectionV2} from '../transport/messagepack-v2.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const schema='com.example.CollectionIdentity.v2';

test('collection decode snapshots an offset DataView before asynchronous digest',async()=>{
  const frame=await encodeCollectionV2(schema,'T[S,I]',['alpha',42n]);
  const bytes=new Uint8Array(frame.length+8).fill(0x5a);
  bytes.set(frame,4);
  const view=new DataView(bytes.buffer,4,frame.length);
  const pending=decodeCollectionV2(schema,'T[S,I]',view);
  bytes.fill(0);
  const decoded=await pending;
  assert.deepEqual(decoded,['alpha',42n]);
  assert.equal(Object.isFrozen(decoded),true);
});

test('typed i64, finite f64 and strict Unicode reject silent coercion',async()=>{
  await assert.rejects(encodeCollectionV2(schema,'I',42),/signed i64 BigInt/);
  await assert.rejects(encodeCollectionV2(schema,'F',Infinity),/finite f64/);
  await assert.rejects(encodeCollectionV2(schema,'S','bad\ud800'),/unpaired surrogate/);
});

test('digest-bound schema identity and shared backing are never admitted',async()=>{
  const frame=await encodeCollectionV2(schema,'I',-32n);
  await assert.rejects(decodeCollectionV2(schema+'-other','I',frame),/message schema mismatch/);
  if(typeof SharedArrayBuffer==='function'){
    const shared=new Uint8Array(new SharedArrayBuffer(frame.length));
    shared.set(frame);
    await assert.rejects(decodeCollectionV2(schema,'I',shared),/shared input rejected/);
  }
});
