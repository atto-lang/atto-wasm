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

test("decoder preserves __proto__ as ordinary field without mutating its prototype",async()=>{
 const schema={schemaVersion:1,ownership:"copy",variants:[{id:1,name:"Proto",fields:[
  {name:"__proto__",type:{enum:[{id:1,name:"Some",payload:"string"}]}}
 ]}]};
 const fields=Object.create(null);
 fields.__proto__={variant:"Some",value:"not a prototype"};
 const bytes=await encodeMessage(schema,{variant:"Proto",fields});
 const result=await decodeMessage(schema,bytes);
 assert.equal(Object.getPrototypeOf(result.fields),Object.prototype);
 assert.equal(Object.hasOwn(result.fields,"__proto__"),true);
 assert.deepEqual(Object.getOwnPropertyDescriptor(result.fields,"__proto__").value,
  {variant:"Some",value:"not a prototype"});
 assert.equal(Object.isFrozen(result.fields),true);
});
test("global value node budget prevents CPU amplification by zero-byte nested values",async()=>{
 const schema={schemaVersion:1,ownership:"copy",variants:[{id:1,name:"Zero",fields:[
  {name:"values",type:{list:{element:{tuple:[]},maxLength:4096}}}
 ]}]};
 const many=Array.from({length:4095},()=>[]);
 const valid=await encodeMessage(schema,{variant:"Zero",fields:{values:many}});
 assert.equal((await decodeMessage(schema,valid)).fields.values.length,4095);
 await assert.rejects(
  encodeMessage(schema,{variant:"Zero",fields:{values:[...many,[]]}}),
  /value node budget exceeded/);
 const forged=valid.slice();
 // A list count is the first payload u32; raise it from 4095 to 4096.
 forged[44]=0;forged[45]=16;
 await assert.rejects(decodeMessage(schema,forged),/value node budget exceeded/);
});


test("global schema-node budget prevents adversarial type-descriptor amplification",async()=>{
 const variants=Array.from({length:100},(_,i)=>({
  id:i+1,name:"V"+i,fields:Array.from({length:50},(_,j)=>({name:"f"+j,type:"i64"}))
 }));
 const schema={schemaVersion:1,ownership:"copy",variants};
 await assert.rejects(encodeMessage(schema,{variant:"V0",fields:{}}),/schema node budget exceeded/);
 await assert.rejects(decodeMessage(schema,Uint8Array.of(0)),/schema node budget exceeded/);
});
test("canonical schema-byte budget rejects enormous valid-looking metadata",async()=>{
 const variants=Array.from({length:80},(_,i)=>({
  id:i+1,name:"V"+i,
  fields:Array.from({length:30},(_,j)=>({
   name:"f"+j+"_"+("a".repeat(118)),type:"i64"
  }))
 }));
 const schema={schemaVersion:1,ownership:"copy",variants};
 await assert.rejects(encodeMessage(schema,{variant:"V0",fields:{}}),/schema byte budget exceeded/);
 await assert.rejects(decodeMessage(schema,Uint8Array.of(0)),/schema byte budget exceeded/);
});


test("sparse arrays and lists cannot omit schema-declared zero-byte values",async()=>{
 const schema={schemaVersion:1,ownership:"copy",variants:[
  {id:1,name:"List",fields:[{name:"items",type:{list:{
   element:{tuple:[]},maxLength:5
  }}}]},
  {id:2,name:"Fixed",fields:[{name:"items",type:{array:{
   element:{tuple:[]},length:2
  }}}]}
 ]};
 for(const variant of ["List","Fixed"]){
  const holes=new Array(2);
  const partial=[[],[]];delete partial[1];
  for(const value of [holes,partial]){
   await assert.rejects(encodeMessage(schema,{
    variant,fields:{items:value}
   }),/sparse array\/list element/);
  }
  const dense={variant,fields:{items:[[],[]]}};
  const encoded=await encodeMessage(schema,dense);
  assert.deepEqual(await decodeMessage(schema,encoded),dense);
 }
});
test("a sparse list cannot bypass the global zero-byte value visit budget",async()=>{
 const schema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"EmptyTuples",fields:[{name:"items",
   type:{list:{element:{tuple:[]},maxLength:4096}}}]
 }]};
 const sparse=new Array(4096);sparse[0]=[];
 await assert.rejects(encodeMessage(schema,{
  variant:"EmptyTuples",fields:{items:sparse}
 }),/sparse array\/list element/);
});

test("schema contracts never inherit authority, including deeply nested list bounds",async()=>{
 const input={variant:"Compute",fields:{text:"x",n:42n}};
 const missing={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Compute",fields:[{name:"text",type:{list:{element:"string"}}}]
 }]};
 // In particular, an inherited maxLength may appear valid to bound().
 Object.defineProperty(Object.prototype,"maxLength",{configurable:true,value:3});
 let pending;
 try{pending=encodeMessage(missing,input);}
 finally{delete Object.prototype.maxLength;}
 await assert.rejects(pending,/invalid list shape/);

 const schema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Empty",fields:[{name:"x",type:{enum:[{id:1,name:"None",payload:null}]}}]
 }]};
 const ownValue={variant:"Empty",fields:{x:{variant:"None",value:null}}};
 const bytes=await encodeMessage(schema,ownValue);
 assert.equal((await decodeMessage(schema,bytes)).fields.x.value,null);
 Object.defineProperty(Object.prototype,"value",{configurable:true,value:null});
 try{pending=encodeMessage(schema,{variant:"Empty",fields:{x:{variant:"None"}}});}
 finally{delete Object.prototype.value;}
 await assert.rejects(pending,/invalid enum value shape/);
});

test("schema node arrays must have dense own indices, including empty byte layouts",async()=>{
 const msg={variant:"Single",fields:{value:2n}};
 const valid={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Single",fields:[{name:"value",type:"i64"}]
 }]};
 const enc=await encodeMessage(valid,msg);
 const sparseVariants={...valid,variants:new Array(1)};
 const sparseFields={...valid,variants:[{...valid.variants[0],fields:new Array(1)}]};
 const sparseTuple={...valid,variants:[{...valid.variants[0],fields:[
  {name:"value",type:{tuple:new Array(1)}}
 ]}]};
 const sparseEnum={...valid,variants:[{...valid.variants[0],fields:[
  {name:"value",type:{enum:new Array(1)}}
 ]}]};
 for(const [bad,diagnostic] of [
  [sparseVariants,/sparse variants/],
  [sparseFields,/sparse fields/],
  [sparseTuple,/sparse tuple types/],
  [sparseEnum,/sparse enum variants/]
 ]){
  await assert.rejects(encodeMessage(bad,msg),diagnostic);
  await assert.rejects(decodeMessage(bad,enc),diagnostic);
 }
});

test("an accessor cannot redefine schema hash fields during normalization",async()=>{
 let reads=0;
 const list={element:"i64"};
 Object.defineProperty(list,"maxLength",{enumerable:true,configurable:true,
  get(){reads++;return 1;}});
 const schema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Accessor",fields:[{name:"v",type:{list}}]
 }]};
 await assert.rejects(encodeMessage(schema,{variant:"Accessor",fields:{v:[1n]}}),/invalid list shape/);
 assert.equal(reads,0,"accessor must never run in ABI normalization");
});


test("hidden or symbol-bearing schema keys cannot bypass closed ABI shape",async()=>{
 const msg={variant:"Compute",fields:{text:"safe",n:42n}};
 const hidden={...contract};
 Object.defineProperty(hidden,"unsafeGrant",{value:true,enumerable:false});
 const symbolic={...contract};
 Object.defineProperty(symbolic,Symbol("unsafeGrant"),{value:true,enumerable:false});
 const nested={...contract,variants:contract.variants.map(v=>({...v,fields:v.fields.map(f=>({...f}))}))};
 Object.defineProperty(nested.variants[0].fields[0],Symbol("capability"),{value:"net"});
 for(const bad of [hidden,symbolic,nested])
  await assert.rejects(encodeMessage(bad,msg),/invalid (contract|field) shape/);
 const valid=await encodeMessage(contract,msg);
 const fieldMessage={variant:"Compute",fields:{text:"safe",n:42n}};
 Object.defineProperty(fieldMessage.fields,"hidden",{value:"bad",enumerable:false});
 await assert.rejects(encodeMessage(contract,fieldMessage),/invalid message fields shape/);
 assert.deepEqual(await decodeMessage(contract,valid),msg);
});

test("codec never invokes attacker-owned accessors during schema or message admission",async()=>{
 const good={variant:"Compute",fields:{text:"safe",n:42n}};
 let accesses=0;
 const dangerous=()=>{accesses++;throw Error("attacker getter invoked");};
 const variantType={tuple:["string"]};
 Object.defineProperty(variantType,"tuple",{enumerable:true,get:dangerous});
 const badSchema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Bad",fields:[{name:"value",type:variantType}]
 }]};
 await assert.rejects(encodeMessage(badSchema,{variant:"Bad",fields:{value:["safe"]}}),
  /invalid type shape/);
 const variants=[{id:1,name:"Bad",fields:[{name:"n",type:"i64"}]}];
 Object.defineProperty(variants,0,{configurable:true,enumerable:true,get:dangerous});
 await assert.rejects(encodeMessage({...contract,variants},good),/invalid variants element/);
 const message={variant:"Compute",fields:{text:"safe",n:42n}};
 Object.defineProperty(message.fields,"n",{enumerable:true,get:dangerous});
 await assert.rejects(encodeMessage(contract,message),/invalid message fields shape/);
 const msg={fields:good.fields};
 Object.defineProperty(msg,"variant",{enumerable:true,get:dangerous});
 await assert.rejects(encodeMessage(contract,msg),/invalid message shape/);
 const enSchema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Enum",fields:[{name:"tag",type:{enum:[{id:1,name:"Some",payload:"i64"}]}}]
 }]};
 const enValue={variant:"Some"};
 Object.defineProperty(enValue,"value",{enumerable:true,get:dangerous});
 await assert.rejects(encodeMessage(enSchema,{variant:"Enum",fields:{tag:enValue}}),
  /invalid enum value shape/);
 assert.equal(accesses,0,"schema validation must not execute getters");
 assert.deepEqual(await decodeMessage(contract,await encodeMessage(contract,good)),good);
});

test("array element accessors and hidden schema array authority reject even for zero-byte elements",async()=>{
 const schema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Empty",fields:[{name:"parts",type:{list:{element:{tuple:[]},maxLength:3}}}]
 }]};
 let accesses=0;
 const malicious=[[]];
 Object.defineProperty(malicious,0,{configurable:true,enumerable:true,get(){
  accesses++;return [];
 }});
 await assert.rejects(encodeMessage(schema,{variant:"Empty",fields:{parts:malicious}}),
  /invalid array.list element element/);
 const hidden=[[]];
 Object.defineProperty(hidden,"capability",{enumerable:false,value:"network"});
 await assert.rejects(encodeMessage(schema,{variant:"Empty",fields:{parts:hidden}}),
  /invalid array.list element shape/);
 const withSymbol=[[]];
 Object.defineProperty(withSymbol,Symbol("access"),{value:1});
 await assert.rejects(encodeMessage(schema,{variant:"Empty",fields:{parts:withSymbol}}),
  /invalid array.list element shape/);
 const types=["i64"];
 Object.defineProperty(types,0,{configurable:true,enumerable:true,get(){
  accesses++;return "i64";
 }});
 const maliciousSchema={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Bad",fields:[{name:"part",type:{tuple:types}}]
 }]};
 await assert.rejects(encodeMessage(maliciousSchema,{variant:"Bad",fields:{part:[1n]}}),
  /invalid tuple types element/);
 assert.equal(accesses,0);
});

test("built-in owned byte snapshot ignores hostile typed-array getters and iterators",async()=>{
 let traps=0;
 class HostileBytes extends Uint8Array{
  get length(){traps++;return 0;}
  get buffer(){traps++;throw Error("hostile buffer accessor");}
  get byteOffset(){traps++;throw Error("hostile offset accessor");}
  get byteLength(){traps++;throw Error("hostile length accessor");}
  [Symbol.iterator](){traps++;throw Error("hostile iterable");}
 }
 const owned=new HostileBytes([7,8,9]);
 const msg={variant:"Batch",fields:{
  pair:["hi",1n],fixed:[true,false],items:[],
  state:{variant:"None",value:null},blob:owned
 }};
 const encoded=await encodeMessage(contract,msg);
 owned[0]=255;
 const decoded=await decodeMessage(contract,encoded);
 assert.deepEqual([...decoded.fields.blob],[7,8,9]);
 class HostileWire extends Uint8Array{
  get buffer(){traps++;throw Error("hostile wire buffer");}
  get byteOffset(){traps++;throw Error("hostile wire offset");}
  get byteLength(){traps++;throw Error("hostile wire byteLength");}
 }
 const viaSubclass=await decodeMessage(contract,new HostileWire(encoded));
 assert.deepEqual(viaSubclass,decoded);
 class HostileView extends DataView{
  get buffer(){traps++;throw Error("hostile DataView buffer");}
  get byteOffset(){traps++;throw Error("hostile DataView offset");}
  get byteLength(){traps++;throw Error("hostile DataView byteLength");}
 }
 const view=new HostileView(encoded.buffer,encoded.byteOffset,encoded.byteLength);
 assert.deepEqual(await decodeMessage(contract,view),decoded);
 assert.equal(traps,0,"native view snapshot must bypass hostile overrides");
});

test("byte snapshot rejects proxies and oversized views before any payload decode",async()=>{
 const msg={variant:"Compute",fields:{text:"ok",n:42n}};
 const bytes=await encodeMessage(contract,msg);
 let traps=0;
 const proxy=new Proxy(bytes,{getPrototypeOf(){traps++;throw Error("proxy trap");}});
 await assert.rejects(decodeMessage(contract,proxy),/expected message bytes/);
 const badBlob=new Proxy(Uint8Array.of(1,2),{getPrototypeOf(){traps++;throw Error("proxy trap");}});
 const batch={variant:"Batch",fields:{pair:["hi",1n],fixed:[true,false],
  items:[],state:{variant:"None",value:null},blob:badBlob}};
 await assert.rejects(encodeMessage(contract,batch),/invalid byte view/);
 assert.equal(traps,0,"typed array proxy traps must not execute");
 const huge=new Uint8Array(2*1024*1024);
 await assert.rejects(decodeMessage(contract,huge),/invalid message size/);
 await assert.rejects(decodeMessage(contract,new DataView(huge.buffer)),/invalid message size/);
 if(typeof SharedArrayBuffer!=="undefined"){
  class MaskedShared extends Uint8Array{
   get buffer(){traps++;return new ArrayBuffer(8);}
  }
  const shared=new MaskedShared(new SharedArrayBuffer(8));
  await assert.rejects(encodeMessage(contract,{variant:"Batch",fields:{...batch.fields,blob:shared}}),
   /shared memory not admitted/);
  assert.equal(traps,0);
 }
});

test("UTF-8 preflight admits exact byte-budget boundaries and rejects oversized text",async()=>{
 const maxBytes=80; // 44 header + 4 length + up to 24 UTF-8 + 8 i64
 for(const text of ["a".repeat(24),"🦊".repeat(6),"ࠀ".repeat(8)]){
  const message={variant:"Compute",fields:{text,n:42n}};
  const bytes=await encodeMessage(contract,message,{maxBytes});
  assert.equal(bytes.length,80);
  assert.deepEqual(await decodeMessage(contract,bytes,{maxBytes}),message);
 }
 for(const text of ["a".repeat(25),"🦊".repeat(7),"ࠀ".repeat(9),
   "🦊".repeat(300000)]){
  await assert.rejects(encodeMessage(contract,{variant:"Compute",fields:{text,n:42n}},
   {maxBytes}),/byte budget exceeded/);
 }
});


test("normalized schema fingerprint is independent of inherited serialization and Array helpers",async()=>{
 const message={variant:"Compute",fields:{text:"stable",n:42n}};
 const before=await encodeMessage(contract,message);
 const entries=[
  [Object.prototype,"toJSON"],
  [Array.prototype,"toJSON"],
  [Array.prototype,"includes"],
  [Array.prototype,"every"],
  [Array.prototype,"map"],
  [Array.prototype,"sort"],
  [Array.prototype,"find"],
  [Array.prototype,"forEach"],
  [Array.prototype,"push"],
  [Array.prototype,"join"]
 ];
 const originals=[];
 let calls=0,after,decoded;
 const poison=()=>{calls++;throw Error("inherited callback executed during schema admission");};
 try{
  for(let i=0;i<entries.length;i++){
   const [target,key]=entries[i];
   originals[i]=Object.getOwnPropertyDescriptor(target,key);
   Object.defineProperty(target,key,{configurable:true,writable:true,value:poison});
  }
  after=await encodeMessage(contract,message);
  decoded=await decodeMessage(contract,before);
 }finally{
  for(let i=entries.length-1;i>=0;i--){
   if(!(i in originals))continue;
   const [target,key]=entries[i];
   if(originals[i])Object.defineProperty(target,key,originals[i]);
   else delete target[key];
  }
 }
 assert.equal(calls,0,"hostile inherited callbacks must not execute");
 assert.deepEqual(after,before,"schema-bound bytes must not change");
 assert.deepEqual(decoded,message);
});


test("primitive type rejection does not execute poisoned Set.prototype.has",async()=>{
 const original=Object.getOwnPropertyDescriptor(Set.prototype,"has");
 const invalid={schemaVersion:1,ownership:"copy",variants:[{
  id:1,name:"Bad",fields:[{name:"x",type:"not_a_primitive"}]
 }]};
 let called=0,pending;
 try{
  Object.defineProperty(Set.prototype,"has",{configurable:true,writable:true,
   value(){called++;throw Error("Set.has prototype callback executed")}});
  pending=encodeMessage(invalid,{variant:"Bad",fields:{x:1n}});
 }finally{
  if(original)Object.defineProperty(Set.prototype,"has",original);
  else delete Set.prototype.has;
 }
 await assert.rejects(pending,/invalid type shape/);
 assert.equal(called,0);
});

test("owned byte copies and u8 admission ignore poisoned Uint8Array helpers",async()=>{
 const message={variant:"Batch",fields:{
  pair:["hi",5n],fixed:[true,false],items:["first"],
  state:{variant:"None",value:null},blob:new Uint8Array([0,37,255])
 }};
 const baseline=await encodeMessage(contract,message);
 const expected=await decodeMessage(contract,baseline);
 const entries=[[Uint8Array.prototype,"set"],[Uint8Array,"from"],[Uint8Array,"of"]];
 const originals=entries.map(([owner,key])=>Object.getOwnPropertyDescriptor(owner,key));
 let callbacks=0,after,decoded;
 const poison=()=>{callbacks++;throw Error("poisoned typed-array intrinsic executed");};
 try{
  for(let i=0;i<entries.length;i++){
   const [owner,key]=entries[i];
   Object.defineProperty(owner,key,{configurable:true,writable:true,value:poison});
  }
  after=await encodeMessage(contract,message);
  decoded=await decodeMessage(contract,baseline);
 }finally{
  for(let i=entries.length-1;i>=0;i--){
   const [owner,key]=entries[i];
   if(originals[i])Object.defineProperty(owner,key,originals[i]);
   else delete owner[key];
  }
 }
 assert.equal(callbacks,0,"hostile Uint8Array helpers must never run");
 assert.deepEqual(after,baseline,"encoded bytes must be stable under poisoning");
 assert.deepEqual(decoded,expected,"owned decoded byte buffers must be unchanged");
});
