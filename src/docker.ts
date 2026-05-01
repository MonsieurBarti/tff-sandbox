import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

			// Step 4: resolve image tag.
			let imageTag: string;
			let dockerfileBytes: Buffer | null = null;
			if (opts.imageName !== undefined) {
				imageTag = opts.imageName;
			} else {
				dockerfileBytes = readFileSync(
					fileURLToPath(new URL("../runtime/claude-code/Dockerfile", import.meta.url)),
				);
				const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
				imageTag = `tff-sandbox-runtime-claude-code:${sha12}`;
			}

			// Step 5: ensure image exists (only when not overridden).
			if (opts.imageName === undefined && dockerfileBytes !== null) {
				let cached = false;
				try {
					await execFileAsync("docker", ["image", "inspect", imageTag]);
					cached = true;
				} catch {
					cached = false;
				}
				if (!cached) {
					await new Promise<void>((resolve, reject) => {
						const child = spawn("docker", ["build", "--progress=plain", "-t", imageTag, "-"], {
							stdio: ["pipe", "pipe", "pipe"],
						});
						const stderrChunks: string[] = [];
						child.stderr.on("data", (chunk) => {
							stderrChunks.push(chunk.toString());
						});
						child.on("error", (err) => {
							reject(new SandboxError("IMAGE_BUILD_FAILED", getErrorMessage(err), err));
						});
						child.on("close", (code) => {
							if (code === 0) {
								resolve();
								return;
							}
							reject(
								new SandboxError(
									"IMAGE_BUILD_FAILED",
									stderrChunks.join("") || `docker build exited ${code ?? "?"}`,
								),
							);
						});
						child.stdin.write(dockerfileBytes);
						child.stdin.end();
					});
				}
			}

			// Step 6+ (docker run) lands in T07+.
			// Stub handle: satisfies SandboxHandle interface until T07 implements run.
			const stubHandle: SandboxHandle = {
				containerName: `tff-sandbox-stub-${imageTag}`,
				workspacePath: "/home/tff/workspace",
				async exec() {
					throw new SandboxError("DOCKER_UNAVAILABLE", "exec() not yet implemented");
				},
				async dispose() {
					/* no container to stop — stub */
				},
				async [Symbol.asyncDispose]() {
					/* no container to stop — stub */
				},
			};
			return stubHandle;
		},
	};
}
