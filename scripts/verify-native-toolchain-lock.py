#!/usr/bin/env python3
"""Validate direct Ubuntu 24.04 build dependencies against an exact version lock.

The lock covers only listed direct apt packages. It neither snapshots an APT
repository nor freezes transitive .deb dependencies or the GitHub runner image.
"""
import hashlib
import json
import pathlib
import platform
import re
import subprocess
import sys

LOCK=pathlib.Path(__file__).resolve().parent.parent/"contracts/native-toolchain-ubuntu2404.lock.json"
EXPECTED={"build-essential","cmake","clang","lld","llvm-dev"}

def locked():
    raw=LOCK.read_bytes()
    obj=json.loads(raw)
    if set(obj)!={"schemaVersion","kind","runner","architecture","packages","note"}:
        raise SystemExit("invalid native apt lock fields")
    if obj["schemaVersion"]!=1 or obj["kind"]!="oreslang.native-wasm-ubuntu-2404-direct-packages-v1":
        raise SystemExit("unexpected native toolchain lock schema")
    if obj["runner"]!="ubuntu-24.04" or obj["architecture"]!="amd64":
        raise SystemExit("unsupported native toolchain lock host")
    if set(obj["packages"])!=EXPECTED:
        raise SystemExit("incorrect native apt lock package set")
    for name, version in obj["packages"].items():
        if not re.fullmatch(r"[a-z0-9-]+",name) or not re.fullmatch(r"[0-9A-Za-z.:+~_-]+",version):
            raise SystemExit("invalid native apt lock value")
    return obj,hashlib.sha256(raw).hexdigest()

def main():
    if len(sys.argv)!=2 or sys.argv[1] not in ("install-args","verify"):
        raise SystemExit("usage: verify-native-toolchain-lock.py install-args|verify")
    obj,digest=locked()
    if sys.argv[1]=="install-args":
        print(" ".join(name+"="+version for name,version in sorted(obj["packages"].items())))
        return
    if platform.system()!="Linux" or platform.machine() not in ("x86_64","amd64"):
        raise SystemExit("native lock requires Linux amd64")
    ubuntu=subprocess.check_output(["lsb_release","-rs"],text=True).strip()
    if ubuntu!="24.04":
        raise SystemExit("native lock requires Ubuntu 24.04")
    found={}
    for name, expected in sorted(obj["packages"].items()):
        actual=subprocess.check_output([
            "dpkg-query","-W","-f=${Version}",name
        ],text=True).strip()
        if actual!=expected:
            raise SystemExit(f"native toolchain package drift: {name}: {actual!r} != {expected!r}")
        found[name]=actual
    print("NATIVE_DIRECT_APT_VERSION_LOCK_OK "+digest)
    print("NATIVE_DIRECT_APT_PACKAGE_VERSIONS "+json.dumps(found,sort_keys=True))

if __name__=="__main__":
    main()
