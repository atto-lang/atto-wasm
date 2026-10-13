/** Deterministic, descriptor-only JSON bytes for trusted release metadata.
 *
 * This encoder is deliberately NOT a generic untrusted-object admission API:
 * the publisher must validate the exact record schema before calling it.
 *
 * Wire-format compatibility: preserves object insertion order and appends LF;
 * changing key ordering would change already published content hashes.
 */
import {Buffer} from "node:buffer";
import {isProxy} from "node:util/types";

export const MAX_CANONICAL_RELEASE_BYTES=16384;
const MAX_DEPTH=16;
// Capture intrinsics once: post-import mutations of these globals or prototype
// methods must not change release metadata bytes or turn data into callbacks.
const getPrototypeOf=Object.getPrototypeOf;
const getOwnPropertyDescriptor=Object.getOwnPropertyDescriptor;
const ownKeys=Reflect.ownKeys;
const objectKeys=Object.keys;
const hasOwn=Object.hasOwn;
const arrayIsArray=Array.isArray;
const isFiniteNumber=Number.isFinite;
const isSafeInteger=Number.isSafeInteger;
const numberToString=String;
const stringJSON=JSON.stringify;
const byteLength=Buffer.byteLength;
const alloc=Buffer.alloc;
const from=Buffer.from;
const write=Buffer.prototype.write;
const subarray=Uint8Array.prototype.subarray;
const apply=Reflect.apply;
const fail=reason=>{throw Error("invalid atomic Oreslang release: "+reason)};

export function canonicalReleaseMetadata(value){
 // A fixed-size output buffer prevents unbounded intermediate string growth
 // and quadratic concatenation on deeply nested or very wide inputs.
 const bytes=alloc(MAX_CANONICAL_RELEASE_BYTES);
 let used=0;
 function emit(text){
  if(text.length>MAX_CANONICAL_RELEASE_BYTES)
   fail("canonical metadata byte budget");
  const size=byteLength(text,"utf8");
  // Reserve the final byte for the required LF.
  if(size>MAX_CANONICAL_RELEASE_BYTES-1-used)
   fail("canonical metadata byte budget");
  const written=apply(write,bytes,[text,used,size,"utf8"]);
  if(written!==size)fail("canonical metadata write failure");
  used+=size;
 }
 function serialize(node,depth){
  if(depth>MAX_DEPTH)fail("canonical metadata nesting limit");
  if(node===null||typeof node==="string"||typeof node==="boolean"||
      (typeof node==="number"&&isFiniteNumber(node))){
   if(typeof node==="string"&&node.length>MAX_CANONICAL_RELEASE_BYTES)
    fail("canonical metadata byte budget");
   emit(stringJSON(node));
   return;
  }
  if(!node||typeof node!=="object"||isProxy(node))
   fail("invalid canonical metadata value");
  if(arrayIsArray(node)){
   if(getPrototypeOf(node)!==Array.prototype)
    fail("invalid canonical metadata array prototype");
   const length=getOwnPropertyDescriptor(node,"length")?.value;
   if(!isSafeInteger(length)||length<0)
    fail("invalid canonical metadata array properties");
   // A dense array needs at least n one-byte values and n-1 commas.
   if(length>(MAX_CANONICAL_RELEASE_BYTES-2)/2)
    fail("canonical metadata byte budget");
   const keys=ownKeys(node);
   if(keys.length!==length+1||keys[keys.length-1]!=="length")
    fail("invalid canonical metadata array properties");
   emit("[");
   for(let i=0;i<length;i++){
    const key=numberToString(i);
    if(keys[i]!==key)fail("invalid canonical metadata array index");
    const descriptor=getOwnPropertyDescriptor(node,key);
    if(!descriptor||!hasOwn(descriptor,"value")||!descriptor.enumerable)
     fail("invalid canonical metadata array element");
    if(i!==0)emit(",");
    serialize(descriptor.value,depth+1);
   }
   emit("]");
   return;
  }
  const proto=getPrototypeOf(node);
  if(proto!==Object.prototype&&proto!==null)
   fail("invalid canonical metadata prototype");
  const keys=objectKeys(node);
  if(ownKeys(node).length!==keys.length)
   fail("invalid canonical metadata hidden fields");
  // Each object property consumes at least two quotes, a colon, a character
  // of key and one character of value, plus separators.
  if(keys.length>MAX_CANONICAL_RELEASE_BYTES/5)
   fail("canonical metadata byte budget");
  emit("{");
  for(let i=0;i<keys.length;i++){
   const key=keys[i];
   const descriptor=getOwnPropertyDescriptor(node,key);
   if(!descriptor||!descriptor.enumerable||!hasOwn(descriptor,"value"))
    fail("invalid canonical metadata field");
   if(i!==0)emit(",");
   if(key.length>MAX_CANONICAL_RELEASE_BYTES)
    fail("canonical metadata byte budget");
   emit(stringJSON(key));
   emit(":");
   serialize(descriptor.value,depth+1);
  }
  emit("}");
 }
 serialize(value,0);
 // Reserve was held at every earlier emission, so this cannot overflow.
 bytes[used]=10;
 return from(apply(subarray,bytes,[0,used+1]));
}
