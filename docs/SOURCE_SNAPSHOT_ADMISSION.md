## Source byte-identity gate

The experimental standalone .ores bridge must compile a fresh private scratch copy of source bytes already hashed for the artifact's `producer.sourceSha256`. Previously the bridge hashed the original pathname and then invoked `oreslang-llvmc` using that pathname, leaving a filesystem TOCTOU race. Source renames or edits during compiler execution must no longer invalidate its provenance claim.

This v1 path supports standalone source only. Graph imports, compiler-executable provenance, and separately linked native dependencies require independent exact-tree validation; a scratch snapshot is **not** signed source-to-binary attestation. This policy does not make the compiler executable immutable. Run the included mutation-race regression plus actual native compiler fixture checks before merge.
