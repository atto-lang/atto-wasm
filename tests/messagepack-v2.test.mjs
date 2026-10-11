import test from "node:test";
import assert from "node:assert/strict";
import {encodeActorMessage,decodeActorMessage,MESSAGEPACK_ACTOR_V2} from "../transport/messagepack-v2.mjs";

const vector=[
 ["demo.TupleBoolString.v1","T[B,S]",[true,"foo"],"9402b764656d6f2e5475706c65426f6f6c537472696e672e7631c420d254b4ecd3d7964454dcdf86fd10ede585a17b3af27982a289819afdc2379ab292c3a3666f6f"],
 ["demo.FixedArrayInts.v1","FA[I,I,I]",[1n,2n,3n],"9402b664656d6f2e46697865644172726179496e74732e7631c4206a46f6c65c619cc1c5354f7bd3b35ec0fcfbc9866c0760a15b860cfef79773b993010203"],
 ["demo.FixedListNested.v1","FL[L[S],B]",[["a","b"],false],"9402b764656d6f2e46697865644c6973744e65737465642e7631c4202007a0279d88d3eca7d21cf32b37327b996593c1353963dd78555f56f1ba6ddc9292a161a162c2"],
 ["demo.ArrayStrings.v1","A[S]",["a","b"],"9402b464656d6f2e4172726179537472696e67732e7631c420139722a10b9ef4d4af0cea1bfbc50ff92a0459aabf837f63a6fec052fe5dc5c992a161a162"],
 ["demo.ListStrings.v1","L[S]",["a","b"],"9402b364656d6f2e4c697374537472696e67732e7631c4204efbea59591d5c31d9f13ee93ef5c1d954e653144d380bb2d064ea4fa6d56b8c92a161a162"],
 ["demo.String.v1","S","foo","9402ae64656d6f2e537472696e672e7631c42021c2efdbff08dd4e1320d8abe1ba0cc6aea8e4cf104b984be7b7079968fad3cda3666f6f"]
];
const hex=b=>Buffer.from(b).toString("hex");
const alt=shape=>[{id:1,shape}];
test("exact six production Java and native LLVM canonical MessagePack v2 golden vectors",async()=>{
 for(const [domain,shape,input,golden] of vector){
  const frame=await encodeActorMessage(domain,alt(shape),1,input);
  assert.equal(hex(frame),golden,domain);
  const decoded=await decodeActorMessage(domain,alt(shape),Buffer.from(golden,"hex"));
  assert.equal(decoded.variantId,1);
  assert.deepEqual(decoded.value,input);
 }
});
test("closed variant identity distinguishes shape-identical messages",async()=>{
 const variants=[{id:11,shape:"S"},{id:12,shape:"S"},{id:13,shape:"T[S,I]"}];
 const a=await encodeActorMessage("demo.ActorWorker.v1",variants,11,"same");
 const b=await encodeActorMessage("demo.ActorWorker.v1",variants,12,"same");
 assert.notDeepEqual(a,b);
 assert.equal((await decodeActorMessage("demo.ActorWorker.v1",variants,a)).variantId,11);
 assert.equal((await decodeActorMessage("demo.ActorWorker.v1",variants,b)).variantId,12);
 const c=await encodeActorMessage("demo.ActorWorker.v1",variants,13,["hello",-(1n<<63n)]);
 assert.deepEqual((await decodeActorMessage("demo.ActorWorker.v1",variants,c)).value,["hello",-(1n<<63n)]);
 const other=await encodeActorMessage("demo.OtherWorker.v1",[{id:11,shape:"S"}],11,"same");
 await assert.rejects(decodeActorMessage("demo.ActorWorker.v1",variants,other),/schema/);
 await assert.rejects(encodeActorMessage("demo.ActorWorker.v1",variants,14,"unknown"),/undeclared/);
});
test("noncanonical integer and UTF-8 spellings cannot pass typed admission",async()=>{
 const domain="demo.Actor.v1",variants=[{id:1,shape:"I"}];
 const good=await encodeActorMessage(domain,variants,1,42n);
 const noncanonical=Uint8Array.from([...good.slice(0,-1),0xcc,42]);
 await assert.rejects(decodeActorMessage(domain,variants,noncanonical),/noncanonical/);
 const bad=await encodeActorMessage(domain,[{id:1,shape:"S"}],1,"safe");
 bad[bad.length-1]=0xff;
 await assert.rejects(decodeActorMessage(domain,[{id:1,shape:"S"}],bad),/UTF-8/);
});
test("version, variant, shape hash, truncated envelope and trailing bytes fail closed",async()=>{
 const domain="demo.Actor.v1",variants=[{id:1,shape:"I"}];
 const valid=await encodeActorMessage(domain,variants,1,42n);
 const corrupted=valid.slice();corrupted[1]=1;
 await assert.rejects(decodeActorMessage(domain,variants,corrupted));
 const changed=valid.slice();changed[changed.indexOf(0xc4)+2]^=1;
 await assert.rejects(decodeActorMessage(domain,variants,changed));
 await assert.rejects(decodeActorMessage(domain,variants,valid.slice(0,-1)));
 await assert.rejects(decodeActorMessage(domain,variants,Uint8Array.from([...valid,0])));
 await assert.rejects(decodeActorMessage(domain,[{id:1,shape:"S"}],valid));
});
test("caller-owned binary input is detached before asynchronous hash verification",async()=>{
 const domain="demo.Actor.v1",variants=[{id:1,shape:"S"}];
 const msg=await encodeActorMessage(domain,variants,1,"hello");
 const future=decodeActorMessage(domain,variants,msg);
 msg.fill(0);
 assert.equal((await future).value,"hello");
});
test("signed i64, finite float64, strict UTF-8, cycles and malformed descriptors",async()=>{
 const domain="demo.Typed.v1";
 for(const n of [-(1n<<63n),-129n,0n,127n,255n,65539n,(1n<<63n)-1n]){
  const msg=await encodeActorMessage(domain,[{id:1,shape:"I"}],1,n);
  assert.equal((await decodeActorMessage(domain,[{id:1,shape:"I"}],msg)).value,n);
 }
 for(const v of [0.5,-0,Math.PI]){
  const msg=await encodeActorMessage(domain,[{id:2,shape:"F"}],2,v);
  assert.equal(Object.is((await decodeActorMessage(domain,[{id:2,shape:"F"}],msg)).value,v),true);
 }
 await assert.rejects(encodeActorMessage(domain,[{id:2,shape:"F"}],2,Infinity));
 await assert.rejects(encodeActorMessage(domain,[{id:3,shape:"S"}],3,"\ud800"),/surrogate/);
 const cycle=[];cycle.push(cycle);
 await assert.rejects(encodeActorMessage(domain,[{id:4,shape:"L[L[I]]"}],4,cycle),/cyclic|sequence/);
 for(const descriptor of ["Y","T[I","A[I,S]","Igarbage","T[F,,I]"])
  await assert.rejects(encodeActorMessage(domain,[{id:1,shape:descriptor}],1,42n));
 assert.equal(MESSAGEPACK_ACTOR_V2.version,2);
});
test("oversized input, spoofed domain, duplicate IDs and shared buffers fail closed",async()=>{
 const domain="demo.Actor.v1",variants=[{id:1,shape:"S"}];
 await assert.rejects(encodeActorMessage(domain,[{id:1,shape:"S"},{id:1,shape:"I"}],1,"x"));
 await assert.rejects(encodeActorMessage("bad#variant=0",variants,1,"x"));
 await assert.rejects(encodeActorMessage(domain,variants,1,"x".repeat(1048576)),/budget|large/);
 if(typeof SharedArrayBuffer!=="undefined"){
  const s=new Uint8Array(new SharedArrayBuffer(32));
  await assert.rejects(decodeActorMessage(domain,variants,s),/shared/);
 }
});
