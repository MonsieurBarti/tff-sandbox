export type StartOptions = {
	worktreePath: string;
	env?: Record<string, string>;
};

export type ExecOptions = {
	cwd?: string;
	onLine?: (line: string) => void;
	stdin?: string;
};

export type ExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export interface SandboxHandle {
	readonly containerName: string;
	readonly workspacePath: string;
	exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
	dispose(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

export interface SandboxProvider {
	readonly name: string;
	start(opts: StartOptions): Promise<SandboxHandle>;
}
