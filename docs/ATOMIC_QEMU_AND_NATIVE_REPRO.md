# Native build and QEMU release-durability qualification

This document describes **experimental qualification gates** for the
opt-in core Wasm atomic publication path. A passing CI status is not a
production release authorization.

## Independent native compiler and Wasm reproducibility

`.github/workflows/native-reproducibility.yml` runs **two distinct hosted
runner jobs**, each independently installing the exact direct Ubuntu
build-package versions from `contracts/native-toolchain-ubuntu2404.lock.json`.
Each runner builds the real vendored LLVM Oreslang compiler from the
same Git tree, compiles two real `.ores` fixtures, verifies and runs the
sealed core Wasm guests, and uploads a content-based receipt.

A third job downloads both receipts and requires byte-identical native
compiler SHA-256s, Wasm SHA-256s, seal/release identities, package versions,
and exact source-tree IDs. A missing receipt, changed package list,
incorrect identity, or mismatched bytes rejects the gate.

The same workflow also runs **two independent OCI builds** from an
explicitly pinned Ubuntu 24.04 linux/amd64 OCI *manifest digest*:

`docker.io/library/ubuntu@sha256:f610ab94648195aa356059f5b41d6085c9d4d903c072430cdd1af7bdb646106b`

The two builds use the exact direct package-version lock, additional
development prerequisites, and compile the exact mounted source. They
independently upload the native compiler digest and a SHA-256-bound,
sorted **full installed Debian package graph**. A separate job validates
both inventories and rejects any compiler or transitive-graph divergence.

**Important distinction:** an OCI base pinned by immutable SHA-256 is
not a fully hermetic toolchain if `apt-get update` still reads mutable
repositories. All exact direct apt package versions are enforced, and
the complete transitive set is observed and compared independently;
transitive package bytes are **not** themselves fetched from an
immutable repository snapshot. Independent host-worker and OCI-worker
executables can legitimately differ in bytes if the base images install
different compiler/linker development libraries; equality is required
within each explicitly controlled environment, not blindly between
unlike host environments.

## QEMU ext4 unclean VM termination and cold-boot testing

`.github/workflows/qemu-powercut.yml` runs on Ubuntu 24.04 with
a fixed guest kernel package version, logs the actual guest kernel,
initramfs, and QEMU executable SHA-256s, and installs the pinned
Clang/LLD fixture toolchain. It creates **five disposable ext4 raw
disk images**, each initialized with one genuine verified core Wasm
release. No persistent application data or external block devices
are touched.

For each disk image the harness:

1. boots Ubuntu Linux under QEMU TCG with virtio-blk,
   `cache=writeback` and ext4 ordered journaling;
2. runs the actual `publishAtomicRelease()` JavaScript API in the guest;
3. waits for a known synchronization checkpoint printed by the guest;
4. abruptly sends **SIGKILL to the QEMU hypervisor process**, not a
   graceful guest shutdown or a signal to the Node publisher;
5. boots the *same* virtual block-image in a fresh QEMU process;
6. runs `readAtomicRelease()`, actually executes the selected Wasm i64
   guest, and verifies the selection and recovery inventory.

The five checkpoints are after the release-directory rename but before
release-root `fsync`, after release-root `fsync`, after temporary-pointer
`fsync` but before the pointer rename, after pointer rename before
pointer-parent `fsync`, and after the final durable commit but before
temporary cleanup. All checked identities must be verified and
complete. At a checkpoint before the pointer rename the old complete
release stays selected. After pointer rename without a confirmed parent
`fsync`, the model accepts either verified old or new complete
release; it never assumes durable completion solely because a rename
became visible.

The guest fixture is generated from actual Clang-emitted core Wasm
with matching manifest and provenance. **This QEMU gate tests the
publication filesystem protocol, not the full Oreslang compiler
frontend**. Full real `.ores` compiler integration is separately
covered by the native LLVM and independent-rebuild workflows.

### Audited recovery receipt requirements

A serial marker printed by the guest verifier is **not** by itself a
successful cold-boot result. The host now drains the guest serial
output until actual QEMU process termination and rejects abnormal
QEMU exit status, any `GUEST_PROCESS_ERROR`, a missing or repeated
`GUEST_PROCESS_CLEAN_FINISH`, a missing or repeated matching recovery
marker, and wrong-checkpoint text. A separate stdlib-only regression
suite exercises these false-positive cases before launching the slow
VM matrix.

The fixture now derives the **exact SHA-256 release identity** of
both known i64 guests from their canonical seals. Cold-boot checking
rejects a complete but unrelated guest artifact even when its
exported i64 result happens to match 42 or 43. The workflow also
validates all five checkpoint identities and the complete Git source
tree inside the saved evidence JSON before considering the gate
successful.

The script writes `build/qemu-powercut-evidence.json` with complete
source-tree identity, kernel/initramfs/QEMU hashes, fault checkpoints,
and cold-boot counts. The CI artifact is retained for 30 days.

## Limitations and unfulfilled production gates

- Abrupt killing of an emulated VM is a meaningful unclean-guest
  shutdown test; it is **not** a real host/server power supply failure,
  controller write-cache loss, or physically cut storage power.
- These bounded, deterministic checkpoints do not model every
  scheduler or filesystem interleaving, multi-writer linearization
  across actual machines, hostile writable filesystem principals,
  cross-filesystem rename, or automatic reader-aware garbage collection.
- The QEMU guest kernel package version is fixed for this CI, but
  the generated initramfs can vary with host image contents; the exact
  resulting bytes are therefore hashed into each run's receipt.
- Native source and action identities are pinned, but fully immutable
  transitive apt and Linux runtime bytes require an immutable package
  snapshot (or published digest-pinned builder) and independent review.
- Merge remains blocked until [release governance issue #23](https://github.com/ores-truffle-oreslang/oreslang-wasm/issues/23)
  is resolved. Further cold-recovery scope remains in
  [qualification issue #27](https://github.com/ores-truffle-oreslang/oreslang-wasm/issues/27).

Keep atomic publication opt-in and automatic release garbage collection
disabled until separate reader-pin safety and governance gates are met.

## Experimental two-/three-publisher crash matrix

`.github/workflows/qemu-multiwriter.yml` checks two scenarios against new
disposable, ext4-backed QEMU guests. The real JavaScript atomic publication
API is invoked by distinct *concurrent operations inside the same guest
process*; this does not yet establish independent-process or networked-host
multi-writer safety.

The tests first publish a verified baseline i64 42 release, and compile
additional canonical sealed releases i64 43, 44 and 45. Synchronization hooks
force two or three overlapping publishers to reach the genuine
post-release-fsync, pre-pointer-rename boundary before the first publisher
is permitted to finish a durable i64 43 pointer commit.

In `multi2`, publisher 44 remains paused before pointer rename while the
first publisher commits 43; the hypervisor is killed at that boundary.
Cold boot must find the exact committed i64 43 release and a complete,
unreferenced 44 release. In `multi3`, publisher 44 is still paused, and
publisher 45 has renamed the pointer but has not confirmed its directory
fsync. Abrupt hypervisor termination followed by cold boot must recover
either the exact, fully committed 43 or the exact, complete 45 release.
It must never expose 42, the incomplete publisher 44, or an unrecognized
artifact. Each guest executes its recovered Wasm and hashes its source
artifact and canonical seal identity.

The two-writer and three-writer cases are bounded deterministic schedules,
not a proof of all possible publisher interleavings. The single-publisher
five-checkpoint matrix still runs independently.

## Reader-safe retirement safety model (no runtime GC)

`formal/AtomicReaderRetention.tla` models pin acquisition as one atomic
admission action synchronized with retirement, marks identities retired
before reclamation, requires all persistent reader pins to drain, and
conservatively retains pins across crashes/recovery. TLC checks three
possible releases and two readers, plus a mandatory unsafe reclamation
negative control which must violate `PinnedPresent`.

This establishes safety of the **specified bounded state machine** only.
There is no runtime persistent pin store, owner-fencing mechanism, or
automatic collector in this PR. A runtime implementation needs authenticated
reader identity, durable pin grant and release, crash recovery, ownership
fencing, atomic admission relative to retirement, and adversarial tests.
Do not infer a working garbage collector from the model. Leave automatic
release GC disabled and retain orphan releases until separately qualified.
