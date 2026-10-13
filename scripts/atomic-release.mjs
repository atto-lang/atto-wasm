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
const digest=b=>createHash("sha256").update(b).digest("hex");
const hex=x=>typeof x==="string"&&/^[0-9a-f]{64}$/.test(x);
// JSON Schema maxLength counts Unicode code points, not UTF-16 units.
// Stop scanning at max+1; never allocate a second copy of caller text.
function boundedCodePoints(value,min,max){
 if(typeof value!=="string")return false;
 let n=0;
 for(const _codepoint of value)if(++n>max)return false;
 return n>=min;
}
const fail=x=>{throw Error("invalid atomic Oreslang release: "+x)};
const arrayViewProto=Object.getPrototypeOf(Uint8Array.prototype);
const nativeBuffer=Object.getOwnPropertyDescriptor(arrayViewProto,"buffer").get;
const nativeOffset=Object.getOwnPropertyDescriptor(arrayViewProto,"byteOffset").get;
const nativeLength=Object.getOwnPropertyDescriptor(arrayViewProto,"byteLength").get;
// Never ask an untrusted typed-array subclass for .length, .buffer or
// Symbol.iterator. Buffer.from(view) consults subclass .length and can copy a
// different number of bytes than the native Uint8Array backing view.
function ownedWasmSnapshot(wasm){
 if(isProxy(wasm))fail("invalid Wasm bytes");
 let backing,offset,length;
 try{
  backing=nativeBuffer.call(wasm);
  offset=nativeOffset.call(wasm);
  length=nativeLength.call(wasm);
 }catch{fail("invalid Wasm bytes")}
 // Native brand checks cannot be evaded by swapping a view/backing prototype.
 // `instanceof` is insufficient: a Uint16Array can masquerade as Uint8Array,
 // and SharedArrayBuffer can masquerade as ArrayBuffer.
 if(!isUint8Array(wasm)||isSharedArrayBuffer(backing))
  fail("invalid Wasm bytes");
 if(length<8||length>16777216)fail("Wasm budget");
 // Newly constructed intrinsic view has no caller-controlled prototype
 // overrides; it is copied synchronously before metadata validation.
 return Buffer.from(new Uint8Array(backing,offset,length));
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
const canonical=x=>Buffer.from(JSON.stringify(x)+"\n");
// Keep runtime admission aligned with atomic-release-v1.schema.json, which
// specifies closed records. Digest equality is not a schema/authority check.
// Closed JSON record admission must reject inherited, hidden, symbol and
// accessor properties, not merely count enumerable names. In particular,
// getters could otherwise return different values during validation and seal
// serialization, producing inconsistent source-of-authority records.
const exactKeys=(value,keys)=>value!==null&&typeof value==="object"&&
 !isProxy(value)&&!Array.isArray(value)&&
 [Object.prototype,null].includes(Object.getPrototypeOf(value))&&
 Reflect.ownKeys(value).length===keys.length&&
 keys.every(key=>{
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  return !!descriptor&&descriptor.enumerable===true&&
    Object.hasOwn(descriptor,"value");
 });
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
// prevents a file-path substitution from turning a validated regular file into
// a symlink. Chunked reads stop at the cap even if a file grows while reading.
async function safeFile(path,limit){
 // O_NOFOLLOW denies symlinks. O_NONBLOCK additionally prevents a substituted
 // FIFO/device pathname from parking the verifier before fstat can reject it.
 const handle=await open(path,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW|
   fsConstants.O_NONBLOCK);
 try{
  const stat=await handle.stat();
  if(!stat.isFile()||stat.size>limit)fail("invalid file");
  const chunks=[];
  let length=0;
  for(;;){
   const chunk=Buffer.allocUnsafe(Math.min(65536,limit+1-length));
   const {bytesRead}=await handle.read(chunk,0,chunk.length,null);
   if(bytesRead===0)break;
   length+=bytesRead;
   if(length>limit)fail("oversized file");
   chunks.push(chunk.subarray(0,bytesRead));
  }
  return Buffer.concat(chunks,length);
 }finally{await handle.close()}
}
// Verify the exact bytes before interpreting the seal. Unlike JSON.parse,
// byte-canonical validation rejects duplicate keys, alternate whitespace,
// field reordering and invalid UTF-8 that other runtimes may parse differently.
function parseCanonicalSeal(bytes){
 let seal;
 try{seal=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes))}
 catch{fail("invalid release seal JSON")}
 if(!seal||typeof seal!=="object"||Array.isArray(seal)||
    !bytes.equals(canonical(seal))||
    Object.keys(seal).join(",")!=="schemaVersion,type,fileHashes"||
    !seal.fileHashes||typeof seal.fileHashes!=="object"||
    Array.isArray(seal.fileHashes)||
    Object.keys(seal.fileHashes).join(",")!=="wasm,manifest,provenance")
   fail("noncanonical release seal");
 return seal;
}
function descriptorFor(wasm,manifest,provenance){
 if(wasm.length<8||wasm.length>16777216)fail("Wasm budget");
 if(!WebAssembly.validate(wasm))fail("invalid executable Wasm");
 if(!exactKeys(provenance,["schemaVersion","kind","compilerSha256",
      "sourceSha256","llvmIrSha256","wasmSha256","exportName","wasmBytes",
      "importCount","clangVersion","note"])||
    provenance.kind!=="llvm-ores-to-wasm32-core-experimental"||
    provenance.schemaVersion!==1||
    !["compilerSha256","sourceSha256","llvmIrSha256"].every(k=>
      hex(provenance[k]))||!hex(provenance.wasmSha256)||
    !Number.isSafeInteger(provenance.wasmBytes)||provenance.wasmBytes!==wasm.length||
    typeof provenance.exportName!=="string"||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provenance.exportName)||
    provenance.importCount!==0||
    !boundedCodePoints(provenance.clangVersion,1,256)||
    !boundedCodePoints(provenance.note,0,1024))
   fail("invalid producer record");
 if(provenance.wasmSha256!==digest(wasm))fail("invalid provenance digest");
 if(WebAssembly.Module.imports(new WebAssembly.Module(wasm)).length!==0)
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
   !["browser","edge-js","edge-wasi"].includes(manifest.environment)||
   typeof manifest.entry!=="string"||manifest.entry.length>128||
   !/^[A-Za-z_][A-Za-z0-9_]*$/.test(manifest.entry)||
   manifest.entry!==provenance.exportName||
   manifest.wasmBytes!==wasm.length||
   !exactKeys(manifest.memory,["maximumPages"])||
   manifest.memory.maximumPages!==2||
   !Array.isArray(manifest.imports)||isProxy(manifest.imports)||
   manifest.imports.length!==0||
   !Array.isArray(manifest.requiredCapabilities)||
   isProxy(manifest.requiredCapabilities)||
   manifest.requiredCapabilities.length!==0||
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
 if(!st.isDirectory()||st.isSymbolicLink())fail("release is not a real directory");
 const seal=parseCanonicalSeal(await safeFile(join(dir,"seal.json"),16384));
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
 try{provenance=JSON.parse(provenanceBytes);
     manifest=manifestBytes?JSON.parse(manifestBytes):null}
 catch{fail("invalid release metadata")}
 const computed=descriptorFor(wasm,manifest,provenance);
 if(computed.releaseSha256!==id)fail("release metadata mismatch");
 return {wasm,manifest,provenance,releaseSha256:id,directory:dir};
}
export async function readAtomicRelease(output){
 const {root,pointer}=paths(resolve(output));
 const st=await lstat(root);
 if(!st.isDirectory()||st.isSymbolicLink())fail("invalid release root");
 const pointerBytes=await safeFile(pointer,16384);
 let p;
 try{p=JSON.parse(pointerBytes.toString("utf8"))}
 catch{fail("invalid current pointer JSON")}
 // Publisher emits a single canonical encoding. Reject duplicate JSON keys,
 // reordered fields or alternate encodings instead of trusting last-key-wins.
 if(!p||typeof p!=="object"||Array.isArray(p)||
    Object.keys(p).join(",")!=="schemaVersion,releaseSha256"||
    !pointerBytes.equals(canonical(p)))fail("noncanonical current pointer");
 if(p.schemaVersion!==1||!hex(p.releaseSha256)||
    Object.keys(p).sort().join(",")!=="releaseSha256,schemaVersion")
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
 const rootStat=await lstat(root);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())fail("release root symlink");
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
   if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error;
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
    primaryError.cleanupFailure=String(cleanupError?.message||cleanupError).slice(0,256);
   }else if(committedResult){
    // Durable publication is a success, not an abort. Surface the orphaned
    // temp cleanup as a warning for operator inspection.
    committedResult.cleanupWarning={
     code:"ATOMIC_RELEASE_POST_COMMIT_CLEANUP_FAILED",
     message:String(cleanupError?.message||cleanupError).slice(0,256)
    };
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
  if(!stat.isDirectory()||stat.isSymbolicLink())fail("invalid release root");
  entries=await readdir(root,{withFileTypes:true});
 }catch(error){
  if(error?.code==="ENOENT")
   return {current,pointerError,staging:[],unreferenced:[],invalid:[]};
  throw error;
 }
 if(entries.length>4096)fail("recovery scan exceeds entry budget");
 const staging=[],unreferenced=[],invalid=[];
 for(const entry of entries){
  if(entry.name.startsWith(".staging-")){staging.push(entry.name);continue}
  if(!hex(entry.name)){invalid.push(entry.name);continue}
  if(entry.name===current)continue;
  try{await verifyDir(join(root,entry.name),entry.name);unreferenced.push(entry.name)}
  catch{invalid.push(entry.name)}
 }
 return {current,pointerError,staging,unreferenced,invalid};
}
