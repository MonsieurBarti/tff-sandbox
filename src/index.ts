import { runClaudeCode } from "./agent/claude-code.js";
import type { SandboxProvider } from "./sandbox-provider.js";
import { createWorktree } from "./worktree.js";

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
	repoPath: string;
};

export type Commit = {
	sha: string;
};

export type RunResult = {
	branch: string;
	commits: Commit[];
	exitCode: number;
};

export async function run(opts: RunOptions): Promise<RunResult> {
	await using wt = await createWorktree({
		repoPath: opts.repoPath,
		branchStrategy: opts.branchStrategy,
	});
	const headBefore = await wt.getHead();
	await using sandbox = await opts.sandbox.start({ worktreePath: wt.path });
	const agent = await runClaudeCode(sandbox, opts.prompt, { hostWorktreePath: wt.path });
	const newest = await wt.listCommitsSince(headBefore);
	const commits = newest.slice().reverse();
	return { branch: wt.branch, commits, exitCode: agent.exitCode };
}

export { WorktreeError } from "./errors.js";
export type { WorktreeErrorCode } from "./errors.js";
export { createWorktree };
export type { CreateWorktreeOptions, WorktreeHandle } from "./worktree.js";

export { SandboxError } from "./errors.js";
export type { SandboxErrorCode } from "./errors.js";
export { AgentError } from "./errors.js";
export type { AgentErrorCode } from "./errors.js";
export { docker } from "./docker.js";
export type { DockerOptions } from "./docker.js";
export { runClaudeCode };
export type { AgentResult, RunClaudeCodeOptions } from "./agent/claude-code.js";
export type {
	ExecOptions,
	ExecResult,
	SandboxHandle,
	SandboxProvider,
	StartOptions,
} from "./sandbox-provider.js";
