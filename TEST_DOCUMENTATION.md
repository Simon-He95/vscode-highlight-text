# Test coverage

Run the repository quality gate with:

```bash
pnpm check
```

The Vitest suite imports production modules directly and covers:

- on-language activation, self-contained inline settings schema, input-attempt-budgeted configuration compilation, complexity-bounded transactional style registration, malformed settings, capped warnings/toasts, strict RegExp flags, nested tuple syntax, and ambiguous top-level-array compatibility;
- lookarounds, named groups, fail-closed invalid ignore patterns, separate raw/accepted match budgets, interval-level masked-overlap restart, long-prefix recovery, and original sticky-span adoption, advisory diagnostics, single-pass no-ignore execution, and sticky original-text validation;
- Unicode-aware zero-width matching;
- worker-start/result infrastructure timeouts, started/finished worker-enforced execution timeout, queue-independent active execution timing, termination barriers, bounded infrastructure auto-retry, circuit breaking, active cancellation, queued cancellation, constructor/postMessage/metrics-callback failure recovery, and ignore/main-scan truncation;
- sticky, explicit-empty, and document-relative `^`/`$` slice-boundary semantics;
- engine-provided full-match/capture indices, legacy first-participating capture semantics including empty-group stopping, and artificial slice-boundary rejection;
- React JSX/TSX alias compatibility and rule-local `ignoreReg` behavior;
- document-scoped rule cooldowns, document-versioned rule snapshots and editor-local structural-failure caching, resumable scan sessions with cumulative time/job/continuation limits and chunk-local timeout yielding, global language/rule/style/target/ignore/span limits, and explicit skipped-rule handling and atomic per-rule budgets;
- latest-wins, single-flight scheduling and immediate stale-task invalidation;
- removal of 1,000 historical editor states;
- disposal during asynchronous work without late decoration creation;
- manifest-owned empty defaults and initial activation, transactional rule changes, precompiled, bounded, cached, cwd-independent ordered relative and Windows-case-insensitive relative/absolute excludes and negated re-includes, lightweight exclude-only updates, split editors including duplicate timeout cancellation, structured collision-free rule/layer identity and version/scan-key snapshot identity, stale highlight cleanup, visible-editor removal, language close/open changes, bounded, equivalence-skipping cached/chunked Vue TSX detection, theme refresh, and exclude cleanup;
- cooldown enforcement across edits, duplicate-range removal, and preservation of the last complete snapshot when refresh budgets expire;
- bounded warning/ignore-interval/cache state, masked-text cache size, cache generations, and reuse of unchanged slice text inside the worker;
- one shared regex executor and language/theme decoration profiles with cached short-ID context-shared profile priority layers, editor-owned preflight reservations, manager/global transition type budgets, failed-profile quarantine, split-editor reuse, cleanup, and disposal.

CI additionally:

- runs tests on Linux Node 20/22, macOS Node 22, and Windows Node 22;
- executes the production `RegexExecutor` worker on Node 16.14.2, matching the runtime shipped by the minimum supported VS Code 1.77;
- packages a VSIX and verifies `extension/dist/index.js` and `extension/README_zh.md` are present.

`pnpm run pack` invokes the VS Code `vscode:prepublish` hook, runs all checks, rebuilds the extension, and packages the VSIX.

The focused VS Code API mock is not a full Extension Host. Rendering behavior in a real Extension Host remains an integration-level smoke-test opportunity.
