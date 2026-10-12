#!/usr/bin/env python3
"""Capture and compare native compiler identity from a digest-pinned OCI base.

The root filesystem is immutable by digest; apt repositories are LIVE, so this
is not a fully hermetic build. We record and independently compare the entire
installed package graph and the emitted executable, failing closed on drift.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

OCI_AMD64="sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b"

def digest(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for chunk in iter(lambda:f.read(1<<20),b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    if len(sys.argv)!=4 or sys.argv[1] not in ("a","b"):
        raise SystemExit("usage: record-native-oci-repro.py a|b EXECUTABLE OUTPUT_DIR")
    replica,compiler=sys.argv[1:3]
    path=Path(compiler)
    if not path.is_file():
        raise SystemExit("missing OCI compiler output")
    tree=os.environ.get("SOURCE_TREE","")
    if not re.fullmatch("[0-9a-f]{40}",tree):
        raise SystemExit("unbound OCI build Git tree")
    pkgdata=subprocess.check_output(["dpkg-query","-W","-f=${binary:Package}=${Version}\\n"],text=True)
    package_graph=("\n".join(sorted(pkgdata.splitlines()))+"\n").encode()
    lock=Path("/src/contracts/native-toolchain-ubuntu2404.lock.json")
    obj={
        "schemaVersion":1,
        "kind":"oreslang.oci-native-source-repro-v1",
        "sourceTree":tree,
        "baseImageManifest":"docker.io/library/ubuntu@"+OCI_AMD64,
        "nativePackageLockSha256":digest(lock),
        "nativeCompilerSha256":digest(path),
        "installedDpkgGraphSha256":hashlib.sha256(package_graph).hexdigest(),
        "installedDpkgCount":len(pkgdata.splitlines()),
        "limitations":"transitive apt package bytes and mutable apt repositories are not fixed"
    }
    out=Path(sys.argv[3])
    out.mkdir(parents=True,exist_ok=True)
    (out/f"oci-{replica}.json").write_text(json.dumps(obj,indent=2,sort_keys=True)+"\n")
    (out/f"packages-{replica}.txt").write_bytes(package_graph)
    print("OCI_NATIVE_COMPILER_SHA256",obj["nativeCompilerSha256"])
    print("OCI_BASE_IMAGE_SHA256",OCI_AMD64)
    print("OCI_SOURCE_GIT_TREE",tree)
    print("OCI_INSTALLED_PACKAGE_GRAPH_SHA256",obj["installedDpkgGraphSha256"])

if __name__=="__main__":
    main()
