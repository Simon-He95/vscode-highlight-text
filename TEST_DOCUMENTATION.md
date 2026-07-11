# Test coverage

Run the repository quality gate with:

```bash
pnpm check
```

The Vitest suite imports production modules directly and covers:

- configuration compilation, malformed settings, RegExp flags, and legacy tuple compatibility;
- lookarounds, named groups, and advisory-only expensive-pattern diagnostics;
- Unicode-aware zero-width matching;
- worker-enforced timeout, active cancellation, queued cancellation, and recovery;
- engine-provided indices for repeated, optional, and lookbehind captures;
- rule-local `ignoreReg` behavior;
- latest-wins, single-flight scheduling and immediate stale-task invalidation;
- removal of 1,000 historical editor states;
- disposal during asynchronous work without late decoration creation;
- decoration batching, type reuse, idempotent cleanup, and disposal.

CI additionally:

- runs tests on Linux Node 20/22, macOS Node 22, and Windows Node 22;
- checks the built extension with Node 16.14.2, matching the runtime shipped by the minimum supported VS Code 1.77;
- packages a VSIX and verifies `extension/dist/index.js` is present.

`pnpm run pack` invokes the VS Code `vscode:prepublish` hook, runs all checks, rebuilds the extension, and packages the VSIX.

The focused VS Code API mock is not a full Extension Host. Rendering behavior in a real Extension Host remains an integration-level smoke-test opportunity.
