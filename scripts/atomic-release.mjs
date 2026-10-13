/** Atomic content-addressed releases; requires a trusted private filesystem.
 * An adversary who can replace files inside the release root is outside this
 * trust boundary. Immutable means nonoverwriting via this API, not WORM media.
 */
import {createHash} from "node:crypto";
import {isProxy,isUint8Array,isSharedArrayBuffer} from "node:util/types";
import {constants as fsConstants} from "node:fs";
import {rename,rm,mkdir,mkdtemp,lstat,chmod,open,readdir} from "node:fs/promises";
import {join,dirname,resolve} from "node:path";
import {assertCoreI64Entry} from "./core-i64-abi.mjs";
import {inspectWasmBytes} from "./inspect-core-memory.mjs";
import {canonicalReleaseMetadata} from "./canonical-release-json.mjs";
export {canonicalReleaseMetadata} from "./canonical-release-json.mjs";
const digest=b=>createHash("sha256").update(b).digest("hex");
// Capture native RegExp.exec: captured .test() alone would still dispatch
// through a mutable prototype .exec and could bypass admission checks.
const intrinsicApply=Reflect.apply;
// Never consult mutable fs.Stats prototype predicates or mutable O_NOFOLLOW
// flags while authenticating a release directory or opened file.
const FILE_MODE_MASK=fsConstants.S_IFMT;
const FILE_MODE_REGULAR=fsConstants.S_IFREG;
const FILE_MODE_DIRECTORY=fsConstants.S_IFDIR;
const SEALED_READ_FLAGS=fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|fsConstants.O_NONBLOCK;
const isNativeFile=stat=>(stat.mode&FILE_MODE_MASK)===FILE_MODE_REGULAR;
const isNativeDirectory=stat=>(stat.mode&FILE_MODE_MASK)===FILE_MODE_DIRECTORY;
// A rename-able pointer in a group/world-writable directory is not protected
// by a sealed content-addressed payload. Require private owner-controlled
// parents and release roots, including directories that existed before mkdir.
const isPrivateDirectory=stat=>isNativeDirectory(stat)&&(stat.mode&0o022)===0;
async function requirePrivatePointerParent(pointer){
 const stat=await lstat(dirname(pointer));
 if(!isPrivateDirectory(stat))fail("unsafe atomic pointer parent directory");
}
// Sealed-file verification must operate on the actual bytes read from disk.
// Capture Buffer operations before any post-import prototype or static-method
// mutation; never allow a replaced .subarray/.concat/.equals to forge bytes.
const intrinsicBufferFrom=Buffer.from;
const intrinsicBufferAllocUnsafe=Buffer.allocUnsafe;
const intrinsicBufferSubarray=Buffer.prototype.subarray;
const intrinsicBufferEquals=Buffer.prototype.equals;
const intrinsicTextDecoder=TextDecoder;
const intrinsicDecode=TextDecoder.prototype.decode;
const intrinsicJSONParse=JSON.parse;
const intrinsicWasmNamespace=WebAssembly;
const intrinsicWasmValidate=WebAssembly.validate;
const intrinsicWasmModule=WebAssembly.Module;
const intrinsicWasmImports=WebAssembly.Module.imports;
const parseUTF8JSON=bytes=>intrinsicJSONParse(intrinsicApply(intrinsicDecode,
 new intrinsicTextDecoder("utf-8",{fatal:true}),[bytes]));
const intrinsicUint8Array=Uint8Array;
const intrinsicTypedArraySet=Uint8Array.prototype.set;
const intrinsicRegExpExec=RegExp.prototype.exec;
const regexMatches=(pattern,value)=>
 intrinsicApply(intrinsicRegExpExec,pattern,[value])!==null;
const hex=x=>typeof x==="string"&&regexMatches(/^[0-9a-f]{64}$/,x);
// JSON Schema maxLength counts Unicode code points, not UTF-16 units.
// Stop scanning at max+1; never allocate a second copy of caller text.
const intrinsicCharCodeAt=String.prototype.charCodeAt;
function boundedCodePoints(value,min,max){
 if(typeof value!=="string")return false;
 let n=0;
 for(let i=0;i<value.length;i++){
  const ch=intrinsicApply(intrinsicCharCodeAt,value,[i]);
  if(ch>=0xd800&&ch<=0xdbff&&i+1<value.length){
   const low=intrinsicApply(intrinsicCharCodeAt,value,[i+1]);
   if(low>=0xdc00&&low<=0xdfff)i++;
  }
  if(++n>max)return false;
 }
 return n>=min;
}
const fail=x=>{throw Error("invalid atomic Oreslang release: "+x)};
// Capture descriptor and primitive admission intrinsics before any post-import
// prototype pollution. A poisoned Object.hasOwn could otherwise make an
// accessor descriptor look like a data descriptor and run a caller getter.
const nativeHasOwn=Object.hasOwn;
const nativeOwnKeys=Reflect.ownKeys;
const nativeGetOwnPropertyDescriptor=Object.getOwnPropertyDescriptor;
const nativeGetPrototypeOf=Object.getPrototypeOf;
const nativeObjectKeys=Object.keys;
const nativeIsArray=Array.isArray;
const nativeIsSafeInteger=Number.isSafeInteger;
const arrayViewProto=nativeGetPrototypeOf(Uint8Array.prototype);
const nativeBuffer=nativeGetOwnPropertyDescriptor(arrayViewProto,"buffer").get;
const nativeOffset=nativeGetOwnPropertyDescriptor(arrayViewProto,"byteOffset").get;
const nativeLength=nativeGetOwnPropertyDescriptor(arrayViewProto,"byteLength").get;
// Never ask an untrusted typed-array subclass for .length, .buffer or
// Symbol.iterator. Buffer.from(view) consults subclass .length and can copy a
// different number of bytes than the native Uint8Array backing view.
function ownedWasmSnapshot(wasm){
 if(isProxy(wasm))fail("invalid Wasm bytes");
 let backing,offset,length;
 try{
  backing=intrinsicApply(nativeBuffer,wasm,[]);
  offset=intrinsicApply(nativeOffset,wasm,[]);
  length=intrinsicApply(nativeLength,wasm,[]);
 }catch{fail("invalid Wasm bytes")}
 // Native brand checks cannot be evaded by swapping a view/backing prototype.
 // `instanceof` is insufficient: a Uint16Array can masquerade as Uint8Array,
 // and SharedArrayBuffer can masquerade as ArrayBuffer.
 if(!isUint8Array(wasm)||isSharedArrayBuffer(backing))
  fail("invalid Wasm bytes");
 if(length<8||length>16777216)fail("Wasm budget");
 // Buffer.from(view) consults view.length, which can be replaced by an
 // inherited getter even when Buffer.from itself is captured. Copy using
 // native typed-array internal slots, without reading any view property.
 const snapshot=intrinsicApply(intrinsicBufferAllocUnsafe,Buffer,[length]);
 intrinsicApply(intrinsicTypedArraySet,snapshot,
  [new intrinsicUint8Array(backing,offset,length)]);
 return snapshot;
}

// A pointer rename is the visibility/linearization point. If the subsequent
// directory sync fails, the pointer might already be visible or durable.
// Never translate that condition into an ordinary "nothing published" error.
export class AtomicReleaseCommitUncertainError extends Error {
 constructor({pointer,releaseSha256,cause}) {
  super("atomic release pointer was renamed but durable commit is unconfirmed; inspect the verified current pointer before retrying",{cause});
  this.name="AtomicReleaseCommitUncertainError";
  this.code="ATOMIC_RELEASE_COMMIT_UNCERTAIN";
  this.pointer=pointer;
  this.releaseSha256=releaseSha256;
  this.mayBePublished=true;
 }
}
const paths=output=>({root:output+".releases",pointer:output+".current.json"});
function cleanupMessage(error){
 try{return String(error?.message||error).slice(0,256)}
 catch{return "cleanup failure (details unavailable)"}
}
const canonical=canonicalReleaseMetadata;
// Array.length alone does not make an empty metadata array a closed record:
// an own toJSON, symbol, non-enumerable capability or accessor would otherwise
// be silently admitted and might be invoked by future code paths.
const exactEmptyArray=value=>nativeIsArray(value)&&!isProxy(value)&&
 nativeGetPrototypeOf(value)===Array.prototype&&value.length===0&&
 nativeOwnKeys(value).length===1&&nativeOwnKeys(value)[0]==="length";

// Keep runtime admission aligned with atomic-release-v1.schema.json, which
// specifies closed records. Digest equality is not a schema/authority check.
// Closed JSON record admission must reject inherited, hidden, symbol and
// accessor properties, not merely count enumerable names. In particular,
// getters could otherwise return different values during validation and seal
// serialization, producing inconsistent source-of-authority records.
// Explicit loops avoid prototype-pollutable Array algorithms in admission.
function exactKeys(value,keys){
 if(value===null||typeof value!=="object"||isProxy(value)||nativeIsArray(value))
  return false;
 const prototype=nativeGetPrototypeOf(value);
 if(prototype!==Object.prototype&&prototype!==null)return false;
 if(nativeOwnKeys(value).length!==keys.length)return false;
 for(let i=0;i<keys.length;i++){
  const descriptor=nativeGetOwnPropertyDescriptor(value,keys[i]);
  if(!descriptor||descriptor.enumerable!==true||
     !nativeHasOwn(descriptor,"value"))return false;
 }
 return true;
}
function orderedKeys(value,keys){
 const actual=nativeObjectKeys(value);
 if(actual.length!==keys.length)return false;
 for(let i=0;i<keys.length;i++)if(actual[i]!==keys[i])return false;
 return true;
}
// Explicit Linux/POSIX durability barrier. On filesystems without directory
// fsync support this fails closed rather than claiming persistence.
async function fsyncDirectory(dir){
 const handle=await open(dir,"r");
 try{await handle.sync()}finally{await handle.close()}
}
async function durableWrite(path,bytes){
 const handle=await open(path,"wx",0o400);
 try{await handle.writeFile(bytes);await handle.sync()}
 finally{await handle.close()}
}

// Bind validation, sizing and reading to ONE open file descriptor. O_NOFOLLOW
// prevents a substituted symlink; exact fstat-sized reads reject concurrent
// shortening or growth and never trust inherited fs.Stats type predicates.
async function safeFile(path,limit){
 // O_NOFOLLOW denies symlinks. O_NONBLOCK additionally prevents a substituted
 // FIFO/device pathname from parking the verifier before fstat can reject it.
 const handle=await open(path,SEALED_READ_FLAGS);
 try{
  const stat=await handle.stat();
  // Hard links outside this directory alias the same inode but are not
  // covered by the sealed namespace. Reject before interpreting any bytes.
  if(!isNativeFile(stat)||stat.size>limit||stat.nlink!==1)
   fail("invalid file");
  // Read exactly the fstat-observed byte count into a single bounded
  // allocation. Buffer.concat indirectly calls mutable Buffer.allocUnsafe,
  // even if the concat function was captured before prototype pollution.
  // Detect a concurrently shrunk or extended file instead of hashing a
  // partial snapshot that differs from the checked inode size.
  const bytes=intrinsicApply(intrinsicBufferAllocUnsafe,Buffer,[stat.size]);
  let offset=0;
  while(offset<stat.size){
   const {bytesRead}=await handle.read(bytes,offset,stat.size-offset,null);
   if(bytesRead===0)fail("file size changed during verification");
   offset+=bytesRead;
  }
  const extra=intrinsicApply(intrinsicBufferAllocUnsafe,Buffer,[1]);
  const trailing=await handle.read(extra,0,1,null);
  if(trailing.bytesRead!==0)fail("file size changed during verification");
  return intrinsicApply(intrinsicBufferSubarray,bytes,[0,offset]);
 }finally{await handle.close()}
}
// Verify the exact bytes before interpreting the seal. Unlike JSON.parse,
// byte-canonical validation rejects duplicate keys, alternate whitespace,
// field reordering and invalid UTF-8 that other runtimes may parse differently.
function parseCanonicalSeal(bytes){
 let seal;
 try{seal=parseUTF8JSON(bytes)}
 catch{fail("invalid release seal JSON")}
 if(!seal||typeof seal!=="object"||nativeIsArray(seal)||
    !intrinsicApply(intrinsicBufferEquals,bytes,[canonical(seal)])||
    !orderedKeys(seal,["schemaVersion","type","fileHashes"])||
    !seal.fileHashes||typeof seal.fileHashes!=="object"||
    nativeIsArray(seal.fileHashes)||
    !orderedKeys(seal.fileHashes,["wasm","manifest","provenance"]))
   fail("noncanonical release seal");
 return seal;
}
function descriptorFor(wasm,manifest,provenance){
 if(wasm.length<8||wasm.length>16777216)fail("Wasm budget");
 if(!intrinsicApply(intrinsicWasmValidate,intrinsicWasmNamespace,[wasm]))
  fail("invalid executable Wasm");
 if(!exactKeys(provenance,["schemaVersion","kind","compilerSha256",
      "sourceSha256","llvmIrSha256","wasmSha256","exportName","wasmBytes",
      "importCount","clangVersion","note"])||
    provenance.kind!=="llvm-ores-to-wasm32-core-experimental"||
    provenance.schemaVersion!==1||
    !hex(provenance.compilerSha256)||!hex(provenance.sourceSha256)||
    !hex(provenance.llvmIrSha256)||!hex(provenance.wasmSha256)||
    !nativeIsSafeInteger(provenance.wasmBytes)||provenance.wasmBytes!==wasm.length||
    typeof provenance.exportName!=="string"||
    !regexMatches(/^[A-Za-z_][A-Za-z0-9_]*$/,provenance.exportName)||
    provenance.importCount!==0||
    !boundedCodePoints(provenance.clangVersion,1,256)||
    !boundedCodePoints(provenance.note,0,1024))
   fail("invalid producer record");
 if(provenance.wasmSha256!==digest(wasm))fail("invalid provenance digest");
 if(intrinsicApply(intrinsicWasmImports,intrinsicWasmModule,
  [new intrinsicWasmModule(wasm)]).length!==0)
   fail("guest Wasm host imports forbidden");
 try{assertCoreI64Entry(wasm,provenance.exportName)}
 catch{fail("invalid core i64 entry ABI")}
 const memory=inspectWasmBytes(wasm,{maxModuleBytes:16777216,maxMemoryPages:2});
 if(memory.memoryCount!==1||!memory.hasMemoryMaximum||memory.memoryMaximum!==2)
   fail("invalid bounded 2-page guest memory");

 if(manifest!==null&&(!exactKeys(manifest,["schemaVersion","artifactType",
      "target","environment","backend","entry","wasmSha256","wasmBytes",
      "imports","requiredCapabilities","memory","producer"])||
   manifest.schemaVersion!==1||
   manifest.artifactType!=="oreslang.core-wasm.i64-v1"||
   manifest.target!=="wasm32"||manifest.backend!=="wasm"||
   (manifest.environment!=="browser"&&manifest.environment!=="edge-js"&&
     manifest.environment!=="edge-wasi")||
   typeof manifest.entry!=="string"||manifest.entry.length>128||
   !regexMatches(/^[A-Za-z_][A-Za-z0-9_]*$/,manifest.entry)||
   manifest.entry!==provenance.exportName||
   manifest.wasmBytes!==wasm.length||
   !exactKeys(manifest.memory,["maximumPages"])||
   manifest.memory.maximumPages!==2||
   !exactEmptyArray(manifest.imports)||
   !exactEmptyArray(manifest.requiredCapabilities)||
   manifest.wasmSha256!==digest(wasm)||
   !exactKeys(manifest.producer,["compilerSha256","sourceSha256",
      "llvmIrSha256"])||
   manifest.producer.sourceSha256!==provenance.sourceSha256||
   manifest.producer.compilerSha256!==provenance.compilerSha256||
   manifest.producer.llvmIrSha256!==provenance.llvmIrSha256))
  fail("inconsistent manifest provenance");
 const fileHashes={wasm:digest(wasm),manifest:manifest===null?null:digest(canonical(manifest)),
   provenance:digest(canonical(provenance))};
 const seal={schemaVersion:1,type:"oreslang.atomic-release-v1",fileHashes};
 return {seal,releaseSha256:digest(canonical(seal))};
}
async function verifyDir(dir,id){
 if(!hex(id))fail("invalid identity");
 const st=await lstat(dir);
 if(!isPrivateDirectory(st))fail("release is not a real directory or has unsafe permissions");
 const seal=parseCanonicalSeal(await safeFile(join(dir,"seal.json"),16384));
 // A content-addressed release has a CLOSED on-disk namespace: hashes of
 // expected files do not authorize extra sidecars, executables or symlinks.
 // Reject unknown directory entries before returning a verified identity.
 // Do not use mutable Array.prototype predicates for these checks.
 const entries=await readdir(dir);
 const expectedCount=seal.fileHashes?.manifest===null?3:4;
 if(entries.length!==expectedCount)fail("unexpected sealed release entry");
 let wasmSeen=false,provenanceSeen=false,sealSeen=false,manifestSeen=false;
 for(let i=0;i<entries.length;i++){
  const name=entries[i];
  if(name==="guest.wasm"){wasmSeen=true;continue}
  if(name==="provenance.json"){provenanceSeen=true;continue}
  if(name==="seal.json"){sealSeen=true;continue}
  if(name==="artifact.json"&&expectedCount===4){manifestSeen=true;continue}
  fail("unexpected sealed release entry");
 }
 if(!wasmSeen||!provenanceSeen||!sealSeen||
    (expectedCount===4&&!manifestSeen))
  fail("missing sealed release entry");
 if(seal.schemaVersion!==1||seal.type!=="oreslang.atomic-release-v1"||
    !hex(seal.fileHashes?.wasm)||!hex(seal.fileHashes?.provenance)||
    !(seal.fileHashes.manifest===null||hex(seal.fileHashes.manifest))||
    digest(canonical(seal))!==id)fail("bad release seal");
 const wasm=await safeFile(join(dir,"guest.wasm"),16777216);
 const provenanceBytes=await safeFile(join(dir,"provenance.json"),16384);
 const manifestBytes=seal.fileHashes.manifest===null?null:
   await safeFile(join(dir,"artifact.json"),16384);
 if(digest(wasm)!==seal.fileHashes.wasm||
    digest(provenanceBytes)!==seal.fileHashes.provenance||
    (manifestBytes&&digest(manifestBytes)!==seal.fileHashes.manifest))
   fail("release content mutated");
 let manifest,provenance;
 try{provenance=parseUTF8JSON(provenanceBytes);
     manifest=manifestBytes?parseUTF8JSON(manifestBytes):null}
 catch{fail("invalid release metadata")}
 const computed=descriptorFor(wasm,manifest,provenance);
 if(computed.releaseSha256!==id)fail("release metadata mismatch");
 return {wasm,manifest,provenance,releaseSha256:id,directory:dir};
}
export async function readAtomicRelease(output){
 const {root,pointer}=paths(resolve(output));
 await requirePrivatePointerParent(pointer);
 const st=await lstat(root);
 if(!isPrivateDirectory(st))fail("invalid release root or unsafe permissions");
 const pointerBytes=await safeFile(pointer,16384);
 let p;
 try{p=parseUTF8JSON(pointerBytes)}
 catch{fail("invalid current pointer JSON")}
 // Publisher emits a single canonical encoding. Reject duplicate JSON keys,
 // reordered fields or alternate encodings instead of trusting last-key-wins.
 if(!p||typeof p!=="object"||nativeIsArray(p)||
    !orderedKeys(p,["schemaVersion","releaseSha256"])||
    !intrinsicApply(intrinsicBufferEquals,pointerBytes,[canonical(p)]))fail("noncanonical current pointer");
 if(p.schemaVersion!==1||!hex(p.releaseSha256))
  fail("invalid current pointer");
 return verifyDir(join(root,p.releaseSha256),p.releaseSha256);
}

/** A failed build leaves the previous current pointer unchanged. The new
 * release directory is written privately, independently checked, and moved
 * into place before one pointer rename (the linearization point).
 * Concurrent writers are last-writer-wins among verified complete releases.
 */
export async function publishAtomicRelease({
 output,wasm,manifest=null,provenance,
 // Test-only fault hooks run AFTER genuine IO barriers. They can only cause
 // a failure, never suppress fsync or alter the contents being sealed.
 __testAfterReleaseInstall,__testAfterReleaseRename,__testBeforePointerRename,
 __testAfterPointerRename,__testBeforeCleanup
}){
 if(typeof output!=="string"||!output)fail("missing output");
 
 const destination=resolve(output),{root,pointer}=paths(destination);
 const bytes=ownedWasmSnapshot(wasm);
 const {seal,releaseSha256}=descriptorFor(bytes,manifest,provenance);
 const provenanceBytes=canonical(provenance);
 const manifestBytes=manifest===null?null:canonical(manifest);
 if(provenanceBytes.length>16384||(manifestBytes&&manifestBytes.length>16384))
  fail("metadata exceeds 16 KiB");
 await mkdir(dirname(destination),{recursive:true});
 await mkdir(root,{recursive:true,mode:0o700});
 await requirePrivatePointerParent(pointer);
 const rootStat=await lstat(root);
 if(!isPrivateDirectory(rootStat))fail("release root symlink or unsafe permissions");
 // Persist the release-root directory entry before any pointer can refer to it.
 await fsyncDirectory(dirname(root));
 const stage=await mkdtemp(join(root,".staging-"));
 let pointerDir=null,primaryError=null,committedResult=null;
 try{
  await durableWrite(join(stage,"guest.wasm"),bytes);
  await durableWrite(join(stage,"provenance.json"),provenanceBytes);
  if(manifestBytes)await durableWrite(join(stage,"artifact.json"),manifestBytes);
  await durableWrite(join(stage,"seal.json"),canonical(seal));
  await verifyDir(stage,releaseSha256);
  await fsyncDirectory(stage);
  await chmod(stage,0o500);
  await fsyncDirectory(stage);
  const destinationDir=join(root,releaseSha256);
  try{await rename(stage,destinationDir)}
  catch(error){
   if((error.code!=="EEXIST"&&error.code!=="ENOTEMPTY"))throw error;
  }
  // Reject preexisting conflicting/replaced content, even if name matches.
  await verifyDir(destinationDir,releaseSha256);
  // Once renamed, the release may be visible but is never selected until
  // its directory entry is synchronized and the pointer is renamed.
  // This hook simulates failure *before* the release-root fsync.
  if(__testAfterReleaseRename)await __testAfterReleaseRename();
  // Release directory entry becomes durable before we expose its identity.
  await fsyncDirectory(root);
  if(__testAfterReleaseInstall)await __testAfterReleaseInstall();
  pointerDir=await mkdtemp(join(dirname(pointer),".oreslang-pointer-"));
  const temporaryPointer=join(pointerDir,"current.json");
  await durableWrite(temporaryPointer,canonical({schemaVersion:1,releaseSha256}));
  await fsyncDirectory(pointerDir);
  // A pre-pointer-rename failure is an ordinary abort: no new identity
  // became visible. The installed sealed release remains as an orphan.
  if(__testBeforePointerRename)await __testBeforePointerRename();
  await rename(temporaryPointer,pointer);
  // The pointer is already visible here, even if the next sync fails.
  // A retrying caller must NOT assume that the previous pointer remains.
  try {
   if(__testAfterPointerRename)await __testAfterPointerRename();
   await fsyncDirectory(dirname(pointer));
  }catch(error){
   throw new AtomicReleaseCommitUncertainError({pointer,releaseSha256,cause:error});
  }
  committedResult={releaseSha256,pointer,directory:destinationDir,wasmSha256:seal.fileHashes.wasm};
  return committedResult;
 }catch(error){
  primaryError=error;
  throw error;
 }finally{
  // Cleanup errors must not erase the more important commit outcome.
  // A crashed/failed cleanup may leave an orphan requiring inspection.
  try{
   if(__testBeforeCleanup)await __testBeforeCleanup();
   try{await chmod(stage,0o700)}
   catch(error){if(error.code!=="ENOENT")throw error}
   await rm(stage,{recursive:true,force:true});
   if(pointerDir)await rm(pointerDir,{recursive:true,force:true});
  }catch(cleanupError){
   if(primaryError){
    try{
     Object.defineProperty(primaryError,"cleanupFailure",{
      value:cleanupMessage(cleanupError),configurable:true,writable:true,enumerable:true
     });
    }catch{/* A frozen or hostile original error must not be replaced. */}
   }else if(committedResult){
    // Durable publication is a success, not an abort. Surface the orphaned
    // temp cleanup as a warning for operator inspection.
    try{
     Object.defineProperty(committedResult,"cleanupWarning",{
      value:{code:"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED",
       message:cleanupMessage(cleanupError)},
      configurable:true,writable:true,enumerable:true
     });
    }catch{/* A durable commit remains successful despite warning failure. */}
   }else{
    throw cleanupError;
   }
  }
 }
}

// Read-only recovery inspection. Never collect orphans automatically:
// a concurrently executing reader may still have pinned their identity.
export async function inspectAtomicReleaseState(output){
 if(typeof output!=="string"||!output)fail("missing output");
 const {root}=paths(resolve(output));
 let current=null,pointerError=null;
 try{current=(await readAtomicRelease(output)).releaseSha256}
 catch(error){pointerError=String(error?.message||error).slice(0,256)}
 let entries;
 try{
  const stat=await lstat(root);
  if(!isPrivateDirectory(stat))fail("invalid release root or unsafe permissions");
  entries=await readdir(root,{withFileTypes:true});
 }catch(error){
  if(error?.code==="ENOENT")
   return {current,pointerError,staging:[],unreferenced:[],invalid:[]};
  throw error;
 }
 if(entries.length>4096)fail("recovery scan exceeds entry budget");
 const staging=[],unreferenced=[],invalid=[];
 for(const entry of entries){
  if(entry.name.startsWith(".staging-")){staging[staging.length]=entry.name;continue}
  if(!hex(entry.name)){invalid[invalid.length]=entry.name;continue}
  if(entry.name===current)continue;
  try{await verifyDir(join(root,entry.name),entry.name);unreferenced[unreferenced.length]=entry.name}
  catch{invalid[invalid.length]=entry.name}
 }
 return {current,pointerError,staging,unreferenced,invalid};
}
