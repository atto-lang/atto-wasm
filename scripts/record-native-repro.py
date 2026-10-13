#!/usr/bin/env python3
"""Emit machine-comparable evidence from an independent native Oreslang build.

Called after compiling the SHA-pinned native source and two .ores programs in
isolated CI jobs. Only content identities, never timestamps or machine paths,
participate in the reproduction comparison.
"""
import hashlib
import json
import pathlib
import platform
import subprocess
import sys

def command(*args):
    return subprocess.check_output(args,text=True).strip()

def sha256(path):
    digest=hashlib.sha256()
    with open(path,"rb") as stream:
        for block in iter(lambda:stream.read(1<<20),b""):
            digest.update(block)
    return digest.hexdigest()

def main():
    if len(sys.argv)!=3 or sys.argv[1] not in ("a","b"):
        raise SystemExit("usage: record-native-repro.py a|b EVIDENCE_DIR")
    replica=sys.argv[1]
    root=pathlib.Path.cwd()
    src=root/"contracts/native-toolchain-ubuntu2404.lock.json"
    native=root/"build/source-llvm/oreslang-llvmc"
    if not native.is_file():
        raise SystemExit("native compiler missing")
    evidence={
        "schemaVersion":1,
        "kind":"oreslang.reproducible-native-wasm-v1",
        "sourceTree":command("git","rev-parse","HEAD^{tree}"),
        "sourceCommit":command("git","rev-parse","HEAD"),
        "nativeToolchainLockSha256":sha256(src),
        "ubuntuVersion":command("lsb_release","-rs"),
        "arch":platform.machine(),
        "packages":{},
        "nativeCompilerSha256":sha256(native),
        "guests":[],
    }
    for pkg in ("build-essential","cmake","clang","lld","llvm-dev"):
        evidence["packages"][pkg]=command("dpkg-query","-W","-f=${Version}",pkg)
    for expected in (42,43):
        base=root/f"build/repro-{expected}.wasm"
        pointer=json.loads(pathlib.Path(str(base)+".current.json").read_text())
        identity=pointer["releaseSha256"]
        release=pathlib.Path(str(base)+".releases")/identity
        seal=release/"seal.json"
        wasm=release/"guest.wasm"
        evidence["guests"].append({
            "expectedI64":expected,
            "releaseSha256":identity,
            "sealSha256":sha256(seal),
            "wasmSha256":sha256(wasm)
        })
    out=pathlib.Path(sys.argv[2])
    out.mkdir(parents=True,exist_ok=True)
    dest=out/f"native-{replica}.json"
    dest.write_text(json.dumps(evidence,sort_keys=True,indent=2)+"\n")
    print("INDEPENDENT_NATIVE_EVIDENCE_SHA256",sha256(dest))
    print("INDEPENDENT_NATIVE_COMPILER_SHA256",evidence["nativeCompilerSha256"])
    print("INDEPENDENT_NATIVE_RELEASES",json.dumps(evidence["guests"],sort_keys=True))
    print("INDEPENDENT_NATIVE_SOURCE_TREE",evidence["sourceTree"])

if __name__=="__main__":
    main()
