# Test coverage

The Vitest suite imports and exercises production modules directly. Run it with:

```bash
pnpm test
```

The current suite covers:

- configuration compilation and RegExp flag normalization;
- acceptance of lookarounds and named capture groups;
- rejection of common nested-quantifier patterns;
- pattern strings, pattern tuples, and pattern arrays;
- immutable `background` to `backgroundColor` normalization;
- rule-local `ignoreReg` intervals;
- engine-provided capture indices for repeated, nested, optional, and lookbehind groups;
- compatibility with the existing first-participating-capture default;
- a worker-enforced timeout for catastrophic backtracking and worker recovery;
- batched decoration ranges, decoration type reuse, rebuild cleanup, and disposal.

The repository quality gate is:

```bash
pnpm check
```

This runs ESLint, TypeScript type checking, and Vitest. `pnpm run pack` also invokes the VS Code `vscode:prepublish` hook, rebuilds the extension, and packages a VSIX.

The tests use a focused VS Code API mock and are not a replacement for an Extension Host smoke test. Event wiring and rendering in a real Extension Host remain integration-level concerns.
