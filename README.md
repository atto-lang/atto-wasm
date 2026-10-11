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
