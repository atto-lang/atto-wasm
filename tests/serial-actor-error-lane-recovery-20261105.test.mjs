import test from 'node:test';
import assert from 'node:assert/strict';
import {createSerialOwnedActor} from '../transport/serial-actor-reference.mjs';

const schema={schemaVersion:1,ownership:'copy',variants:[
 {id:1,name:'Compute',fields:[{name:'text',type:'string'},{name:'n',type:'i64'}]},
 {id:2,name:'Result',fields:[{name:'text',type:'string'},{name:'n',type:'i64'}]}
]};
const compute=(text,n)=>({variant:'Compute',fields:{text,n:BigInt(n)}});
const result=(text,n)=>({variant:'Result',fields:{text,n:BigInt(n)}});

test('a failing guest-like callback cannot strand the next serial host delivery',async()=>{
 let turns=0;
 const actor=createSerialOwnedActor({schema,receive:async(mail,self)=>{
  turns++;
  if(turns===1)throw Error('deliberate callback fault');
  await self.respond(result(mail.fields.text,mail.fields.n+1n));
  self.done();
 }});
 await assert.rejects(actor.request(compute('first',1)),/deliberate callback fault/);
 assert.deepEqual(await actor.request(compute('second',2)),result('second',3));
 assert.equal(turns,2);
 assert.equal(actor.pending,0);
 assert.equal(actor.idle,true);
});

test('stolen self from failed turn remains revoked after a new turn succeeds',async()=>{
 let stale;
 const actor=createSerialOwnedActor({schema,receive:async(mail,self)=>{
  if(mail.fields.n===1n){stale=self;throw Error('first failed');}
  await self.respond(result('ok',7));self.done();
 }});
 await assert.rejects(actor.request(compute('first',1)),/first failed/);
 assert.deepEqual(await actor.request(compute('second',2)),result('ok',7));
 assert.throws(()=>stale.done(),/already completed/);
 assert.throws(()=>stale.respond(result('forged',9)),/already completed/);
});

test('closing the idle actor permanently seals admission and never reopens the queue',async()=>{
 const actor=createSerialOwnedActor({schema,maxPending:1,receive:async()=>{}});
 assert.equal(actor.idle,true);
 actor.close();actor.close();
 await assert.rejects(actor.request(compute('later',8)),/actor closed/);
 await assert.rejects(actor.tell(compute('later',9)),/actor closed/);
 assert.equal(actor.pending,0);
});
