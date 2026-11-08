# Oreslang Wasm execution infrastructure

**Current status:** runnable WebAssembly **runtime ABI prototype** implemented in freestanding C, with Node/WebAssembly smoke tests. No Oreslang guest source-to-Wasm compilation is claimed.

## Goals
- Feed verified Oreslang MIR into the existing LLVM backend and produce real wasm32 objects/modules.
- Version core Wasm ABI and WIT/component interfaces, keeping them distinct.
- Host capabilities always checked by compiler, linker/import validation, and runtime.
- Preserve actor ownership and async contracts when portable lowering is implemented.

## Run the working prototype

~~~sh
npm test
# or build only:
npm run build
~~~

Prerequisites: Node 22+, Clang with wasm32 target, wasm-ld. The build uses freestanding no-libc Clang, exports a 32-bit memory and functions described in docs/ABI.md. The example module contains a bounded **single-threaded FIFO** (8 messages), elementary math, and a clock host import behind a capability mask. It is intentionally NOT an Oreslang scheduler, GC, async runtime or security sandbox.

Output: build/oreslang_rt.wasm (generated, not checked in). The tests instantiate the binary and prove positive/negative cap behavior. A build/test failure is actionable; CI does not silently fall back to fake Wasm.

## Next implementation slices
1. Formal IR-to-LLVM wasm32 lowering in oreslang-source.llvm.
2. Oreslang call frame, ownership transfer, borrow-safe linear-memory ABI, async state machines.
3. WIT binding/componentization with separately pinned WASI 0.2 and 0.3 host profiles.
4. Real browser and edge conformance runs from oreslang-platform-conformance.
5. Runtime max-memory, table limits, fuel/interrupt policies at the real host boundary.

The WIT file in this repo is a **future component interface**. The core Wasm prototype does not yet implement the component model. Keep runtime ABI and host environment separate from admission rules at oreslang-target-profiles.

See https://ores-truffle-oreslang.github.io/logs/2/


## Experimental source-to-Wasm bridge (new)

The initial native LLVM compiler supports a small integer-function subset. With an **actual, caller-supplied** compiled native `oreslang-llvmc` binary, the following pipeline is now available:

~~~sh
# Build / obtain the native compiler in oreslang-source.llvm first.
node scripts/compile-ores.mjs \
  --compiler=/absolute/path/to/oreslang-llvmc \
  --source="$(pwd)/examples/native-int.ores" \
  --output="$(pwd)/build/real-oreslang-guest.wasm"

# Real integration check; fails rather than simulates if your compiler is absent:
ORESLANG_LLVM_COMPILER=/absolute/path/to/oreslang-llvmc npm test
~~~

Canonical AttoLang `.atto` inputs retain that suffix in the staged, hashed
compiler input; legacy `.ores` inputs retain their prior behavior. The bridge
still validates source bytes and compiler identity independently. Its dedicated
suffix regression runs a **stub compiler** through real Clang/Wasm linking and
is not proof of a modern `.atto` guest compiler or backend parity.

The script runs the native compiler on the exact source, feeds its LLVM IR into Clang's wasm32 target, requires a requested i64 export, validates the resulting module, rejects **all** host imports for this initial pure-integer slice, and records source / compiler executable / IR / Wasm SHA-256 values in a provenance sidecar. Generated modules are staged in a scratch directory until verification succeeds.

`tests/bridge.test.mjs` has a clearly labeled stub-compiler test validating the linker plumbing. It must **never** be counted as Oreslang compiler parity. The separate optional native-compiler integration test runs only with `ORESLANG_LLVM_COMPILER`; the standard CI suite reports it skipped. This does not provide actor/channel/async or ownership feature parity, environment admission, component/WASI APIs, or full source-to-Wasm lowering. The user-supplied compiler path must be trusted; source repository revision is not cryptographically derived from binary hashes.

## Repository ownership and migration (2026-11-08)

**Present home:** `ores-truffle-oreslang/oreslang-wasm` in the legacy Oreslang organization; the public language name is **AttoLang**. Preserve existing `oreslang-*` project, package and command names and `.ores` fixtures until explicitly verified migration steps are approved.

- **Belongs here:** Wasm ABI, guest runtime integration and execution-host experiments.
- **Does not belong here:** Assuming every Wasm target has identical Wasmtime, browser or actor capabilities. Shared language semantics and portable core/std should be implemented as canonical `.atto` code rather than copied into per-host adapters.
- **Organization separation:** [atto-lang](https://github.com/atto-lang) governs language/compiler/runtime/tooling/conformance and portable ecosystem code. [atto-co](https://github.com/atto-co) governs commercial cloud deployments, billing, identity, tenancy and hosted services. A similarly named pre-existing `atto-*` repository is not proof of an executed Git transfer or parity.
- **Proposed migration:** this legacy repository may first transfer to `atto-lang/oreslang-wasm` under its **existing name and stable GitHub repository ID**. No direct `atto-co` move is currently authorized; product carve-outs require a later independent plan.

**Transfer gate:** claim coordination in [legacy issue #26](https://github.com/ores-truffle-oreslang/.github/issues/26) and use [review-only transfer runbook #25](https://github.com/ores-truffle-oreslang/.github/pull/25). Record exact head SHA/tree and ID, independent security and source/target admin approval, destination rules/visibility, PRs, Actions, app credentials, packages, releases, webhooks, Pages, dependents and rollback owner. Do **not** mirror private sources or overwrite existing `atto-*` repos. Recheck unchanged ID/tree and controls after real GitHub ownership transfer; execute exact-head CI at destination. `steps=[]` or `steps=null` is `NOT_EXECUTED`; host-only or source-free tests do not prove compiled AttoLang guest features. Do not mix repository transfers with forced syntax renames or AOT/zero-GC claims.
