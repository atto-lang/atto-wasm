#!/usr/bin/env python3
"""Validate actual Node-generated atomic release records and negative cases."""
import copy
import json
import pathlib
import sys

from jsonschema import Draft202012Validator

root = pathlib.Path(__file__).resolve().parent.parent
samples = pathlib.Path(sys.argv[1])
schema = json.loads((root / "schemas/atomic-release-v1.schema.json").read_text())
Draft202012Validator.check_schema(schema)

def validator(kind):
    resolved = {
        "$schema": schema["$schema"], "$defs": schema["$defs"],
        "$ref": "#/$defs/" + kind,
    }
    return Draft202012Validator(resolved)

records = {}
for kind in ("Pointer", "Seal", "Manifest", "Provenance"):
    record = json.loads((samples / (kind + ".json")).read_text())
    validator(kind).validate(record)
    records[kind] = record

pointer, seal = records["Pointer"], records["Seal"]
manifest, provenance = records["Manifest"], records["Provenance"]
assert manifest["producer"]["compilerSha256"] == provenance["compilerSha256"]
assert manifest["producer"]["sourceSha256"] == provenance["sourceSha256"]
assert manifest["producer"]["llvmIrSha256"] == provenance["llvmIrSha256"]
assert manifest["wasmSha256"] == provenance["wasmSha256"]
assert seal["fileHashes"]["wasm"] == manifest["wasmSha256"]
assert pointer["releaseSha256"] != "0" * 64

negative = [
    ("Pointer", {"releaseSha256": "UPPERCASE-INVALID"}),
    ("Pointer", {"unexpected": True}),
    ("Seal", {"fileHashes": {**seal["fileHashes"], "wasm": "invalid"}}),
    ("Manifest", {"memory": {"maximumPages": 3}}),
    ("Manifest", {"requiredCapabilities": ["network"]}),
    ("Manifest", {"imports": [{"module": "env"}]}),
    ("Provenance", {"importCount": 1}),
    ("Provenance", {"wasmSha256": "0"}),
]
for kind, mutation in negative:
    invalid = copy.deepcopy(records[kind])
    invalid.update(mutation)
    if validator(kind).is_valid(invalid):
        raise SystemExit(f"negative JSON Schema contract unexpectedly accepted: {kind} / {mutation}")

print("PASS 4 runtime-generated atomic release JSON records, 8 negative schema cases")
