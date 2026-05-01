import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SandboxError } from "./errors.js";
import type { SandboxHandle, SandboxProvider, StartOptions } from "./sandbox-provider.js";

const execFileAsync = promisify(execFile);

export type DockerOptions = {
	imageName?: string;
	shareClaudeConfig?: boolean;
	claudeConfigPath?: string;
	env?: Record<string, string>;
};

function getStderr(err: unknown): string | undefined {
	if (
		err !== null &&
		typeof err === "object" &&
		"stderr" in err &&
		typeof err.stderr === "string"
	) {
		return err.stderr;
	}
	return undefined;
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return JSON.stringify(err);
}

export function docker(opts: DockerOptions = {}): SandboxProvider {
	return {
		name: "docker",
		async start(startOpts: StartOptions): Promise<SandboxHandle> {
			// Step 1: synchronous option validation (AC#15) — must throw
			// before any side effect.
			if (opts.imageName !== undefined && opts.shareClaudeConfig !== false) {
				throw new SandboxError(
					"INVALID_OPTIONS",
					"shareClaudeConfig must be set to false explicitly when imageName is overridden — custom images may not provide /home/tff/.claude",
				);
			}

			// Step 2: probe daemon.
			try {
				await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
			} catch (err) {
				throw new SandboxError("DOCKER_UNAVAILABLE", getStderr(err) ?? getErrorMessage(err), err);
			}

			// Step 3: validate worktreePath.
			const resolvedWorktree = path.resolve(startOpts.worktreePath);
			try {
				const st = statSync(resolvedWorktree);
				if (!st.isDirectory()) {
					throw new SandboxError("WORKTREE_NOT_FOUND", `Worktree not found: ${resolvedWorktree}`);
				}
			} catch (err) {
				if (err instanceof SandboxError) throw err;
				throw new SandboxError(
					"WORKTREE_NOT_FOUND",
					`Worktree not found: ${resolvedWorktree}`,
					err,
				);
			}

			// Steps 4+ land in T06+.
			throw new SandboxError(
				"DOCKER_UNAVAILABLE",
				"docker().start() not yet implemented past step 3",
			);
		},
	};
}
