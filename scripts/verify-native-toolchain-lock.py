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

def reject_duplicate_keys(pairs):
    result={}
    for key,value in pairs:
        if key in result:
            raise ValueError("duplicate native apt lock JSON key: "+key)
        result[key]=value
    return result

def reject_json_constant(value):
    raise ValueError("non-JSON numeric constant in native apt lock: "+value)

def locked():
    raw=LOCK.read_bytes()
    try:
        obj=json.loads(raw,object_pairs_hook=reject_duplicate_keys,
                       parse_constant=reject_json_constant)
    except (ValueError,UnicodeDecodeError) as failure:
        raise SystemExit("invalid or ambiguous native apt lock JSON") from failure
    if type(obj) is not dict or set(obj)!={"schemaVersion","kind","runner","architecture","packages","note"}:
        raise SystemExit("invalid native apt lock fields")
    # In Python True == 1 and 1.0 == 1; neither is a JSON integer version.
    if type(obj["schemaVersion"]) is not int or obj["schemaVersion"]!=1 or obj["kind"]!="oreslang.native-wasm-ubuntu-2404-direct-packages-v1":
        raise SystemExit("unexpected native toolchain lock schema")
    if obj["runner"]!="ubuntu-24.04" or obj["architecture"]!="amd64":
        raise SystemExit("unsupported native toolchain lock host")
    if type(obj["packages"]) is not dict or set(obj["packages"])!=EXPECTED:
        raise SystemExit("incorrect native apt lock package set")
    if not isinstance(obj["note"],str) or not 1<=len(obj["note"])<=1024 or chr(0) in obj["note"]:
        raise SystemExit("invalid native apt lock note")
    for name, version in obj["packages"].items():
        if not re.fullmatch(r"[a-z0-9-]+",name) or not re.fullmatch(r"[0-9A-Za-z.:+~_-]+",version):
            raise SystemExit("invalid native apt lock value")
    return obj,hashlib.sha256(raw).hexdigest()

def main():
    if len(sys.argv)<2 or sys.argv[1] not in ("install-args","verify"):
        raise SystemExit("usage: verify-native-toolchain-lock.py install-args|verify [package ...]")
    obj,digest=locked()
    requested=sys.argv[2:] or sorted(obj["packages"])
    if len(set(requested))!=len(requested) or not set(requested).issubset(EXPECTED):
        raise SystemExit("unknown or duplicate native package name")
    if sys.argv[1]=="install-args":
        print(" ".join(name+"="+obj["packages"][name] for name in sorted(requested)))
        return
    if platform.system()!="Linux" or platform.machine() not in ("x86_64","amd64"):
        raise SystemExit("native lock requires Linux amd64")
    ubuntu=subprocess.check_output(["lsb_release","-rs"],text=True).strip()
    if ubuntu!="24.04":
        raise SystemExit("native lock requires Ubuntu 24.04")
    found={}
    for name in sorted(requested):
        expected=obj["packages"][name]
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
