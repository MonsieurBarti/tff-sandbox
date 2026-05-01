import type { SandboxProvider } from "./sandbox-provider.js";

export type AgentKind = "claude-code";

export type BranchStrategy = {
	type: "branch";
	branch: string;
	/**
	 * Git ref used as the starting point when the branch does not yet exist.
	 * Default "HEAD". Ignored when the branch already exists (whether reused
	 * from a managed worktree or attached to an existing ref).
	 */
	baseBranch?: string;
};

export type RunOptions = {
	agent: AgentKind;
	sandbox: SandboxProvider;
	prompt: string;
	branchStrategy: BranchStrategy;
};

export type Commit = {
	sha: string;
};

export type RunResult = {
	branch: string;
	commits: Commit[];
	exitCode: number;
};

export async function run(options: RunOptions): Promise<RunResult> {
	throw new Error(
		`@the-forge-flow/sandbox: run() not implemented (got agent=${options.agent}, sandbox=${options.sandbox.name})`,
	);
}

export { WorktreeError } from "./errors.js";
export type { WorktreeErrorCode } from "./errors.js";
export { createWorktree } from "./worktree.js";
export type { CreateWorktreeOptions, WorktreeHandle } from "./worktree.js";

export { SandboxError } from "./errors.js";
export type { SandboxErrorCode } from "./errors.js";
export { AgentError } from "./errors.js";
export type { AgentErrorCode } from "./errors.js";
export { docker } from "./docker.js";
export type { DockerOptions } from "./docker.js";
export { runClaudeCode } from "./agent/claude-code.js";
export type { AgentResult, RunClaudeCodeOptions } from "./agent/claude-code.js";
export type {
	ExecOptions,
	ExecResult,
	SandboxHandle,
	SandboxProvider,
	StartOptions,
} from "./sandbox-provider.js";
