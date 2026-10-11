import test from "node:test";
import assert from "node:assert/strict";
import {encodeMessage,decodeMessage,OWNED_ENVELOPE_V1} from "../transport/owned-envelope.mjs";
const contract={schemaVersion:1,ownership:"copy",variants:[
 {id:2,name:"Result",fields:[{name:"text",type:"string"},{name:"next",type:"i64"}]},
 {id:1,name:"Compute",fields:[{name:"text",type:"string"},{name:"n",type:"i64"}]},
 {id:3,name:"Batch",fields:[
  {name:"pair",type:{tuple:["string","i64"]}},
  {name:"fixed",type:{array:{element:"bool",length:2}}},
  {name:"items",type:{list:{element:"string",maxLength:3}}},
  {name:"state",type:{enum:[
   {id:2,name:"Some",payload:{tuple:["i64","string"]}},
   {id:1,name:"None",payload:null}]}},
  {name:"blob",type:"bytes"}]}
]};
test("Compute/Result preserve full-width signed i64 values through binary wire",async()=>{
 for(const m of [
  {variant:"Compute",fields:{text:"hello 🌎",n:41n}},
  {variant:"Result",fields:{text:"hello",next:42n}},
  {variant:"Result",fields:{text:"negative",next:-(1n<<63n)}},
  {variant:"Result",fields:{text:"large",next:(1n<<63n)-1n}}
 ]){
  const bytes=await encodeMessage(contract,m);
  assert.deepEqual([...bytes.subarray(0,4)],[79,82,77,49]);
  assert.deepEqual(await decodeMessage(contract,bytes),m);
 }
 assert.equal(OWNED_ENVELOPE_V1.ownership,"copy");
});
test("tuple, fixed array, list, nested enum and owned binary are typed",async()=>{
 const fields={pair:["hi",-7n],fixed:[true,false],items:["a","b"],
  state:{variant:"Some",value:[42n,"yes"]},blob:Uint8Array.of(1,2,3)};
 const bytes=await encodeMessage(contract,{variant:"Batch",fields});
 fields.blob[0]=255;
 const result=await decodeMessage(contract,bytes);
 assert.equal(result.fields.blob[0],1);
 assert.deepEqual(result.fields.state,{variant:"Some",value:[42n,"yes"]});
 assert.equal(Object.isFrozen(result.fields.pair),true);
 const noPayload=await encodeMessage(contract,{variant:"Batch",fields:{...fields,state:{variant:"None",value:null}}});
 assert.equal((await decodeMessage(contract,noPayload)).fields.state.variant,"None");
});
test("contract fingerprint is deterministic for reordered variant declarations",async()=>{
 const m={variant:"Compute",fields:{text:"x",n:7n}};
 const a=await encodeMessage(contract,m),b=await encodeMessage({...contract,variants:[...contract.variants].reverse()},m);
 assert.deepEqual(a,b);
});
test("schema agreement uses exact SHA-256, never just a numeric variant tag",async()=>{
 const bytes=await encodeMessage(contract,{variant:"Compute",fields:{text:"x",n:41n}});
 const changed={...contract,variants:contract.variants.map(v=>v.name==="Compute"
  ?{...v,fields:[{name:"n",type:"i64"},{name:"text",type:"string"}]}:v)};
 await assert.rejects(decodeMessage(changed,bytes),/contract SHA-256 mismatch/);
 const corrupted=bytes.slice();corrupted[12]^=1;
 await assert.rejects(decodeMessage(contract,corrupted),/contract SHA-256 mismatch/);
});
test("invalid variants, i64 range, schema smuggling, lengths and enum payloads fail closed",async()=>{
 for(const m of [
  {variant:"Unknown",fields:{}},
  {variant:"Compute",fields:{text:"x",n:41}},
  {variant:"Compute",fields:{text:"x",n:1n<<63n}},
  {variant:"Compute",fields:{text:"x",n:42n,extra:1}},
  {variant:"Compute",fields:{text:"x"}},
  {variant:"Compute",fields:{text:"\ud800",n:42n}}
 ])await assert.rejects(encodeMessage(contract,m));
 const fields={pair:["hi",42n],fixed:[true,false],items:["a","b"],
  state:{variant:"None",value:null},blob:Uint8Array.of(1)};
 for(const bad of [
  {...fields,fixed:[true]},
  {...fields,items:["a","b","c","d"]},
  {...fields,state:{variant:"Wrong",value:null}},
  {...fields,state:{variant:"None",value:4}}
 ])await assert.rejects(encodeMessage(contract,{variant:"Batch",fields:bad}));
 for(const revised of [
  {...contract,ownership:"borrow"},
  {...contract,variants:[contract.variants[0],contract.variants[0]]},
  {...contract,variants:[{id:9,name:"Bad",fields:[{name:"x",type:"evil"}]}]},
  {...contract,variants:[{id:9,name:"Bad",fields:[{name:"x",type:{list:{element:"i64",maxLength:5000}}}]}]}
 ])await assert.rejects(encodeMessage(revised,{variant:"Compute",fields:{text:"x",n:41n}}));
});
test("header tampering, truncation and extraneous payload are rejected",async()=>{
 const bytes=await encodeMessage(contract,{variant:"Compute",fields:{text:"x",n:42n}});
 for(const bad of [bytes.subarray(0,bytes.length-1),Uint8Array.from([...bytes,0]),
  Uint8Array.of(0,1,2)])await assert.rejects(decodeMessage(contract,bad));
 for(const at of [0,4,5,6]){const b=bytes.slice();b[at]^=255;await assert.rejects(decodeMessage(contract,b));}
});
test("untrusted input is snapshotted before async hashing",async()=>{
 const bytes=await encodeMessage(contract,{variant:"Compute",fields:{text:"safe",n:41n}});
 const pending=decodeMessage(contract,bytes);
 bytes.fill(0);
 assert.equal((await pending).fields.text,"safe");
});
test("bounded messages and explicitly nonshared ownership",async()=>{
 const msg={variant:"Compute",fields:{text:"x".repeat(500),n:42n}};
 await assert.rejects(encodeMessage(contract,msg,{maxBytes:80}),/budget/);
 const bytes=await encodeMessage(contract,msg);
 await assert.rejects(decodeMessage(contract,bytes,{maxBytes:80}),/size/);
 if(typeof SharedArrayBuffer!=="undefined"){
  const shared=new Uint8Array(new SharedArrayBuffer(bytes.length));shared.set(bytes);
  await assert.rejects(decodeMessage(contract,shared),/shared memory not admitted/);
  const fields={pair:["hi",1n],fixed:[true,false],items:[],state:{variant:"None",value:null},
   blob:new Uint8Array(new SharedArrayBuffer(4))};
  await assert.rejects(encodeMessage(contract,{variant:"Batch",fields}),/shared memory not admitted/);
 }
});
