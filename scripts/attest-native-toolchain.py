#!/usr/bin/env python3
"""Audit evidence for a completed native LLVM -> atomic Wasm CI build.

This is a *run attestation* of the tools and files actually used, not a
reproducible-build proof or a cryptographic signature. Never serialize CI
environment variables, credentials, home directories or full machine paths.
"""
import hashlib
import json
import pathlib
import platform
import subprocess
import sys


def cmd(*parts):
    return subprocess.check_output(parts, text=True, stderr=subprocess.STDOUT).strip()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package(name):
    return cmd("dpkg-query", "-W", "-f=${binary:Package}=${Version}", name)


def tool(name, location):
    binary = pathlib.Path(location).resolve(strict=True)
    return {
        "name": name,
        "sha256": sha256_file(binary),
        "version": cmd(str(binary), "--version").splitlines()[0][:240],
    }


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: attest-native-toolchain.py COMPILER OUTPUT")
    compiler_path, output = sys.argv[1:]
    root = pathlib.Path(__file__).resolve().parent.parent
    if pathlib.Path.cwd().resolve() != root:
        raise SystemExit("attestation must run at repository root")
    commit = cmd("git", "rev-parse", "HEAD")
    tree = cmd("git", "rev-parse", "HEAD^{tree}")
    index = cmd("git", "write-tree")
    if tree != index or cmd("git", "diff", "--name-only", "HEAD", "--"):
        raise SystemExit("tracked checkout changed during compilation")

    compiler = pathlib.Path(compiler_path).resolve(strict=True)
    package_names = ["build-essential", "cmake", "clang", "lld", "llvm-dev"]
    lock_path = root / "contracts/native-toolchain-ubuntu2404.lock.json"
    package_lock = json.loads(lock_path.read_bytes())
    pinned = package_lock["packages"]
    if set(pinned) != set(package_names):
        raise SystemExit("attested native package lock does not match audited package set")
    actual_packages = {name: package(name) for name in package_names}
    for name in package_names:
        if actual_packages[name].split("=", 1)[1] != pinned[name]:
            raise SystemExit("native package mismatch before attestation: "+name)
    # Capture the complete installed Debian package graph as a SHA-bound
    # observation. Direct package pins alone do NOT freeze their transitives.
    dpkg_snapshot = cmd("dpkg-query", "-W", "-f=${binary:Package}=${Version}\\n")
    dpkg_bytes = ("\\n".join(sorted(dpkg_snapshot.splitlines())) + "\\n").encode()
    pointer_records = []
    for expected in (42, 43):
        prefix = pathlib.Path("build") / f"real-{expected}.wasm"
        with open(str(prefix) + ".current.json", "rb") as stream:
            pointer_bytes = stream.read()
        pointer = json.loads(pointer_bytes)
        release = pointer["releaseSha256"]
        if pointer_bytes != (json.dumps(pointer, separators=(",", ":")) + "\n").encode():
            raise SystemExit(f"noncanonical atomic pointer: {expected}")
        sealed_dir = pathlib.Path(str(prefix) + ".releases") / release
        if not sealed_dir.is_dir() or not (sealed_dir / "seal.json").is_file():
            raise SystemExit(f"missing sealed native guest: {expected}")
        pointer_records.append({
            "expectedI64": expected,
            "releaseSha256": release,
            "wasmSha256": sha256_file(sealed_dir / "guest.wasm"),
            "sealSha256": sha256_file(sealed_dir / "seal.json"),
        })
    data = {
        "schemaVersion": 1,
        "kind": "oreslang.native-wasm-ci-toolchain-observation-v1",
        "source": {"commit": commit, "tree": tree},
        "runner": {
            "architecture": platform.machine(),
            "os": "linux",
            "release": platform.release(),
            "ubuntuRelease": cmd("lsb_release", "-rs"),
        },
        "packages": actual_packages,
        "nativePackageLockSha256": sha256_file(lock_path),
        "installedDpkgPackageCount": len(dpkg_snapshot.splitlines()),
        "installedDpkgGraphSha256": hashlib.sha256(dpkg_bytes).hexdigest(),
        "tools": {
            "clang": tool("clang", "/usr/bin/clang"),
            "cmake": tool("cmake", "/usr/bin/cmake"),
            "nativeCompiler": {
                "sha256": sha256_file(compiler),
                "gitPinnedSourceTree": tree,
            },
            "nodeVersion": cmd("node", "--version"),
        },
        "releases": pointer_records,
    }
    target = pathlib.Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    encoded = (json.dumps(data, sort_keys=True, separators=(",", ":")) + "\n").encode()
    target.write_bytes(encoded)
    target.with_name("native-installed-packages.txt").write_bytes(dpkg_bytes)
    print("NATIVE_TOOLCHAIN_ATTESTATION_SHA256=" + hashlib.sha256(encoded).hexdigest())
    print("NATIVE_TOOLCHAIN_SOURCE_TREE=" + tree)
    print("NATIVE_TOOLCHAIN_COMPILER_SHA256=" + data["tools"]["nativeCompiler"]["sha256"])
    print("NATIVE_TOOLCHAIN_PACKAGES=" + json.dumps(data["packages"], sort_keys=True))


if __name__ == "__main__":
    main()
