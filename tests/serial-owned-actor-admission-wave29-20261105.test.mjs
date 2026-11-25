import test from 'node:test';
import assert from 'node:assert/strict';
import {createSerialOwnedActor} from '../transport/serial-actor-reference.mjs';

const receive = async (_message, self) => self.done();

// Host-only admission tests. No claim of guest ABI, Wasm isolation or delivery.
test('constructor rejects unsound pending and encoded byte budgets', () => {
  for (const maxPending of [0, -1, 1.5, 4097, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createSerialOwnedActor({receive, maxPending}), /invalid maxPending/);
  }
  for (const maxBytes of [0, 43, 1048577, NaN]) {
    assert.throws(() => createSerialOwnedActor({receive, maxBytes}), /invalid maxBytes/);
  }
});

test('constructor rejects malformed routes and duplicate reply variants', () => {
  assert.throws(() => createSerialOwnedActor({receive, routeSend: true}), /invalid send route/);
  assert.throws(() => createSerialOwnedActor({receive, routeForward: 42}), /invalid forward route/);
  assert.throws(() => createSerialOwnedActor({
    receive, replyVariants: {Request: ['Response', 'Response']},
  }), /invalid reply variant set/);
  assert.throws(() => createSerialOwnedActor({
    receive, replyVariants: {Request: []},
  }), /invalid reply variant set/);
});

test('closed actor refuses all subsequent admission without activating a lane', async () => {
  const actor = createSerialOwnedActor({receive, maxPending: 1});
  assert.equal(actor.idle, true);
  assert.equal(actor.pending, 0);
  actor.close();
  actor.close();
  await assert.rejects(actor.tell({variant: 'ignored'}), /actor closed/);
  await assert.rejects(actor.request({variant: 'ignored'}), /actor closed/);
  assert.equal(actor.pending, 0);
  assert.equal(actor.idle, true);
});
