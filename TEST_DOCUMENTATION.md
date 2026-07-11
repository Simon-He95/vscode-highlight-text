# Test coverage

Run the repository quality gate with:

```bash
pnpm check
```

The Vitest suite imports production modules directly and covers:

- budgeted configuration compilation, malformed settings, capped warnings/toasts, RegExp flags, nested tuple syntax, and ambiguous top-level-array compatibility;
- lookarounds, named groups, advisory diagnostics for main/ignore patterns, and newline-preserving masked-text plus interval `ignoreReg` filtering;
- Unicode-aware zero-width matching;
- worker-enforced timeout, active cancellation, queued cancellation, constructor/postMessage failure recovery, and ignore/main-scan truncation;
- sticky and explicit-empty flag semantics;
- engine-provided indices for repeated, optional, and lookbehind captures;
- React JSX/TSX alias compatibility and rule-local `ignoreReg` behavior;
- document-scoped rule cooldowns, document-versioned rule snapshots, global language/rule/style/target/ignore/span limits, and total refresh range/time budgets;
- latest-wins, single-flight scheduling and immediate stale-task invalidation;
- removal of 1,000 historical editor states;
- disposal during asynchronous work without late decoration creation;
- initial activation fallback, transactional configuration changes, split editors, incomplete visible-scan protection, visible-editor removal, language close/open changes, cached/chunked Vue TSX detection, theme refresh, and exclude cleanup;
- cooldown enforcement across edits, duplicate-range removal, and preservation of the last complete snapshot when refresh budgets expire;
- bounded warning/ignore-interval/cache state, cache generations, and reuse of unchanged slice text inside the worker;
- per-editor executors and deterministic, transactional decoration type creation, batching, reuse, cleanup, and disposal.

CI additionally:

- runs tests on Linux Node 20/22, macOS Node 22, and Windows Node 22;
- executes the production `RegexExecutor` worker on Node 16.14.2, matching the runtime shipped by the minimum supported VS Code 1.77;
- packages a VSIX and verifies `extension/dist/index.js` and `extension/README_zh.md` are present.

`pnpm run pack` invokes the VS Code `vscode:prepublish` hook, runs all checks, rebuilds the extension, and packages the VSIX.

The focused VS Code API mock is not a full Extension Host. Rendering behavior in a real Extension Host remains an integration-level smoke-test opportunity.
