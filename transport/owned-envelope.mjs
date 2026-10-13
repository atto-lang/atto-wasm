/**
 * Experimental Oreslang owned message wire v1. Browser-compatible host codec.
 * This is NOT yet connected to compiler lowering, Wasm memory or actor lanes.
 *
 * Header: "ORM1" (4 bytes), version (u8), flags (u8),
 * variant ID (u16 LE), payload byte count (u32 LE), SHA256(contract) (32 bytes).
 * All values are schema-directed. All binary buffers are copied.
 */
const HEADER=44, LIMIT=1048576, DEPTH=12, ITEMS=4096;
const SCHEMA_NODES=4096, SCHEMA_BYTES=65536;
const magic=Uint8Array.of(79,82,77,49);
const enc=new TextEncoder(),dec=new TextDecoder("utf-8",{fatal:true});
// Capture text intrinsics at module admission. Mutable String/TextEncoder and
// TextDecoder prototype methods must not weaken UTF-8 budgets or wire bytes.
const readCodeUnit=String.prototype.charCodeAt;
const nativeEncode=TextEncoder.prototype.encode;
const nativeDecode=TextDecoder.prototype.decode;
const encodeUTF8=s=>nativeEncode.call(enc,s);
const decodeUTF8=b=>nativeDecode.call(dec,b);
// Primitive type admission uses literal comparisons, never mutable Set.prototype.has.
const safeDescriptor=Object.getOwnPropertyDescriptor;
const safeDefine=Object.defineProperty;
const safeFreeze=Object.freeze;
const safePrototype=Object.getPrototypeOf;
const safeHasOwn=Object.hasOwn;
const safeKeys=Object.keys;
const safeOwnKeys=Reflect.ownKeys;
const safeIsArray=Array.isArray;
const safeIsView=ArrayBuffer.isView;
const safeInteger=Number.isInteger;
const safeSafeInteger=Number.isSafeInteger;
const safeSet=Uint8Array.prototype.set;
const safeSubarray=Uint8Array.prototype.subarray;
const primitiveJSON=JSON.stringify;
function safeIncludes(a,value){for(let i=0;i<a.length;i++)if(a[i]===value)return true;return false;}
function safeEvery(a,cb){for(let i=0;i<a.length;i++)if(!cb(a[i],i))return false;return true;}
function safeFind(a,cb){for(let i=0;i<a.length;i++)if(cb(a[i],i))return a[i];}
function safeMap(a,cb){const r=[];for(let i=0;i<a.length;i++)r[i]=cb(a[i],i);return r;}
function safeSort(a,compare){
 for(let i=1;i<a.length;i++){const value=a[i];let j=i;
  while(j>0&&compare(a[j-1],value)>0){a[j]=a[j-1];j--;}
  a[j]=value;
 }return a;
}
// The graph is wholly rebuilt by contract(): own-data primitives, arrays and
// records only. Object/Array.prototype.toJSON must never influence its hash.
function normalizedJSON(value){
 if(value===null||typeof value==="string"||typeof value==="number"||typeof value==="boolean")
  return primitiveJSON(value);
 if(safeIsArray(value)){
  let out="[";
  for(let i=0;i<value.length;i++){if(i)out+=",";out+=normalizedJSON(value[i]);}
  return out+"]";
 }
 if(value&&typeof value==="object"){
  let out="{";
  const keys=safeKeys(value);
  for(let i=0;i<keys.length;i++){
   const k=keys[i],desc=safeDescriptor(value,k);
   if(!desc||!safeHasOwn(desc,"value"))fail("invalid normalized contract");
   if(i)out+=",";
   out+=primitiveJSON(k)+":"+normalizedJSON(desc.value);
  }
  return out+"}";
 }
 fail("invalid normalized contract value");
}

// Read the real backing storage through native brand-checked accessors.
// Subclass overrides of .buffer, .length or Symbol.iterator must not choose
// the bytes that are charged to a budget, hashed, or delivered to a guest.
const typedProto=safePrototype(Uint8Array.prototype);
const typedTag=safeDescriptor(typedProto,Symbol.toStringTag).get;
const typedBuffer=safeDescriptor(typedProto,"buffer").get;
const typedOffset=safeDescriptor(typedProto,"byteOffset").get;
const typedLength=safeDescriptor(typedProto,"byteLength").get;
const viewBuffer=safeDescriptor(DataView.prototype,"buffer").get;
const viewOffset=safeDescriptor(DataView.prototype,"byteOffset").get;
const viewLength=safeDescriptor(DataView.prototype,"byteLength").get;
const arrayBufferLength=safeDescriptor(ArrayBuffer.prototype,"byteLength").get;
function checkedView(b){
 let buffer,offset,length;
 // A Proxy can trap instanceof/getPrototypeOf. First apply the native
 // internal-slot getter, which rejects proxies without consulting traps.
 try{
  buffer=typedBuffer.call(b);offset=typedOffset.call(b);
  length=typedLength.call(b);
 }catch{fail("invalid byte view");}
 // Object.setPrototypeOf cannot falsify the intrinsic typed-array kind.
 if(typedTag.call(b)!=="Uint8Array")fail("expected Uint8Array");
 // ArrayBuffer intrinsic rejects SharedArrayBuffer regardless of its prototype.
 try{arrayBufferLength.call(buffer);}catch{fail("shared memory not admitted");}
 return new Uint8Array(buffer,offset,length);
}
const plain=x=>x!==null&&typeof x==="object"&&safeIncludes([Object.prototype,null],safePrototype(x));
const fail=reason=>{throw new TypeError("Oreslang envelope: "+reason)};
function shape(x,keys,name){
 if(!plain(x))fail("invalid "+name+" shape");
 // Validate descriptors before reading ANY data. A getter could otherwise
 // authorize one schema while the later hash/serializer observes another.
 // Reflect.ownKeys also catches hidden and symbol-bearing properties.
 const own=safeOwnKeys(x);
 for(let i=0;i<own.length;i++){
  const key=own[i];
  if(typeof key!=="string"||!safeIncludes(keys,key))
   fail("invalid "+name+" shape");
  const descriptor=safeDescriptor(x,key);
  if(!descriptor||!descriptor.enumerable||!safeHasOwn(descriptor,"value"))
   fail("invalid "+name+" shape");
 }
}
// Every key hashed into the ABI must be an own enumerable data property.
// Otherwise Object.prototype pollution or accessors can inject authority.
function requiredShape(x,keys,name){
 shape(x,keys,name);
 if(safeKeys(x).length!==keys.length||
    !safeEvery(keys,k=>{
      const desc=safeDescriptor(x,k);
      return !!desc&&desc.enumerable===true&&safeHasOwn(desc,"value");
    }))fail("invalid "+name+" shape");
}
function dense(items,name){
 if(!safeIsArray(items)||!safeIncludes([Array.prototype,null],safePrototype(items)))
  fail("invalid "+name);
 // A numeric getter, custom non-index attribute, or symbol key must never
 // change the normalized hash or bypass a zero-byte element accounting visit.
 // Preserve the specific sparse-index failure before enforcing closed
 // array shape; missing holes and added hidden attributes are independent.
 for(let i=0;i<items.length;i++){
  const descriptor=safeDescriptor(items,String(i));
  if(!descriptor)fail("sparse "+name);
  if(!descriptor.enumerable||!safeHasOwn(descriptor,"value"))
   fail("invalid "+name+" element");
 }
 if(safeOwnKeys(items).length!==items.length+1)
  fail("invalid "+name+" shape");
}
function unique(a,label){for(let i=0;i<a.length;i++)for(let j=0;j<i;j++)if(a[i]===a[j])fail("duplicate "+label);}
function name(x){
 // ASCII-only ABI labels: limit length before scanning, and avoid mutable
 // RegExp.prototype.test or String prototype methods in admission logic.
 if(typeof x!=="string"||x.length<1||x.length>128)fail("invalid name");
 for(let i=0;i<x.length;i++){
  const c=readCodeUnit.call(x,i);
  const letter=(c>=65&&c<=90)||(c>=97&&c<=122);
  const digit=c>=48&&c<=57;
  if(!letter&&c!==95&&(i===0||!digit))fail("invalid name");
 }
 return x;
}
function id(x){if(!safeInteger(x)||x<1||x>65535)fail("invalid ID");return x;}
function bound(x){if(!safeInteger(x)||x<0||x>ITEMS)fail("invalid element bound");return x;}
function type(t,d=0,ctx){
 if(d>DEPTH)fail("type nesting too deep");
 if(++ctx.nodes>SCHEMA_NODES)fail("schema node budget exceeded");
 if(t==="string"||t==="i64"||t==="bool"||t==="bytes")return t;
 shape(t,["tuple","array","list","enum"],"type");
 const ks=safeKeys(t);if(ks.length!==1)fail("exactly one type required");
 const k=ks[0];
 if(k==="tuple"){
  if(!safeIsArray(t.tuple)||t.tuple.length>64)fail("invalid tuple");
  dense(t.tuple,"tuple types");
  return {tuple:safeMap(t.tuple,x=>type(x,d+1,ctx))};
 }
 if(k==="array"||k==="list"){
  requiredShape(t[k],k==="array"?["element","length"]:["element","maxLength"],k);
  return {[k]:k==="array"?{element:type(t[k].element,d+1,ctx),length:bound(t[k].length)}
    :{element:type(t[k].element,d+1,ctx),maxLength:bound(t[k].maxLength)}};
 }
 if(!safeIsArray(t.enum)||t.enum.length<1||t.enum.length>256)fail("invalid enum");
 dense(t.enum,"enum variants");
 const vs=safeMap(t.enum,v=>{
  requiredShape(v,["id","name","payload"],"enum variant");
  if(!safeHasOwn(v,"payload"))fail("enum payload declaration required");
  return {id:id(v.id),name:name(v.name),payload:v.payload===null?null:type(v.payload,d+1,ctx)};
 });
 unique(safeMap(vs,v=>v.id),"enum ID");unique(safeMap(vs,v=>v.name),"enum name");
 return {enum:safeSort(vs,(a,b)=>a.id-b.id)};
}
function contract(c){
 requiredShape(c,["schemaVersion","ownership","variants"],"contract");
 if(c.schemaVersion!==1||c.ownership!=="copy")fail("unsupported contract version/ownership");
 if(!safeIsArray(c.variants)||c.variants.length<1||c.variants.length>256)fail("invalid variants");
 dense(c.variants,"variants");
 const ctx={nodes:0};
 const vs=safeMap(c.variants,v=>{
  requiredShape(v,["id","name","fields"],"variant");
  if(!safeIsArray(v.fields)||v.fields.length>64)fail("invalid fields");
  dense(v.fields,"fields");
  const fields=safeMap(v.fields,f=>{requiredShape(f,["name","type"],"field");return{name:name(f.name),type:type(f.type,0,ctx)}});
  unique(safeMap(fields,f=>f.name),"field");
  return {id:id(v.id),name:name(v.name),fields};
 });
 unique(safeMap(vs,v=>v.id),"variant ID");unique(safeMap(vs,v=>v.name),"variant name");
 const normalized={schemaVersion:1,ownership:"copy",variants:safeSort(vs,(a,b)=>a.id-b.id)};
 // Reject large contracts before WebCrypto hashes attacker-sized JSON.
 if(encodeUTF8(normalizedJSON(normalized)).length>SCHEMA_BYTES)fail("schema byte budget exceeded");
 return normalized;
}
async function digest(c){
 if(!globalThis.crypto?.subtle)fail("WebCrypto SHA-256 required");
 return new Uint8Array(await crypto.subtle.digest("SHA-256",
  encodeUTF8("Oreslang owned-message contract v1\n"+normalizedJSON(c))));
}
function stringBytes(s,remaining){
 if(typeof s!=="string")fail("expected string");
 // Preflight the exact UTF-8 byte length before TextEncoder allocates. A
 // hostile multi-megabyte string must not bypass a small envelope byte budget.
 let bytes=0;
 for(let i=0;i<s.length;i++){
  const n=readCodeUnit.call(s,i);
  if(n>=0xd800&&n<=0xdbff){
   if(++i>=s.length||readCodeUnit.call(s,i)<0xdc00||readCodeUnit.call(s,i)>0xdfff)fail("unpaired surrogate");
   bytes+=4;
  }else if(n>=0xdc00&&n<=0xdfff)fail("unpaired surrogate");
  else bytes+=n<0x80?1:n<0x800?2:3;
  if(bytes>remaining)fail("byte budget exceeded");
 }
 return encodeUTF8(s);
}
class Writer{
 constructor(limit){this.parts=[];this.size=0;this.limit=limit;this.visits=0;}
 visit(){if(++this.visits>ITEMS)fail("value node budget exceeded");}
 put(b){
  const view=checkedView(b);
  if(view.byteLength>this.limit-this.size)fail("byte budget exceeded");
  const copy=new Uint8Array(view.byteLength);
  safeSet.call(copy,view);
  this.parts[this.parts.length]=copy;this.size+=copy.byteLength;
 }
 u8(n){const b=new Uint8Array(1);b[0]=n;this.put(b);}
 u16(n){const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n,true);this.put(b);}
 u32(n){const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n,true);this.put(b);}
 i64(n){if(typeof n!=="bigint"||n<-(1n<<63n)||n>(1n<<63n)-1n)fail("signed i64 BigInt required");
  const b=new Uint8Array(8);new DataView(b.buffer).setBigInt64(0,n,true);this.put(b);}
 finish(){const b=new Uint8Array(this.size);let p=0;for(let i=0;i<this.parts.length;i++){const x=this.parts[i];safeSet.call(b,x,p);p+=x.length;}return b;}
}
class Reader{
 constructor(b){this.b=b;this.at=0;this.dv=new DataView(b.buffer,b.byteOffset,b.byteLength);this.visits=0;}
 visit(){if(++this.visits>ITEMS)fail("value node budget exceeded");}
 take(n){if(!safeSafeInteger(n)||n<0||n>this.b.length-this.at)fail("truncated payload");
  const x=safeSubarray.call(this.b,this.at,this.at+n);this.at+=n;return x;}
 u8(){this.take(1);return this.dv.getUint8(this.at-1);}
 u16(){this.take(2);return this.dv.getUint16(this.at-2,true);}
 u32(){this.take(4);return this.dv.getUint32(this.at-4,true);}
 i64(){this.take(8);return this.dv.getBigInt64(this.at-8,true);}
}
function encode(w,t,x,d=0){
 if(d>DEPTH)fail("value nesting too deep");
 w.visit();
 if(t==="i64")return w.i64(x);
 if(t==="bool"){if(typeof x!=="boolean")fail("expected bool");return w.u8(x?1:0);}
 if(t==="string"||t==="bytes"){
  const b=t==="string"?stringBytes(x,w.limit-w.size-4):x;
  const view=checkedView(b);
  w.u32(view.byteLength);return w.put(view);
 }
 if(safeHasOwn(t,"tuple")){
  if(!safeIsArray(x)||x.length!==t.tuple.length)fail("tuple arity mismatch");
  dense(x,"tuple value");
  for(let i=0;i<t.tuple.length;i++)encode(w,t.tuple[i],x[i],d+1);return;
 }
 if(safeHasOwn(t,"array")||safeHasOwn(t,"list")){
  const fixed=safeHasOwn(t,"array"),spec=fixed?t.array:t.list;
  if(!safeIsArray(x)||(fixed?x.length!==spec.length:x.length>spec.maxLength))fail("array/list length");
  dense(x,"array/list element");
  if(!fixed)w.u32(x.length);
  for(let i=0;i<x.length;i++)encode(w,spec.element,x[i],d+1);
  return;
 }
 requiredShape(x,["variant","value"],"enum value");
 const v=safeFind(t.enum,a=>a.name===x.variant);if(!v)fail("unknown enum alternative");
 w.u16(v.id);
 if(v.payload===null){if(x.value!==null)fail("unit enum must be null");}
 else encode(w,v.payload,x.value,d+1);
}
function decode(r,t,d=0){
 if(d>DEPTH)fail("value nesting too deep");
 r.visit();
 if(t==="i64")return r.i64();
 if(t==="bool"){const x=r.u8();if(x>1)fail("noncanonical bool");return !!x;}
 if(t==="string"||t==="bytes"){const b=r.take(r.u32());
  if(t==="bytes"){const owned=new Uint8Array(b.byteLength);safeSet.call(owned,b);return owned;}
  try{return decodeUTF8(b);}catch{fail("invalid UTF-8");}}
 if(safeHasOwn(t,"tuple"))return safeFreeze(safeMap(t.tuple,a=>decode(r,a,d+1)));
 if(safeHasOwn(t,"array")||safeHasOwn(t,"list")){
  const fixed=safeHasOwn(t,"array"),spec=fixed?t.array:t.list,n=fixed?spec.length:r.u32();
  if(n>ITEMS||(!fixed&&n>spec.maxLength))fail("array/list length");
  const a=[];for(let i=0;i<n;i++)a[i]=decode(r,spec.element,d+1);return safeFreeze(a);
 }
 const variantId=r.u16();const v=safeFind(t.enum,a=>a.id===variantId);if(!v)fail("unknown enum ID");
 return safeFreeze({variant:v.name,value:v.payload===null?null:decode(r,v.payload,d+1)});
}
function snapshot(input,maxBytes){
 let buffer,offset=0,length;
 if(safeIsView(input)){
  try{
   if(input instanceof DataView){
    buffer=viewBuffer.call(input);offset=viewOffset.call(input);
    length=viewLength.call(input);
   }else{
    buffer=typedBuffer.call(input);offset=typedOffset.call(input);
    length=typedLength.call(input);
   }
  }catch{fail("invalid message view");}
 }else{
  // Likewise, native buffer-brand admission rejects spoofed ArrayBuffers.
  try{length=arrayBufferLength.call(input);buffer=input;}
  catch{fail("expected message bytes");}
 }
 try{arrayBufferLength.call(buffer);}catch{fail("shared memory not admitted");}
 // Reject before creating an owned copy, otherwise a huge untrusted view
 // can force an unbounded allocation ahead of the 1 MiB message budget.
 if(length<HEADER||length>maxBytes)fail("invalid message size");
 const src=new Uint8Array(buffer,offset,length);
 const result=new Uint8Array(src.byteLength);
 safeSet.call(result,src);
 return result;
}
function budget(n){if(!safeSafeInteger(n)||n<HEADER||n>LIMIT)fail("invalid maxBytes");}
export async function encodeMessage(schema,message,{maxBytes=LIMIT}={}){
 budget(maxBytes);
 const c=contract(schema);
 requiredShape(message,["variant","fields"],"message");
 const v=safeFind(c.variants,x=>x.name===message.variant);if(!v)fail("unknown message variant");
 requiredShape(message.fields,safeMap(v.fields,x=>x.name),"message fields");
 const w=new Writer(maxBytes-HEADER);for(let i=0;i<v.fields.length;i++){const f=v.fields[i];encode(w,f.type,message.fields[f.name]);}
 // Payload bytes and normalized schema are snapshotted before any await.
 const payload=w.finish(),hash=await digest(c);
 const result=new Uint8Array(HEADER+payload.length),dv=new DataView(result.buffer);
 safeSet.call(result,magic);dv.setUint8(4,1);dv.setUint8(5,0);dv.setUint16(6,v.id,true);
 dv.setUint32(8,payload.length,true);safeSet.call(result,hash,12);safeSet.call(result,payload,HEADER);return result;
}
export async function decodeMessage(schema,input,{maxBytes=LIMIT}={}){
 budget(maxBytes);const c=contract(schema),bytes=snapshot(input,maxBytes);
 const r=new Reader(bytes);for(let i=0;i<magic.length;i++)if(r.u8()!==magic[i])fail("bad magic");
 if(r.u8()!==1||r.u8()!==0)fail("unknown version/flags");
 const variantId=r.u16(),n=r.u32(),received=r.take(32);
 if(n!==bytes.length-HEADER)fail("payload length mismatch");
 const hash=await digest(c);
 if(!safeEvery(hash,(x,i)=>x===received[i]))fail("contract SHA-256 mismatch");
 const v=safeFind(c.variants,x=>x.id===variantId);if(!v)fail("unknown message variant");
 const fields={};for(let i=0;i<v.fields.length;i++){
  const f=v.fields[i];
  const value=decode(r,f.type);
  // Define an OWN property, including for "__proto__", without calling
  // Object.prototype setters or replacing the resulting object prototype.
  safeDefine(fields,f.name,{value,enumerable:true,writable:false,configurable:false});
 }
 if(r.at!==bytes.length)fail("unexpected trailing payload");
 return safeFreeze({variant:v.name,fields:safeFreeze(fields)});
}
export const OWNED_ENVELOPE_V1=safeFreeze({version:1,headerBytes:HEADER,maxBytes:LIMIT,ownership:"copy"});
