export type AgentKind = "claude-code";
export type SandboxKind = "docker";

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
	sandbox: SandboxKind;
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
		`@the-forge-flow/sandbox: run() not implemented (got agent=${options.agent}, sandbox=${options.sandbox})`,
	);
}

export { WorktreeError } from "./errors.js";
export type { WorktreeErrorCode } from "./errors.js";
export { createWorktree } from "./worktree.js";
export type { CreateWorktreeOptions, WorktreeHandle } from "./worktree.js";
