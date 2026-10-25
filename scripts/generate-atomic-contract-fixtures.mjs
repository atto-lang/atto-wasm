// Build actual compiler-bridge records for independent JSON Schema checking.
// Synthetic LLVM stdout tests publication contracts, NOT language frontend.
import {mkdtemp,writeFile,readFile,mkdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {compileOresToWasm} from "./compile-ores.mjs";
import {readAtomicRelease} from "./atomic-release.mjs";

const destination=resolve(process.argv[2]||"build/atomic-contract-fixtures");
await mkdir(destination,{recursive:true});
const dir=await mkdtemp(join(tmpdir(),"ores-contract-"));
try{
 const compiler=join(dir,"stub.sh"),source=join(dir,"sample.ores"),output=join(dir,"fixture.wasm");
 await writeFile(compiler,
  "#!/bin/sh\nprintf 'target triple = \"wasm32-unknown-unknown\"\\ndefine i64 @main() { ret i64 42 }\\n'\n",
  {mode:0o700});
 await writeFile(source,"pub fnc main(): int { return 42; }\n");
 const result=await compileOresToWasm({
  compiler,source,output,environment:"browser",publication:"atomic"
 });
 const checked=await readAtomicRelease(output);
 if(result.releaseSha256!==checked.releaseSha256)
  throw Error("validated fixture release ID mismatch");
 for(const [name,bytes] of [
   ["Pointer",await readFile(output+".current.json")],
   ["Seal",await readFile(join(checked.directory,"seal.json"))],
   ["Manifest",await readFile(join(checked.directory,"artifact.json"))],
   ["Provenance",await readFile(join(checked.directory,"provenance.json"))]
 ]){
  await writeFile(join(destination,name+".json"),bytes,{flag:"w"});
 }
 console.log("PASS generated real atomic-contract records from compiled Wasm",
   result.releaseSha256);
}finally{
 // Sealed directories are intentionally read-only. This whole workspace
 // belongs solely to the fixture generator, not any production reader.
 const {readdir,chmod}=await import("node:fs/promises");
 const releaseRoot=join(dir,"fixture.wasm.releases");
 try{
  for(const entry of await readdir(releaseRoot,{withFileTypes:true}))
   if(entry.isDirectory())await chmod(join(releaseRoot,entry.name),0o700);
 }catch(error){if(error.code!=="ENOENT")throw error}
 await rm(dir,{recursive:true,force:true});
}
