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

# Differential conformance: the TypeSpec emitter must produce schemas with
# the same accept/reject behavior as the normative JSON Schema. This checks
# generated schema *semantics*, not merely a successful TypeSpec compilation.
if len(sys.argv) > 2:
    generated = pathlib.Path(sys.argv[2])
    bundles = []
    for filename in generated.rglob("*.json"):
        try:
            doc = json.loads(filename.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(doc, dict) and isinstance(doc.get("$defs"), dict):
            bundles.append((filename, doc))
    expected_models = {
        "Pointer": "CurrentPointer", "Seal": "ReleaseSeal",
        "Manifest": "CoreWasmManifest", "Provenance": "CompilerProvenance"
    }
    generated_validators = {}
    bundle_file = None
    if bundles:
        def find_models(bundle):
            defs = bundle["$defs"]
            mapping = {}
            for kind, suffix in expected_models.items():
                found = [name for name in defs if name.split(".")[-1] == suffix]
                if len(found) != 1:
                    return None
                mapping[kind] = found[0]
            return mapping
        matches = [(path, doc, find_models(doc)) for path, doc in bundles]
        matches = [(p, d, mapping) for p, d, mapping in matches if mapping is not None]
        if len(matches) != 1:
            raise SystemExit("expected one TypeSpec bundle with four release models")
        bundle_file, bundle, names = matches[0]
        for kind, name in names.items():
            doc = copy.deepcopy(bundle)
            doc["$ref"] = "#/$defs/" + name.replace("~", "~0").replace("/", "~1")
            generated_validators[kind] = Draft202012Validator(doc)
    else:
        # TypeSpec 1.4 emits one schema per named model unless bundling is
        # configured. Resolve refs only against the emitted local model files:
        # never download a remote $ref while performing CI validation.
        from referencing import Registry, Resource
        docs = {}
        registry = Registry()
        files = sorted(generated.rglob("*.json"))
        for path in files:
            doc = json.loads(path.read_text())
            if not isinstance(doc, dict):
                raise SystemExit(f"unexpected emitted schema payload: {path}")
            normalized = copy.deepcopy(doc)
            normalized["$id"] = "https://oreslang.dev/generated/" + path.name
            docs[path.name] = normalized
            registry = registry.with_resource(normalized["$id"],
                                              Resource.from_contents(normalized))
        for kind, model in expected_models.items():
            name = model + ".json"
            if name not in docs:
                raise SystemExit(f"TypeSpec emitted schema missing {name}; files={sorted(docs)}")
            generated_validators[kind] = Draft202012Validator(docs[name],
                                                               registry=registry)
        bundle_file = f"{len(docs)} emitted separate JSON Schema files"

    checks = []
    def case(kind, label, value):
        checks.append((kind, label, copy.deepcopy(value)))

    for kind, original in records.items():
        case(kind, "valid generated fixture", original)
        for field in original:
            mutated = copy.deepcopy(original)
            del mutated[field]
            case(kind, "missing required " + field, mutated)
        case(kind, "unexpected root field", {**original, "unexpectedAuthority": True})

    for kind, nested in (
        ("Seal", "fileHashes"),
        ("Manifest", "memory"),
        ("Manifest", "producer"),
    ):
        mutated = copy.deepcopy(records[kind])
        mutated[nested]["unexpectedAuthority"] = True
        case(kind, "unexpected nested field " + nested, mutated)

    for kind, mutation in negative:
        case(kind, "negative structural mutation", {**records[kind], **mutation})

    for kind, field, values in (
        ("Manifest", "entry", ["main", "_x", "a"*128, "a"*129, "bad-name", ""]),
        ("Manifest", "wasmBytes", [7, 8, 16777216, 16777217, 1.5, True]),
        ("Provenance", "wasmBytes", [7, 8, 16777216, 16777217, -1, True]),
        ("Provenance", "exportName", ["main", "_x", "bad-name", ""]),
        ("Provenance", "clangVersion", ["", "x", "x"*256, "x"*257,
                                         "\U0001F642"*256, "\U0001F642"*257]),
        ("Provenance", "note", ["", "x"*1024, "x"*1025,
                                "\U0001F642"*1024, "\U0001F642"*1025]),
        ("Pointer", "releaseSha256", ["a"*64, "A"*64, "a"*63, "a"*65, 7]),
    ):
        for value in values:
            candidate = copy.deepcopy(records[kind])
            candidate[field] = value
            case(kind, "boundary " + field, candidate)

    agree, accept, reject = 0, 0, 0
    for kind, label, value in checks:
        normative = validator(kind).is_valid(value)
        generated = generated_validators[kind].is_valid(value)
        if normative != generated:
            raise SystemExit("TypeSpec parity failure: " + kind + "/" + label +
                             " normative=" + str(normative) + " emitted=" + str(generated) +
                             " sample=" + repr(value)[:700])
        agree += 1
        if normative:
            accept += 1
        else:
            reject += 1
    print(f"PASS TypeSpec-generated JSON Schema semantic parity: "
          f"{agree} cases ({accept} accepted, {reject} rejected) in {bundle_file}")
