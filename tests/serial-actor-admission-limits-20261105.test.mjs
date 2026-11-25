import test from 'node:test';
import assert from 'node:assert/strict';
import {createSerialOwnedActor} from '../transport/serial-actor-reference.mjs';

const receive=()=>{throw Error('unreachable without messaging');};

test('serial actor is idle before admission and cannot accept messages after closure',async()=>{
 const actor=createSerialOwnedActor({receive,maxPending:1,maxBytes:44});
 assert.equal(actor.pending,0);
 assert.equal(actor.idle,true);
 actor.close();
 actor.close();
 await assert.rejects(actor.tell({variant:'Compute',fields:{}}),/actor closed/);
 await assert.rejects(actor.request({variant:'Compute',fields:{}}),/actor closed/);
 assert.equal(actor.idle,true);
});

test('host limits reject fractional and out-of-range mailbox or encoded-byte capacities',()=>{
 for(const maxPending of [0,-1,4097,0.5,Infinity,NaN])
  assert.throws(()=>createSerialOwnedActor({receive,maxPending}),/invalid maxPending/);
 for(const maxBytes of [0,43,1048577,0.5,Infinity,NaN])
  assert.throws(()=>createSerialOwnedActor({receive,maxBytes}),/invalid maxBytes/);
 assert.doesNotThrow(()=>createSerialOwnedActor({receive,maxPending:4096,maxBytes:1048576}));
});

test('invalid host routes and variant mappings fail before any mailbox delivery',()=>{
 for(const option of [{routeSend:42},{routeForward:'unsafe'},
  {replyVariants:{Compute:[]}},{replyVariants:{Compute:['Result','Result']}},
  {replyVariants:{Compute:[1]}},{replyVariants:[]}])
  assert.throws(()=>createSerialOwnedActor({receive,...option}));
 assert.throws(()=>createSerialOwnedActor({}),/receive callback required/);
});
