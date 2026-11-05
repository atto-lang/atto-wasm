/**
 * Experimental, explicit end-to-end bridge:
 * native oreslang-llvmc (.ores -> LLVM IR) -> clang wasm32 -> Wasm module.
 * There is no fallback or mock compiler; caller must pass a real binary.
 */
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {writeFile,mkdir,mkdtemp,rm,rename,realpath,stat,open} from "node:fs/promises";
import {dirname,resolve,isAbsolute,join,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {assertCoreI64Entry} from "./core-i64-abi.mjs";
import {assertImportFreeSource} from "./import-admission.mjs";
import {inspectWasmBytes} from "./inspect-core-memory.mjs";
import {publishAtomicRelease} from "./atomic-release.mjs";
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_BYTES=1024*1024,MAX_COMPILER_BYTES=256*1024*1024,MAX_WASM_BYTES=16*1024*1024;
// A preflight stat(path) is not an admission guard against an attacker
// replacing that pathname with a FIFO or growing file before readFile(path).
// Use one nonblocking, nofollow descriptor for both fstat and bounded reads.
// Read a single immutable descriptor snapshot. Caller pathnames can be
// replaced between preflight and open, and regular files can be rewritten or
// grown during a read; neither case may be certified by the bridge.
export async function readBounded(path,limit,label,expectedIdentity=undefined){
 if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError("invalid bounded file read limit");
 if(!Number.isInteger(fsConstants.O_NOFOLLOW)||!Number.isInteger(fsConstants.O_NONBLOCK))
  throw Error("bounded no-follow file reads unsupported on this host");
 const limitError=label==="source"?"source exceeds 1 MiB compiler bridge budget":
  label==="compiler"?"compiler exceeds 256 MiB executable budget":
  label==="linked Wasm"?"linked Wasm exceeds 16 MiB artifact budget":
  label+" exceeds configured byte budget";
 const fd=await open(path,fsConstants.O_RDONLY|fsConstants.O_NONBLOCK|fsConstants.O_NOFOLLOW);
 try{
  const before=await fd.stat({bigint:true});
  if(!before.isFile())throw Error(label+" is not a regular file");
  if(before.size===0n)throw Error(label+" is empty");
  if(before.size>BigInt(limit))throw Error(limitError);
  if(expectedIdentity!==undefined && (
     before.dev!==BigInt(expectedIdentity.dev) ||
     before.ino!==BigInt(expectedIdentity.ino) ||
     before.size!==BigInt(expectedIdentity.size)))
   throw Error(label+" input changed between preflight and bounded snapshot");
  const chunks=[];let total=0;
  for(;;){
   const buf=Buffer.allocUnsafe(Math.min(65536,limit-total+1));
   const {bytesRead}=await fd.read(buf,0,buf.length,null);
   if(bytesRead===0)break;
   total+=bytesRead;
   if(total>limit)throw Error(limitError);
   chunks.push(buf.subarray(0,bytesRead));
  }
  const after=await fd.stat({bigint:true});
  if(!after.isFile()||before.dev!==after.dev||before.ino!==after.ino||
     before.size!==after.size||before.mtimeNs!==after.mtimeNs||
     before.ctimeNs!==after.ctimeNs||BigInt(total)!==before.size)
   throw Error(label+" input changed during bounded snapshot");
  return Buffer.concat(chunks,total);
 }finally{await fd.close()}
}
function rejectStartSection(bytes){
 let i=8;
 const u32=()=>{let value=0;for(let j=0;j<5;j++){
  if(i>=bytes.length)throw Error("truncated Wasm section length");
  const v=bytes[i++];
  if(j===4 && (v&0xf0))throw Error("invalid Wasm section length");
  value+=(v&127)*2**(7*j);
  if(!(v&128))return value;
 }throw Error("invalid Wasm LEB128 length")};
 while(i<bytes.length){
  const id=bytes[i++],length=u32(),end=i+length;
  if(end>bytes.length)throw Error("truncated linked Wasm module");
  if(id===8)throw Error("linked module has forbidden start section");
  i=end;
 }
}

async function rejectMixedPublication(published,publication){
 const conflicts=publication==="atomic"?
  [published,published+".artifact.json",published+".provenance.json"]:
  [published+".current.json",published+".releases"];
 for(const path of conflicts){
  try{
   await stat(path);
   throw Error("legacy and atomic artifact publications cannot share an output path");
  }catch(error){if(error.code!=="ENOENT")throw error}
 }
}
// Cooperating compiler processes serialize the actual publication boundary,
// not source compilation. An abandoned lock fails closed until cleaned by an
// operator; never steal a lock based on an untrusted pid/time claim.
async function withPublicationLock(published,publication,callback){
 const lock=published+".publication.lock";
 let acquired=false;
 for(let attempt=0;attempt<160;attempt++){
  try{await mkdir(lock,{mode:0o700});acquired=true;break}
  catch(error){
   if(error.code!=="EEXIST")throw error;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
 }
 if(!acquired)throw Error("artifact publication lock unavailable");
 try{
  // This second admission check is serialized across cooperating compilers.
  await rejectMixedPublication(published,publication);
  return await callback();
 }finally{
  await rm(lock,{recursive:true,force:true});
 }
}
const absolute=(value,label)=>{if(!value||!isAbsolute(value))throw Error(label+" must be an absolute path");return value};
function run(command,args,{input}={}){
 const output=spawnSync(command,args,{input,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
 if(output.error||output.status!==0||output.signal)throw Error("command failed ("+command+"): "+(output.error?.message||output.stderr||"exit "+output.status).slice(0,4000));
 return output.stdout||"";
}
export async function compileOresToWasm({compiler,source,output,exportName="main",clang=process.env.CLANG||"clang",compilerSha256,environment,publication="legacy"}){
 absolute(compiler,"compiler");
 absolute(source,"source");
 absolute(output,"output");
 // Resolve directory symlinks ONCE and use that physical pathname for
 // publication, not the caller's possibly aliased directory spelling.
 // A lexical resolve() comparison alone can overwrite compiler/source
 // inputs through an alternate symlinked parent directory.
 await mkdir(dirname(output),{recursive:true});
 // Canonicalize directory aliases, but preserve the caller's source leaf.
 // Resolving realpath(source) would follow and conceal an untrusted symlink
 // before readBounded can enforce O_NOFOLLOW on its opened descriptor.
 const [sourceParent,compilerPath,outputParent]=await Promise.all([
  realpath(dirname(source)),realpath(compiler),realpath(dirname(output))
 ]);
 const sourcePath=join(sourceParent,basename(source));
 const published=join(outputParent,basename(output));
 const protectedInputs=new Set([sourcePath,compilerPath]);
 if(!["atomic","legacy"].includes(publication))throw Error("invalid artifact publication mode");
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases",published+".publication.lock"]){
  if(protectedInputs.has(destination))
   throw Error("output or artifact metadata path overlaps a compiler/source input");
 }
 if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(exportName))throw Error("unsupported export name");
 // Preflight before readFile() to avoid allocating attacker-sized compiler
 // binaries or source buffers, then check the lengths again after reading.
 const [sourceStat,compilerStat]=await Promise.all([stat(sourcePath),stat(compilerPath)]);
 if(!sourceStat.isFile()||sourceStat.size>MAX_SOURCE_BYTES)
  throw Error("source exceeds 1 MiB compiler bridge budget or is not a regular file");
 if(!compilerStat.isFile()||compilerStat.size>MAX_COMPILER_BYTES)
  throw Error("compiler exceeds 256 MiB executable budget or is not a regular file");
 // A destination that already exists might itself be a symlink or hard link
 // to an input. Reject by inode identity before publishing over the link.
 // Merely canonicalizing its parent directory does not catch this case.
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases"]){
  try{
   const existing=await stat(destination);
   if([sourceStat,compilerStat].some(input=>
      input.dev===existing.dev&&input.ino===existing.ino))
    throw Error("output or artifact metadata path overlaps a compiler/source input");
  }catch(error){if(error?.code!=="ENOENT")throw error}
 }
 await rejectMixedPublication(published,publication);
 const [sourceBytes,compilerBytes]=await Promise.all([
  readBounded(sourcePath,MAX_SOURCE_BYTES,"source",sourceStat),
  readBounded(compilerPath,MAX_COMPILER_BYTES,"compiler",compilerStat)
 ]);
 if(sourceBytes.length>MAX_SOURCE_BYTES)throw Error("source exceeds 1 MiB compiler bridge budget");
 // Imports cannot be resolved against the single-file scalar source snapshot.
 // Enforce this before invoking even a compiler that falsely accepts them.
 assertImportFreeSource(sourceBytes);
 if(compilerBytes.length>MAX_COMPILER_BYTES)throw Error("compiler exceeds 256 MiB executable budget");
 const actualCompilerHash=sha(compilerBytes);
 if(compilerSha256!==undefined&&compilerSha256!==actualCompilerHash)throw Error("compiler binary SHA-256 does not match pinned hash");
 if(environment!==undefined&&!["browser","edge-js","edge-wasi"].includes(environment))
  throw Error("unsupported portable host environment");
 // Compile exactly the already-hashed source snapshot, not a mutable path.
 // The current scalar subset supports standalone source files; relative
 // source imports must be resolved and pinned by a future module graph gate.
 const scratch=await mkdtemp(join(outputParent,".oreslang-wasm-"));
 const provisional=join(scratch,"guest.wasm");
 try{
 // Keep the canonical .atto suffix when passing the pinned source snapshot
 // to the native compiler. Legacy callers retain the historical .ores path.
 // Extension handling does not relax import or compiler-binary admission.
 const stagedSource=join(scratch,sourcePath.endsWith(".atto")?"source.atto":"source.ores");
 const stagedCompiler=join(scratch,"compiler-exact");
 await writeFile(stagedSource,sourceBytes,{mode:0o400,flag:"wx"});
 // Execute the exact compiler bytes whose SHA-256 we pinned, not a mutable
 // caller-supplied pathname that may be replaced between hashing and exec.
 // The private scratch directory prevents pathname substitution by another
 // filesystem principal; this is not a sandbox for a malicious compiler.
 await writeFile(stagedCompiler,compilerBytes,{mode:0o500,flag:"wx"});
 const ir=run(stagedCompiler,environment?["--target=wasm32",stagedSource]:[stagedSource]);
 if(sha(await readBounded(stagedCompiler,MAX_COMPILER_BYTES,"staged compiler"))!==actualCompilerHash)
  throw Error("staged compiler executable changed during execution");
 // The executable itself is also caller-owned mutable input. Never publish
 // provenance tied to a compiler digest if its executable changed in flight.
 if(sha(await readBounded(compilerPath,MAX_COMPILER_BYTES,"compiler"))!==actualCompilerHash)
  throw Error("compiler executable changed during execution; refusing stale provenance");
 // Reject mutation of the snapshotted compilation input even when the
 // original caller path remains unchanged.
 if(sha(await readBounded(stagedSource,MAX_SOURCE_BYTES,"staged source"))!==sha(sourceBytes))
  throw Error("staged compiler input changed during execution");
 if(environment&&!/target triple = "wasm32-unknown-unknown"/.test(ir))
  throw Error("compiler did not emit wasm32 target-marked IR");
 if(!new RegExp("define\\s+i64\\s+@"+exportName+"\\s*\\(\\s*\\)").test(ir))throw Error("compiler did not emit the expected i64 @"+exportName+"() export");
 if(ir.length>2*1024*1024)throw Error("generated IR exceeds 2 MiB");
 // Avoid shell expansion and avoid relying on persistent temporary LLVM IR.
 // Clang reads the native compiler's verified stdout as LLVM IR.
 run(clang,["--target=wasm32","-x","ir","-Oz","-nostdlib",
   "-Wl,--no-entry","-Wl,--export="+exportName,
   "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
   "-o",provisional,"-"],{input:ir});
 const wasmStat=await stat(provisional);
 if(!wasmStat.isFile()||wasmStat.size>MAX_WASM_BYTES)
  throw Error("linked Wasm exceeds 16 MiB artifact budget");
 const wasm=await readBounded(provisional,MAX_WASM_BYTES,"linked Wasm");
 if(wasm.length>MAX_WASM_BYTES)throw Error("linked Wasm exceeds 16 MiB artifact budget");
 if(!WebAssembly.validate(wasm))throw Error("linker emitted invalid core Wasm");
 rejectStartSection(wasm);
 const module=new WebAssembly.Module(wasm);
 const imports=WebAssembly.Module.imports(module);
 if(imports.length)throw Error("guest Wasm unexpectedly imports host modules: "+imports.map(x=>x.module+"."+x.name).join(","));
 if(!WebAssembly.Module.exports(module).some(x=>x.name===exportName&&x.kind==="function"))throw Error("guest Wasm missing requested export");
 assertCoreI64Entry(wasm,exportName);
 // The artifact manifest advertises an exact 2-page memory maximum. Check
 // the binary rather than relying on Clang flags or its version string.
 const memory=inspectWasmBytes(wasm,{maxModuleBytes:MAX_WASM_BYTES,maxMemoryPages:2});
 if(memory.memoryCount!==1||!memory.hasMemoryMaximum||memory.memoryMaximum!==2)
  throw Error("linked Wasm memory must declare exactly one bounded 2-page memory");
 const record={
  schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",
  compilerSha256:actualCompilerHash,sourceSha256:sha(sourceBytes),
  llvmIrSha256:sha(Buffer.from(ir,"utf8")),wasmSha256:sha(wasm),
  exportName,importCount:imports.length,wasmBytes:wasm.length,
  clangVersion:run(clang,["--version"]).split("\n")[0],
  note:"Binary provenance: exact compiler executable bytes, not proof of source-repository commit or feature parity."
 };
 let manifest=null;
 if(environment){
  manifest={
   schemaVersion:1,artifactType:"oreslang.core-wasm.i64-v1",
   target:"wasm32",environment,backend:"wasm",entry:exportName,
   wasmSha256:sha(wasm),wasmBytes:wasm.length,requiredCapabilities:[],
   imports:[],memory:{maximumPages:2},
   producer:{compilerSha256:actualCompilerHash,
     sourceSha256:sha(sourceBytes),llvmIrSha256:sha(Buffer.from(ir,"utf8"))}
  };
  await writeFile(join(scratch,"artifact.json"),JSON.stringify(manifest,null,2)+"\n");
 }
 await writeFile(join(scratch,"provenance.json"),JSON.stringify(record,null,2)+"\n");
 return await withPublicationLock(published,publication,async()=>{
 if(publication==="atomic"){
  // The content-addressed release is privately staged and sealed first.
  // Only a single pointer rename makes it visible to verified readers.
  const publishedRelease=await publishAtomicRelease({
   output:published,wasm,manifest,provenance:record
  });
  return {...record,releaseSha256:publishedRelease.releaseSha256,
   publication:"atomic",pointer:publishedRelease.pointer};
 }
 // Publish metadata first; never expose a new executable after metadata
 // publication failed. Consumers must still SHA-check all sidecars: separate
 // files cannot be atomically committed as one transaction.
 if(environment)await rename(join(scratch,"artifact.json"),published+".artifact.json");
 await rename(join(scratch,"provenance.json"),published+".provenance.json");
 await rename(provisional,published);
 return record;
 });
 }finally{await rm(scratch,{recursive:true,force:true})}
}
const calledFromCli=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(calledFromCli){
 try{
  // Duplicate policy/configuration flags must fail closed: silently taking
  // the last compiler SHA or output pathname makes the build invocation
  // ambiguous and can bypass an intended caller-side pin.
  const options={};
  for(const x of process.argv.slice(2)){
   const m=/^--(compiler|source|output|export|clang|compiler-sha256|environment|publication)=(.*)$/.exec(x);
   if(!m)throw Error("unexpected CLI option: "+x);
   if(Object.hasOwn(options,m[1]))throw Error("duplicate CLI option: "+m[1]);
   options[m[1]]=m[2];
  }
  const record=await compileOresToWasm({
   compiler:options.compiler,source:options.source,
   output:options.output||resolve(projectRoot,"build/guest.wasm"),
   exportName:options.export||"main",clang:options.clang||process.env.CLANG||"clang",
   compilerSha256:options["compiler-sha256"],environment:options.environment,publication:options.publication||"legacy"
  });
  console.log(JSON.stringify(record,null,2));
 }catch(error){console.error(error.stack||error.message);process.exitCode=1}
}
