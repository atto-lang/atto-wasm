// Filesystem-only QEMU qualification fixture: genuine Clang core Wasm, not an
// Oreslang frontend compiler parity claim. Creates two independently sealed
// i64 guest identities for a disposable offline ext4 VM.
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {join,resolve} from "node:path";
import {publishAtomicRelease,readAtomicRelease} from "./atomic-release.mjs";

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const dir=resolve(process.argv[2]||"");
if(!process.argv[2]||!dir.includes("/"))throw Error("must specify isolated guest workspace");
await mkdir(join(dir,"payload"),{recursive:true});
const path=join(dir,"slot.wasm");
const clang="/usr/bin/clang",clangBytes=await readFile(clang);
const clangSha=sha(clangBytes);
const next=[];
for(const expected of [42,43,44,45]){
 const ir=Buffer.from('target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 '+expected+' }\n');
 const outfile=join(dir,"payload","artifact-"+expected+".wasm");
 const run=spawnSync(clang,["--target=wasm32","-x","ir","-Oz","-nostdlib",
   "-Wl,--no-entry","-Wl,--export=main","-Wl,--initial-memory=131072",
   "-Wl,--max-memory=131072","-o",outfile,"-"],{input:ir,encoding:null,timeout:30000});
 if(run.error||run.status!==0)throw Error("fixture Clang failed: "+String(run.stderr));
 const wasm=await readFile(outfile);
 const compilerSha256=clangSha,sourceSha256=sha(ir),llvmIrSha256=sha(ir);
 const provenance={
  schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",
  compilerSha256,sourceSha256,llvmIrSha256,wasmSha256:sha(wasm),
  exportName:"main",wasmBytes:wasm.length,importCount:0,
  clangVersion:spawnSync(clang,["--version"],{encoding:"utf8"}).stdout.split("\n")[0],
  note:"QEMU filesystem durability LLVM i64 fixture only; not an Oreslang source frontend result"
 };
 const manifest={
  schemaVersion:1,artifactType:"oreslang.core-wasm.i64-v1",
  target:"wasm32",environment:"browser",backend:"wasm",entry:"main",
  wasmSha256:sha(wasm),wasmBytes:wasm.length,imports:[],requiredCapabilities:[],
  memory:{maximumPages:2},producer:{compilerSha256,sourceSha256,llvmIrSha256}
 };
 if(expected===42){
  const published=await publishAtomicRelease({output:path,wasm,manifest,provenance});
  const selected=await readAtomicRelease(path);
  if(selected.releaseSha256!==published.releaseSha256)throw Error("baseline verification failure");
  next.push({expected,releaseSha256:published.releaseSha256,wasmSha256:sha(wasm)});
 }else{
  await writeFile(join(dir,"payload","next-provenance-"+expected+".json"),JSON.stringify(provenance)+"\n");
  await writeFile(join(dir,"payload","next-manifest-"+expected+".json"),JSON.stringify(manifest)+"\n");
  // Derive the expected identity from the exact canonical seal, not from
  // the return value alone. The guest must later select THIS release, not an
  // unrelated valid i64-43 guest with a different hash.
  const metadataBytes=x=>Buffer.from(JSON.stringify(x)+"\n");
  const seal={schemaVersion:1,type:"oreslang.atomic-release-v1",
   fileHashes:{wasm:sha(wasm),manifest:sha(metadataBytes(manifest)),
    provenance:sha(metadataBytes(provenance))}};
  next.push({expected,releaseSha256:sha(metadataBytes(seal)),wasmSha256:sha(wasm)});
 }
}
await writeFile(join(dir,"payload","expected.json"),JSON.stringify(next)+"\n");
console.log("QEMU_FIXTURES_PREPARED",JSON.stringify(next));
