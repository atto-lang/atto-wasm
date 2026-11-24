> **AI agent instructions (organization-wide):** Before working on code, issues, or pull requests, read and follow the [organization `AGENTS.md`](https://github.com/atto-lang/.github/blob/main/AGENTS.md), including its **merge-first stealth-development policy**. Honor any repository-local `AGENTS.md`, explicit holds, and GitHub-enforced rules.

# atto-wasm

WebAssembly integration, components, and interoperability utilities for AttoLang.

## Naming migration and language authority

This repository is maintained at [atto-lang/atto-wasm](https://github.com/atto-lang/atto-wasm); use `https://github.com/atto-lang/atto-wasm.git` for Git remotes and canonical `.atto` source examples. The normative language contract is [atto-spec](https://github.com/atto-lang/atto-spec), with executable guest evidence tracked by [atto-platform-conformance](https://github.com/atto-lang/atto-platform-conformance). Follow current ownership, borrowing, effects, actor, and syntax rules there; do not infer implemented features from a README or unexecuted CI.

## Scope

Wasm ABI integration, host interoperability, module packaging, and portability tests.

## Compatibility and design

This package is intended to integrate with [AttoLang](https://github.com/atto-lang) while clearly separating portable language behavior from backend- and host-specific features. Document APIs, target restrictions, and security/trust boundaries.

## Development and verification

Refer to checked-in sources and CI workflows for verified build and test commands. Include platform-specific execution tests and publish exact-commit evidence before asserting backend parity or production readiness.

## Project status

This README describes the intended repository scope and does not imply implemented functionality or verified target coverage.

## Related

- [Language specification](https://github.com/atto-lang/atto-spec)
- [Platform conformance](https://github.com/atto-lang/atto-platform-conformance)

## Repository ownership and contribution routing

**Belongs here:** Reusable Wasm module/component integration, WIT/ABI adapters, host/guest interop and compatible packaging utilities.

**Belongs elsewhere:** Wasm compiler backend/lowering belongs in atto-source.wasm; Rust compiler-to-Wasm in atto-source.rs; deployment in atto-playground.

**Security and portability boundary:** Separate browsers' WebAssembly APIs from native Wasmtime hosts; verify import signatures, linear-memory bounds, capability admission and target-specific negative tests.

AttoLang is the canonical project name; new source, examples and documentation use `.atto` and the `atto-lang` repository organization. This README defines scope, not feature readiness.

**Acceptance:** name exact source SHA/tree, runtime/toolchain, positive and negative checks and execution receipt before claiming support. Host-only tests and empty CI steps do not prove guest execution.
