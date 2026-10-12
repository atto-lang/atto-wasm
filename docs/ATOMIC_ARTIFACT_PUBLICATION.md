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
  Cooperating compiler processes acquire an exclusive per-output
  `<output>.publication.lock` and repeat their mixed-mode check immediately
  before publication. A crashed process may leave this directory: publishing
  then fails closed; cleanup must be operator-controlled after verifying no
  active publisher. This does not coordinate arbitrary untrusted filesystem
  writers who ignore the lock.
- The legacy layout remains available for existing callers and tests and
  **does not** have atomic bundle semantics. Production readers requiring
  atomicity must explicitly opt in and use the verified reader; a future
  breaking release can remove legacy publication.
- Durability now uses synchronous file writes with file `fsync`, a staged
  directory `fsync`, a release-root `fsync` after the sealed-directory
  rename, and destination-parent `fsync` after atomically replacing the
  current pointer. A successful publication return has crossed these Linux/
  POSIX filesystem synchronization barriers. On storage without reliable
  directory `fsync`, this implementation fails rather than promising a
  durable commit. Hardware controllers, filesystem bugs, or an actual
  power interruption are *not* modeled by ordinary unit tests.
- The current implementation assumes a private, trusted same-filesystem
  directory, and cannot guarantee integrity against writable storage,
  malicious processes with access to the release tree, filesystem corruption
  or SHA-256 collisions. A process crash may leave an unreferenced sealed
  directory or partial staging tree.
- `inspectAtomicReleaseState(output)` reports the current verified release,
  stale staging directories, older independently verified releases and
  invalid entries without modifying storage. These diagnostics support
  explicit operator recovery. **There is no automated garbage collector**:
  old versions may be pinned by live readers and must not be deleted without
  a quiescence or reader-lease protocol.
- Contracts are recorded in `schemas/atomic-release-v1.schema.json` and
  `contracts/atomic-release.tsp`. The contract workflow compiles TypeSpec,
  validates four actual compiler-produced JSON records and checks deliberate
  invalid examples. Cross-file cryptographic equality and executable Wasm ABI
  are always checked by the verified reader, not by JSON Schema alone.
- `.github/workflows/native-llvm-atomic.yml` vendors and SHA-verifies the
  minimal exact upstream LLVM compiler build inputs, compiles two genuine
  Oreslang programs without cross-repository credentials and validates their
  atomic releases. Browser Workers are covered separately by the funded
  browser integration gate until originating Actions and reviews are restored.
- `chmod` is defense in depth against accidental modification, not an
  immutable file attribute. Readers recompute every hash.
- The bounded TLA+ `formal/AtomicRelease.tla` models two competing writers,
  verification, installation, abort, and atomic pointer publication. Its
  unsafe mode must produce a NoPartialPointer counterexample. TLC model
  checking is not a machine-checked proof of the JavaScript implementation.
