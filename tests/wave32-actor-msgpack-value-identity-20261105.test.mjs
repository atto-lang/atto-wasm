// Host MessagePack v2 only: not compiler lowering or Wasm guest evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeActorMessage,decodeActorMessage} from '../transport/messagepack-v2.mjs';

const domain = 'demo.Wave32.Actor.v1';
const variants = [{id:7,shape:'T[B,S]'}];

test('encoded actor payload keeps the admitted value after caller mutation', async () => {
  const payload = [true,'initial'];
  const wire = await encodeActorMessage(domain,variants,7,payload);
  payload[0] = false;
  payload[1] = 'changed';
  const received = await decodeActorMessage(domain,variants,wire);
  assert.equal(received.variantId,7);
  assert.deepEqual(received.value,[true,'initial']);
  received.value[1] = 'consumer-mutation';
  assert.deepEqual((await decodeActorMessage(domain,variants,wire)).value,[true,'initial']);
});

test('same wire cannot inherit authority from another domain or variant set', async () => {
  const wire = await encodeActorMessage(domain,variants,7,[false,'ok']);
  await assert.rejects(decodeActorMessage('demo.OtherActor.v1',variants,wire));
  await assert.rejects(decodeActorMessage(domain,[{id:8,shape:'T[B,S]'}],wire));
});
