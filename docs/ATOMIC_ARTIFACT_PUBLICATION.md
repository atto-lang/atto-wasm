# Atomic core-Wasm artifact publication (experimental)

The former per-file `guest.wasm`, `guest.wasm.artifact.json`, and
`guest.wasm.provenance.json` protocol cannot atomically publish a bundle.
The new **opt-in** `--publication=atomic` path publishes a validated
content-addressed release directory and replaces only one current pointer.

```sh
node scripts/compile-ores.mjs --compiler=/absolute/oreslang-llvmc \
  --source=/absolute/main.ores --output=/absolute/guest.wasm \
  --environment=browser --publication=atomic
```

The release is at `guest.wasm.releases/<64-hex-release-id>/` with
`guest.wasm`, `provenance.json`, optional `artifact.json`, and
`seal.json`. After checks, a single same-filesystem rename publishes
`guest.wasm.current.json` with one immutable release identity. Readers
must call `readAtomicRelease(output)` from
`scripts/atomic-release.mjs`, which snapshots the pointer once, validates
its bounded schema, reads all regular files, verifies content-addressed
hashes, and checks the manifest/provenance consistency before returning
guest bytes. They must not infer readiness from the presence of individual
sidecar files.

A failed or cancelled compilation before publication never advances the
pointer. Independent concurrent publishers may race to advance the pointer;
readers will observe a *complete validated* release from one publisher,
not a combination of their files. Older sealed releases remain readable;
garbage collection requires a separate quiescence-aware design.

## Security / migration limits

- One output path cannot contain both protocols. Atomic publication refuses an
  existing legacy .wasm/sidecar layout; legacy publication refuses an existing
  .current.json pointer or .releases directory. Migrate to a new output
  pathname (or perform an explicit quiesced migration), never silently mix.
- The legacy layout remains available for existing callers and tests and
  **does not** have atomic bundle semantics. Production readers requiring
  atomicity must explicitly opt in and use the verified reader; a future
  breaking release can remove legacy publication.
- The current implementation uses a private, trusted same-filesystem release
  directory. It is not tamperproof against a user who has write permissions
  inside that directory, filesystem corruption, malicious storage, or
  cryptographic hash collisions. No `fsync` durability across power failure
  is claimed. A process crash may leave an unreferenced sealed directory.
- `chmod` is defense in depth against accidental modification, not an
  immutable file attribute. Readers recompute every hash.
- The bounded TLA+ `formal/AtomicRelease.tla` models two competing writers,
  verification, installation, abort, and atomic pointer publication. Its
  unsafe mode must produce a NoPartialPointer counterexample. TLC model
  checking is not a machine-checked proof of the JavaScript implementation.
