import "@typespec/json-schema";
using TypeSpec.JsonSchema;

// Source-language contract companion to schemas/atomic-release-v1.schema.json.
// SHA-256 regex and byte bounds remain enforced by runtime and JSON Schema.
// This file is an interface declaration; the emitted JSON Schema is checked
// separately for conformance and never replaces byte-level Wasm admission.
@jsonSchema
namespace Oreslang.AtomicRelease;

@doc("Lowercase SHA-256 digest of exact bytes")
@pattern("^[0-9a-f]{64}$")
scalar Sha256 extends string;

@jsonSchema
model CurrentPointer {
  schemaVersion: 1;
  releaseSha256: Sha256;
}

model FileDigests {
  wasm: Sha256;
  manifest: Sha256 | null;
  provenance: Sha256;
}

@jsonSchema
model ReleaseSeal {
  schemaVersion: 1;
  type: "oreslang.atomic-release-v1";
  fileHashes: FileDigests;
}

model ProducerIdentity {
  compilerSha256: Sha256;
  sourceSha256: Sha256;
  llvmIrSha256: Sha256;
}

model CoreMemory {
  maximumPages: 2;
}

@jsonSchema
model CoreWasmManifest {
  schemaVersion: 1;
  artifactType: "oreslang.core-wasm.i64-v1";
  target: "wasm32";
  environment: "browser" | "edge-js" | "edge-wasi";
  backend: "wasm";
  @pattern("^[A-Za-z_][A-Za-z0-9_]*$")
  @maxLength(128)
  entry: string;
  wasmSha256: Sha256;
  @minValue(8)
  @maxValue(16777216)
  wasmBytes: int32;
  @maxItems(0)
  imports: [];
  @maxItems(0)
  requiredCapabilities: [];
  memory: CoreMemory;
  producer: ProducerIdentity;
}

@jsonSchema
model CompilerProvenance {
  schemaVersion: 1;
  kind: "llvm-ores-to-wasm32-core-experimental";
  compilerSha256: Sha256;
  sourceSha256: Sha256;
  llvmIrSha256: Sha256;
  wasmSha256: Sha256;
  @pattern("^[A-Za-z_][A-Za-z0-9_]*$")
  exportName: string;
  @minValue(8)
  @maxValue(16777216)
  wasmBytes: int32;
  importCount: 0;
  @minLength(1)
  @maxLength(256)
  clangVersion: string;
  @maxLength(1024)
  note: string;
}
