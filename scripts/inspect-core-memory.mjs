/**
 * Small, bounded reader for the pieces of core Wasm required to enforce
 * loader policy. This is *not* a general Wasm parser or execution sandbox.
 */
import {isSharedArrayBuffer,isProxy} from "node:util/types";
// Inspect owned native byte views, never caller-overridable properties,
// iterators, static Uint8Array.from, or prototype-dependent instanceof checks.
const intrinsicApply=Reflect.apply;
const intrinsicUint8Array=Uint8Array;
const intrinsicIsView=ArrayBuffer.isView;
const intrinsicIsSafeInteger=Number.isSafeInteger;
const intrinsicValidate=WebAssembly.validate;
const intrinsicTypedProto=Object.getPrototypeOf(Uint8Array.prototype);
const getTypedBuffer=Object.getOwnPropertyDescriptor(intrinsicTypedProto,"buffer").get;
const getTypedOffset=Object.getOwnPropertyDescriptor(intrinsicTypedProto,"byteOffset").get;
const getTypedLength=Object.getOwnPropertyDescriptor(intrinsicTypedProto,"byteLength").get;
const getRawBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,"byteLength").get;
const getDataViewBuffer=Object.getOwnPropertyDescriptor(DataView.prototype,"buffer").get;
const getDataViewOffset=Object.getOwnPropertyDescriptor(DataView.prototype,"byteOffset").get;
const getDataViewLength=Object.getOwnPropertyDescriptor(DataView.prototype,"byteLength").get;
const intrinsicSet=Uint8Array.prototype.set;
export function inspectWasmBytes(input,{maxModuleBytes=1048576,maxMemoryPages=32}={}){
 if(!intrinsicIsSafeInteger(maxModuleBytes)||maxModuleBytes<8||maxModuleBytes>16*1024*1024)throw new TypeError("invalid maximum module size");
 if(!intrinsicIsSafeInteger(maxMemoryPages)||maxMemoryPages<1||maxMemoryPages>256)throw new TypeError("invalid maximum memory pages");
 // Reject before instanceof or any host-property access: a proxy may
 // execute Symbol.hasInstance/GetPrototypeOf hooks before brand checks.
 if(isProxy(input)||isSharedArrayBuffer(input))
  throw new TypeError("shared or proxy-backed Wasm input cannot be snapshotted safely");
 if(input instanceof WebAssembly.Module)throw new TypeError("precompiled WebAssembly.Module cannot be inspected: provide original bytes");
 let backing,offset=0,size;
 try{
  // Native byteLength getter rejects a forged ArrayBuffer prototype.
  size=intrinsicApply(getRawBufferLength,input,[]);
  backing=input;
 }catch{
  if(!intrinsicIsView(input))
   throw new TypeError("expected a Wasm ArrayBuffer or typed array");
  try{
   backing=intrinsicApply(getTypedBuffer,input,[]);
   offset=intrinsicApply(getTypedOffset,input,[]);
   size=intrinsicApply(getTypedLength,input,[]);
  }catch{
   try{
    backing=intrinsicApply(getDataViewBuffer,input,[]);
    offset=intrinsicApply(getDataViewOffset,input,[]);
    size=intrinsicApply(getDataViewLength,input,[]);
   }catch{throw new TypeError("expected a Wasm ArrayBuffer or typed array")}
  }
 }
 // SharedArrayBuffer contents can be changed by another worker during
 // the copy, making one byte snapshot inconsistent even with native getters.
 // ArrayBuffer.isView() and public .buffer accessors do not provide this proof.
 if(isProxy(input)||isSharedArrayBuffer(backing))
  throw new TypeError("shared or proxy-backed Wasm input cannot be snapshotted safely");
 if(size>maxModuleBytes)throw new Error("Wasm module exceeds maximum byte size");
 // Copy exactly the native backing-view bytes, without consulting mutable
 // Symbol.iterator, Buffer/typed-array getters, or Uint8Array.from.
 // This is the single snapshot used for the rest of policy inspection.
 const bytes=new intrinsicUint8Array(size);
 intrinsicApply(intrinsicSet,bytes,[new intrinsicUint8Array(backing,offset,size)]);
 const fail=message=>{throw new Error("Wasm admission denied: "+message)};
 if(bytes.length<8||bytes[0]!==0||bytes[1]!==97||bytes[2]!==115||bytes[3]!==109||
    bytes[4]!==1||bytes[5]!==0||bytes[6]!==0||bytes[7]!==0)fail("invalid core module header");
 let at=8;
 const u32=end=>{
  let value=0;
  for(let i=0;i<5;i++){
   if(at>=end)fail("truncated unsigned integer");
   const b=bytes[at++];
   if(i===4&&(b&0xf0)!==0)fail("invalid u32 encoding");
   value+=(b&0x7f)*2**(7*i);
   if((b&0x80)===0)return value;
  }
  fail("overlong unsigned integer");
 };
 let memoryCount=0,hasMemoryMaximum=false,memoryInitial=0,memoryMaximum=0;
 while(at<bytes.length){
  const id=bytes[at++];
  const length=u32(bytes.length);
  const end=at+length;
  if(end>bytes.length)fail("section extends beyond module");
  if(id===8)fail("start section is forbidden (runs before host admission completes)");
  if(id===4)fail("table section is not yet admitted");
  if(id===5){
   const count=u32(end);
   memoryCount+=count;
   if(count>1)fail("more than one memory");
   if(count===1){
    const flags=u32(end);
    if(flags!==1)fail("memory requires fixed initial and maximum limits; shared/memory64 forbidden");
    memoryInitial=u32(end);memoryMaximum=u32(end);
    hasMemoryMaximum=true;
    if(memoryInitial>memoryMaximum||memoryMaximum>maxMemoryPages)fail("linear memory exceeds host budget");
   }
   if(at!==end)fail("malformed memory section");
  }
  at=end;
 }
 if(!intrinsicValidate(bytes))fail("invalid WebAssembly module");
 return {bytes,memoryCount,hasMemoryMaximum,memoryInitial,memoryMaximum};
}
