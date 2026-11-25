// Host MessagePack wire reference only, not Wasm compilation or actor execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage,decodeActorMessage} from '../transport/messagepack-v2.mjs';

const domain='demo.Wave40.Actor.v1';
const choices=[{id:11,shape:'S'},{id:12,shape:'S'}];

test('same text under distinct variants never has identical authority bytes', async () => {
  const first=await encodeActorMessage(domain,choices,11,'same');
  const second=await encodeActorMessage(domain,choices,12,'same');
  assert.notDeepEqual(first,second);
  const one=await decodeActorMessage(domain,choices,first);
  const two=await decodeActorMessage(domain,choices,second);
  assert.deepEqual([one.variantId,one.value],[11,'same']);
  assert.deepEqual([two.variantId,two.value],[12,'same']);
  assert.ok(Object.isFrozen(one));
});

test('wrong domain, wrong shape and appended garbage cannot borrow valid wire identity', async () => {
  const frame=await encodeActorMessage(domain,choices,11,'valid');
  await assert.rejects(decodeActorMessage('demo.OtherActor.v1',choices,frame));
  await assert.rejects(decodeActorMessage(domain,[{id:11,shape:'I'}],frame));
  await assert.rejects(decodeActorMessage(domain,choices,
    Uint8Array.from([...frame,0])));
});
