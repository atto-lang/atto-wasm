# PR #9 — bounded owned-envelope schema reconciliation

Historical head `a0d968aca4c29471c798e0adffaaea95ea109b18`; current main `f7f2b2cb6049bde4e33484c9ea899887659e08a3`.

Main already contains the PR's schema-byte and node budgets, and adds stricter `Reflect.ownKeys` / enumerable own **data** property guards, sparse-array rejection, canonical normalization and value-node budgets. Replacing it with the historical `transport/owned-envelope.mjs` would reopen inherited/accessor/sparse descriptor authority bugs. Keep current codec and the existing stronger `tests/owned-envelope.test.mjs` intact.

Add independent negative tests for cyclic type metadata, sparse tuple schemas, and malicious enumerable getters. The validation happens before any async WebCrypto SHA-256 or untrusted message copying. The test fixture is a browser-compatible host codec only; it does not claim Wasm guest compiler, MessagePack v2, actor scheduler or transport parity.

**Gate:** `node --test tests/schema-budget-forward-port.test.mjs` and the complete Node codec suite on this exact PR head. Review the failure diagnostics, stable error contracts, and frontend/backend protocol bounds before considering a merge.
