## Exact-byte compiler and source admission

The standalone `.ores` bridge must compile and execute **the bytes it hashes**.
`sourceSha256` names the staged source snapshot, not a mutable caller-owned
pathname. `compilerSha256` names the staged executable actually invoked,
not merely an executable read earlier before running a different path.

The bridge writes both verified inputs into a freshly-created private scratch
directory. It executes the staged compiler with the staged source path, then
checks both still match their original hashes before publishing metadata or
Wasm. A compiler that mutates its original path does not change the executable
that was launched. A compiler that modifies its staged inputs is rejected.
The artifact sidecars are published before the Wasm binary, and consumers
must check their SHA-256 identities because separate filesystem renames are
not a single atomic transaction.

This guard only proves byte identity for **standalone source and executable
files**. It is not a general sandbox or signed source-to-binary attestation.
Native dynamic libraries, compiler plugins, subprocesses, relative imports,
script dependencies, external toolchains, and environment variables are not
included in the compiler-byte hash. Production module-graph closure and
toolchain attestation require separate policy. The staged executable must be
self-contained or have explicitly verified external dependencies.

Run the adversarial source mutation, executable snapshot, staged mutation,
output-path alias, sidecar publication, real Clang, and full package tests
before merge.
