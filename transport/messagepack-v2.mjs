/**
 * Portable host reference for canonical Java/LLVM actor MessagePack v2.
 * NOT a compiler lowering, Wasm guest ABI, actor mailbox, or scheduler.
 * Wire: [2, "<domain>#variant=<id>", bin8(sha256("oreslang.actor.shape.v2/"+shape)), payload].
 * Primitive subset: B bool, I signed i64 BigInt, F finite f64, S strict UTF-8.
 * Composite: T[], FA[], FL[], A[], L[] with recursively typed elements.
 */
const MAX=1048576,NODES=100000,DEPTH=64,ELEMENTS=100000;
const text=new TextEncoder(),decoder=new TextDecoder("utf-8",{fatal:true});
const fail=s=>{throw new TypeError("Oreslang MessagePack v2: "+s)};
const printable=s=>typeof s==="string"&&/^[!-~]+$/.test(s);
function parseShape(input){
 if(typeof input!=="string"||input.length>65536)fail("invalid shape descriptor");
 let at=0,nodes=0;
 function parse(depth){
  if(depth>DEPTH||++nodes>NODES)fail("shape complexity exceeded");
  for(const [symbol,kind] of [["FA[","FA"],["FL[","FL"],["T[","T"],["A[","A"],["L[","L"]]){
   if(!input.startsWith(symbol,at))continue;
   at+=symbol.length;
   const fixed=kind==="FA"||kind==="FL"||kind==="T",children=[];
   if(input[at]!=="]"){
    for(;;){
     children.push(parse(depth+1));
     if(input[at]!==",")break;
     at++;
    }
   }
   if(input[at++]!=="]")fail("invalid bracket in descriptor");
   if(!fixed&&children.length!==1)fail("variable sequence requires one type");
   if(children.length>ELEMENTS)fail("excessive descriptor arity");
   return {kind,children};
  }
  const ch=input[at++];
  if(!["B","I","F","S"].includes(ch))fail("unsupported shape type");
  return {kind:ch};
 }
 const shape=parse(0);
 if(at!==input.length)fail("trailing shape descriptor");
 return shape;
}
function contract(domain,alternatives){
 if(!printable(domain)||domain.includes("#variant=")||domain.length>230)fail("invalid domain");
 if(!Array.isArray(alternatives)||!alternatives.length||alternatives.length>64)fail("expected 1-64 alternatives");
 const byId=new Map(),bySchema=new Map();
 // Caller-owned arrays and variant records may have hostile iterators or
 // dynamic accessors. Snapshot each own DATA slot exactly once.
 for(let i=0;i<alternatives.length;i++){
  const slot=Object.getOwnPropertyDescriptor(alternatives,String(i));
  if(!slot||!Object.hasOwn(slot,"value"))fail("variant list requires own data slots");
  const x=slot.value;
  if(!x||typeof x!=="object"||Array.isArray(x))
    fail("variant entry requires data record");
  const idField=Object.getOwnPropertyDescriptor(x,"id");
  const shapeField=Object.getOwnPropertyDescriptor(x,"shape");
  if(!idField||!shapeField||!Object.hasOwn(idField,"value")||
     !Object.hasOwn(shapeField,"value"))
    fail("variant entry requires own data ID and shape");
  const id=idField.value,descriptor=shapeField.value;
  if(!Number.isSafeInteger(id)||id<1||id>2147483647)fail("invalid variant ID");
  if(byId.has(id))fail("duplicate variant ID");
  const schema=domain+"#variant="+id;
  if(schema.length>256)fail("schema ID length exceeded");
  const shape=parseShape(descriptor);
  const entry=Object.freeze({id,schema,descriptor,shape});
  byId.set(id,entry);bySchema.set(schema,entry);
 }
 return {byId,bySchema};
}
// Only bounded own enumerable data slots may enter a MessagePack payload.
// Cross-realm arrays remain valid. Proxies can still invoke reflection traps;
// external callers must enforce a separate trusted-data boundary.
function ownPayloadSlots(input){
 if(!Array.isArray(input))fail("sequence required");
 const size=Object.getOwnPropertyDescriptor(input,"length")?.value;
 if(!Number.isSafeInteger(size)||size>ELEMENTS)fail("sequence length exceeded");
 if(Reflect.ownKeys(input).length!==size+1)fail("sequence requires own data slots");
 const slots=[];
 for(let i=0;i<size;i++){
  const d=Object.getOwnPropertyDescriptor(input,String(i));
  if(!d||!d.enumerable||!Object.hasOwn(d,"value"))fail("sequence requires own data slots");
  slots.push(d.value);
 }
 return slots;
}

class Writer {
 constructor(){this.bytes=[];this.nodes=0;this.visiting=new Set();}
 u8(x){if(this.bytes.length>=MAX)fail("byte budget exceeded");this.bytes.push(x&255);}
 put(b){if(b.length>MAX-this.bytes.length)fail("byte budget exceeded");for(const x of b)this.bytes.push(x);}
 uint(n,len){for(let i=len-1;i>=0;i--)this.u8(Number((n>>BigInt(8*i))&255n));}
 head(n,base,tag16,tag32){
  if(n>ELEMENTS)fail("sequence length exceeded");
  if(n<16)this.u8(base+n);
  else if(n<=65535){this.u8(tag16);this.uint(BigInt(n),2);}
  else {this.u8(tag32);this.uint(BigInt(n),4);}
 }
 arr(n){this.head(n,0x90,0xdc,0xdd);}
 string(x){
  if(typeof x!=="string")fail("expected string");
  // TextEncoder silently replaces lone surrogates; canonical Java does not.
  if(/[\uD800-\uDFFF]/u.test(x.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/gu,"")))fail("unpaired surrogate");
  const b=text.encode(x),n=b.length;
  if(n>MAX)fail("string too large");
  if(n<=31)this.u8(0xa0+n);
  else if(n<=255){this.u8(0xd9);this.uint(BigInt(n),1);}
  else if(n<=65535){this.u8(0xda);this.uint(BigInt(n),2);}
  else {this.u8(0xdb);this.uint(BigInt(n),4);}
  this.put(b);
 }
 int(n){
  if(typeof n!=="bigint"||n<-(1n<<63n)||n>(1n<<63n)-1n)fail("signed i64 BigInt required");
  if(n>=0n&&n<=127n)return this.u8(Number(n));
  if(n>=-32n&&n<0n)return this.u8(Number(n&255n));
  const specs=n>=0n?[[255n,0xcc,1],[65535n,0xcd,2],[4294967295n,0xce,4],[((1n<<63n)-1n),0xcf,8]]
   :[[-128n,0xd0,1],[-32768n,0xd1,2],[-2147483648n,0xd2,4],[-(1n<<63n),0xd3,8]];
  for(const [threshold,tag,width] of specs){
   if(n>=0n?n<=threshold:n>=threshold){
    this.u8(tag);this.uint(n,width);return;
   }
  }
  fail("i64 unsupported");
 }
 value(shape,x,d=0){
  if(d>DEPTH||++this.nodes>NODES)fail("value complexity exceeded");
  switch(shape.kind){
   case "B":if(typeof x!=="boolean")fail("expected bool");this.u8(x?0xc3:0xc2);return;
   case "I":this.int(x);return;
   case "F":{
    if(typeof x!=="number"||!Number.isFinite(x))fail("finite f64 required");
    this.u8(0xcb);
    const b=new Uint8Array(8);new DataView(b.buffer).setFloat64(0,x,false);this.put(b);return;
   }
   case "S":this.string(x);return;
  }
  // Snapshot the caller-owned array before encoding; never execute getters.
  const values=ownPayloadSlots(x);
  const fixed=["T","FA","FL"].includes(shape.kind);
  if(fixed&&values.length!==shape.children.length)fail("wrong fixed arity");
  if(this.visiting.has(x))fail("cyclic message sequence");
  this.visiting.add(x);
  try{
   this.arr(values.length);
   for(let i=0;i<values.length;i++)this.value(fixed?shape.children[i]:shape.children[0],values[i],d+1);
  }finally{this.visiting.delete(x);}
 }
 finish(){return Uint8Array.from(this.bytes);}
}
class Reader {
 constructor(b){this.b=b;this.at=0;this.nodes=0;}
 u8(){if(this.at>=this.b.length)fail("truncated frame");return this.b[this.at++];}
 uint(n){if(n>this.b.length-this.at)fail("truncated integer");let x=0n;while(n--)x=(x<<8n)|BigInt(this.u8());return x;}
 take(n){if(n>this.b.length-this.at)fail("truncated bytes");const x=this.b.subarray(this.at,this.at+n);this.at+=n;return x;}
 int(){
  const t=this.u8();
  if(t<128)return BigInt(t);
  if(t>=224)return BigInt(t-256);
  const sizes={204:1,205:2,206:4,207:8,208:1,209:2,210:4,211:8};
  const size=sizes[t];if(!size)fail("expected integer");
  let v=this.uint(size);
  if(t>=208){const mask=1n<<BigInt(size*8);if(v&(mask>>1n))v-=mask;}
  if(v<-(1n<<63n)||v>(1n<<63n)-1n)fail("i64 overflow");
  // Reject alternate widths for the same signed i64 value.
  if((t===0xcc&&v<=127n)||(t===0xcd&&v<=255n)||
     (t===0xce&&v<=65535n)||(t===0xcf&&v<=4294967295n)||
     (t===0xd0&&v>=-32n)||(t===0xd1&&v>=-128n)||
     (t===0xd2&&v>=-32768n)||(t===0xd3&&v>=-2147483648n))
    fail("noncanonical integer encoding");
  return v;
 }
 str(){
  const t=this.u8();let n;
  if((t&0xe0)===0xa0)n=t&31;
  else if(t===0xd9)n=Number(this.uint(1));
  else if(t===0xda)n=Number(this.uint(2));
  else if(t===0xdb)n=Number(this.uint(4));
  else fail("expected UTF-8 string");
  if(n>MAX)fail("string size exceeded");
  if((t===0xd9&&n<=31)||(t===0xda&&n<=255)||(t===0xdb&&n<=65535))
    fail("noncanonical string encoding");
  try{return decoder.decode(this.take(n));}catch{fail("invalid UTF-8");}
 }
 arr(){
  const t=this.u8();let n;
  if((t&0xf0)===0x90)n=t&15;
  else if(t===0xdc)n=Number(this.uint(2));
  else if(t===0xdd)n=Number(this.uint(4));
  else fail("expected MessagePack array");
  if((t===0xdc&&n<16)||(t===0xdd&&n<=65535))
    fail("noncanonical array encoding");
  if(n>ELEMENTS||n>this.b.length-this.at||n>NODES-this.nodes)fail("invalid sequence count");
  return n;
 }
 value(shape,d=0){
  if(d>DEPTH||++this.nodes>NODES)fail("value complexity exceeded");
  switch(shape.kind){
   case "B":{const t=this.u8();if(t!==0xc2&&t!==0xc3)fail("expected bool");return t===0xc3;}
   case "I":return this.int();
   case "S":return this.str();
   case "F":{
    if(this.u8()!==0xcb)fail("expected float64");
    const b=this.take(8),v=new DataView(b.buffer,b.byteOffset,8).getFloat64(0,false);
    if(!Number.isFinite(v))fail("nonfinite float");return v;
   }
  }
  const n=this.arr(),fixed=["T","FA","FL"].includes(shape.kind);
  if(fixed&&n!==shape.children.length)fail("wrong fixed arity");
  const out=[];
  for(let i=0;i<n;i++)out.push(this.value(fixed?shape.children[i]:shape.children[0],d+1));
  return Object.freeze(out);
 }
}
async function digest(shape){
 const subtle=globalThis.crypto?.subtle;
 if(!subtle)fail("SHA-256 WebCrypto unavailable");
 return new Uint8Array(await subtle.digest("SHA-256",text.encode("oreslang.actor.shape.v2/"+shape)));
}
// Intrinsic byte slots deny spoofed .buffer/.byteLength accessors and
// cross-realm SharedArrayBuffer backing before allocating any frame copy.
const bufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength").get;
const sharedLength=typeof SharedArrayBuffer==="function" ?
 Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,"byteLength").get:null;
const typedProto=Object.getPrototypeOf(Uint8Array.prototype);
const typedSlot=k=>Object.getOwnPropertyDescriptor(typedProto,k).get;
const dataSlot=k=>Object.getOwnPropertyDescriptor(DataView.prototype,k).get;
const copyBytes=Function.prototype.call.bind(Uint8Array.prototype.set);
function snapshot(input){
 let backing,offset=0,length;
 try{
  length=bufferLength.call(input);
  backing=input;
 }catch{
  if(!ArrayBuffer.isView(input))fail("expected binary message");
  try{
   backing=dataSlot("buffer").call(input);
   offset=dataSlot("byteOffset").call(input);
   length=dataSlot("byteLength").call(input);
  }catch{
   backing=typedSlot("buffer").call(input);
   offset=typedSlot("byteOffset").call(input);
   length=typedSlot("byteLength").call(input);
  }
 }
 let isShared=false;
 if(sharedLength){try{sharedLength.call(backing);isShared=true;}catch{}}
 if(isShared)fail("shared input rejected");
 if(length>MAX)fail("message byte budget exceeded");
 const source=new Uint8Array(backing,offset,length);
 const owned=new Uint8Array(length);
 copyBytes(owned,source);
 return owned;
}
function equal(a,b){return a.length===b.length&&a.every((x,i)=>x===b[i]);}
function makeWire(schema,hash,payload){
 const w=new Writer();w.arr(4);w.int(2n);w.string(schema);w.u8(0xc4);w.u8(32);w.put(hash);w.put(payload);
 return w.finish();
}

/** Canonical MessagePack v2 collection envelope shared with Java/LLVM. */
export async function encodeCollectionV2(schema,descriptor,payload){
 if(!printable(schema)||schema.length>256)fail("invalid collection schema");
 const shape=parseShape(descriptor),w=new Writer();w.value(shape,payload);
 const data=w.finish(),hash=await digest(descriptor);
 return makeWire(schema,hash,data);
}
export async function decodeCollectionV2(schema,descriptor,input){
 if(!printable(schema)||schema.length>256)fail("invalid collection schema");
 const shape=parseShape(descriptor),bytes=snapshot(input);
 if(bytes.length>MAX)fail("message byte budget exceeded");
 const r=new Reader(bytes);
 if(r.arr()!==4||r.int()!==2n)fail("unsupported envelope version/arity");
 if(r.str()!==schema)fail("message schema mismatch");
 if(r.u8()!==0xc4||r.u8()!==32)fail("invalid digest header");
 const received=r.take(32),expected=await digest(descriptor);
 if(!equal(received,expected))fail("shape digest mismatch");
 const value=r.value(shape);
 if(r.at!==bytes.length)fail("trailing message bytes");
 const w=new Writer();w.value(shape,value);
 if(!equal(bytes,makeWire(schema,expected,w.finish())))fail("noncanonical MessagePack encoding");
 return value;
}

export async function encodeActorMessage(domain,alternatives,variantId,payload){
 const {byId}=contract(domain,alternatives);
 const entry=byId.get(variantId);if(!entry)fail("undeclared message variant");
 const w=new Writer();w.value(entry.shape,payload);
 const data=w.finish();const hash=await digest(entry.descriptor);
 return makeWire(entry.schema,hash,data);
}
export async function decodeActorMessage(domain,alternatives,input){
 const {bySchema}=contract(domain,alternatives),bytes=snapshot(input);
 if(bytes.length>MAX)fail("message byte budget exceeded");
 // Parse only a detached snapshot; raw caller memory may change during hashing.
 const r=new Reader(bytes);
 if(r.arr()!==4||r.int()!==2n)fail("unsupported envelope version/arity");
 const entry=bySchema.get(r.str());if(!entry)fail("undeclared actor schema");
 if(r.u8()!==0xc4||r.u8()!==32)fail("invalid SHA-256 digest header");
 const received=r.take(32),expected=await digest(entry.descriptor);
 if(!equal(received,expected))fail("shape digest mismatch");
 const value=r.value(entry.shape);
 if(r.at!==bytes.length)fail("trailing message bytes");
 // A canonical frame has EXACTLY the bytes our encoder emits.
 // This rejects nonminimal MessagePack integer/array/string spellings.
 const canonical=new Writer();canonical.value(entry.shape,value);
 const encoded=makeWire(entry.schema,expected,canonical.finish());
 if(!equal(bytes,encoded))fail("noncanonical MessagePack encoding");
 return Object.freeze({variantId:entry.id,value});
}
export const MESSAGEPACK_ACTOR_V2=Object.freeze({version:2,maxBytes:MAX,maxNodes:NODES,maxDepth:DEPTH,canonical:true});
