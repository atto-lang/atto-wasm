# Reader pins, retention and multi-publisher cold-boot qualification

## Current status and non-goals

Automatic release garbage collection remains **disabled**. The atomic
publisher supports last-writer-wins atomic pointer replacement, not
compare-and-swap publication, transactions spanning multiple output paths,
or remote consensus. No reader-lease API has been deployed.

The `RetentionLeases.tla` model is a **proposed protocol**, not proof that
the existing JavaScript runtime implements it. It uses three candidate
releases and two readers. `AcquireReader` denotes one linearizable
operation that simultaneously selects the current release and obtains
its reclamation-protecting pin from the same authority used by GC.
A client that first reads a pointer and then independently writes a pin
has an unsafe read-versus-collect race; that sequence is forbidden.

Each pin has `free`, `live` and `suspect` states. Unexpected reader
death/disconnection transitions `live` to `suspect` without releasing
its reference. A timeout **is not** evidence of safe death. Retention can
remove a non-current release only after all pins to it are cleared by
their holders or cleared following a separately verified fencing/epoch
protocol. `FencedReaderDeath` is an *assumed authority transition*,
not an implemented fencing service. Until an operational protocol can
prove termination and prevent stale readers from resuming, **do not
enable GC**. An unsafe negative-control TLC model deliberately
reclaims a suspect reader's release and must violate `PinnedPresent`.

### Additional retire-before-reclaim admission model

`formal/AtomicReaderRetention.tla` independently models a two-phase
reclamation protocol, complementing the lease-fencing model above.
`PinCurrent` acquires a pin using the same atomic admission authority as
`Retire`; once retirement is marked, new readers cannot pin that
release. `Reclaim` may then remove it only after every earlier pin has
been released. Pins remain conservatively held across process crash and
restart. A negative-control `UnsafeReclaim` transition must violate
`PinnedPresent` whenever it deletes a retired release held by a reader.

The two bounded TLA+ models have different purposes: `RetentionLeases`
specifies **reader identity, suspect leases and externally authorized
fencing**; `AtomicReaderRetention` specifies **atomic read admission
relative to retirement and reclamation**. Neither implements a live
collector, resolves owner-fencing liveness, or allows automatic GC to be
enabled. Both models must remain green with their unsafe negative
controls before a future runtime pin/GC implementation can be accepted.

A complete future implementation would require authenticated
process-instance identifiers, monotonic epochs/fencing tokens, durable
lease authorization, restart reconciliation, explicit cancellation
handoffs, cap/retention budgets, crash/expiry tests, and a
concurrency-linearizable pin acquisition/collection lock or
transaction boundary. Merely keeping an in-memory reference count or
writing pins after reading the current pointer is insufficient.

## Competing publishers in QEMU

The existing five single-publisher QEMU failure boundaries remain.
`qemu-powercut-harness.py` now additionally tests two writer groups:

- `multi2`: writer 43 pauses **after renaming** its pointer; independent
  writer process 44 then completes the real durable pointer fsync.
- `multi3`: writer 43 pauses at the same point; independent writer
  processes 44 and 45 complete in sequence while 43 remains stalled.

All writer processes have distinct host-guest process identities and
share the *same* ext4 release root and pointer. The parent emits the
power-cut marker only after the final writer has returned a verified
completion receipt; the host then kills **QEMU itself**, not individual
publishers. After a cold boot from the same disk, the verified reader
must select the exact sealed identity and Wasm SHA-256 of the last
successfully durable publisher. The recovery inventory must retain
the previously selected release, the stalled writer's orphan, and
any earlier successfully published generation. No automatic cleanup
is performed.

These deterministic overlapping-lifetime scenarios do not exhaust
all simultaneous rename/fsync reorderings; especially they do not
establish a serializable compare-and-swap API. The TLA+ publication
models remain abstract and the kernel/filesystem/barrier limitations
described in `ATOMIC_QEMU_AND_NATIVE_REPRO.md` still apply.

Release promotion continues to require originating repository CI
admission, enforceable branch protection, and independent review
per issue #23. Physical host power-cut qualification, immutable native
transitive dependency snapshots, and automated fencing/GC remain
open in issue #27.
