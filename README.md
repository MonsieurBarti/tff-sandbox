# @the-forge-flow/sandbox

> **Status:** Alpha — public API surface defined; functionality lands in M01-S02 through M01-S05.

Sandboxed agent execution for The Forge Flow. A small TypeScript library that runs coding agents (Claude Code first, Pi later) inside an isolated Docker sandbox with a git worktree, expands prompts with sandbox-side shell, and merges commits back per branch strategy.

## Install

```bash
bun add @the-forge-flow/sandbox
# or: npm i @the-forge-flow/sandbox
```

## Usage

```ts
import { run } from "@the-forge-flow/sandbox";

const result = await run({
  agent: "claude-code",
  sandbox: "docker",
  prompt: "echo hello > out.txt && git add . && git commit -m 'test'",
  branchStrategy: { type: "branch", branch: "agent/smoke" },
});

console.log(result.branch, result.commits);
```

> The current `0.0.1` ships a typed stub: calling `run()` throws `not implemented`. Real execution arrives in subsequent slices.

## Development

```bash
bun install
bun run lint
bun run typecheck
bun run test
bun run build
```

## License

MIT — see [LICENSE](./LICENSE).
