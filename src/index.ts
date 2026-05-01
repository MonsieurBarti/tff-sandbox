export type AgentKind = "claude-code";
export type SandboxKind = "docker";

export type BranchStrategy = {
	type: "branch";
	branch: string;
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
