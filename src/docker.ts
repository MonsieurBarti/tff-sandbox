import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

			// Step 6: mounts. T07 only adds the worktree mount; the layered
			// ~/.claude ro-parent + rw-projects mounts are appended in T08. The
			// MOUNT ORDER MATTERS invariant (ro parent first, rw child second —
			// second mount wins at the sub-path) is enforced by T08; T07's tests
			// pass shareClaudeConfig:false to avoid coupling on the host's real
			// ~/.claude.
			const mounts: string[] = [`${resolvedWorktree}:/home/tff/workspace`];

			// Step 7: merge env, auto-forward ANTHROPIC_API_KEY.
			const merged: Record<string, string> = {
				...(startOpts.env ?? {}),
				...(opts.env ?? {}),
			};
			if (process.env.ANTHROPIC_API_KEY !== undefined && merged.ANTHROPIC_API_KEY === undefined) {
				merged.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
			}

			// Step 8: name (assigned only after run succeeds).
			const generatedName = `tff-sandbox-${randomUUID()}`;
			let containerName: string | null = null;

			// Step 9: register process-level cleanup hooks BEFORE docker run.
			const onExit = (): void => {
				if (containerName === null) return;
				try {
					execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
				} catch {
					/* best-effort */
				}
			};
			const onSignal = (): void => {
				onExit();
				process.exit(1);
			};
			process.on("exit", onExit);
			process.on("SIGINT", onSignal);
			process.on("SIGTERM", onSignal);

			// Step 10: best-effort prune of stopped zombies.
			try {
				const { stdout } = await execFileAsync("docker", [
					"ps",
					"-a",
					"--filter",
					"label=tff-sandbox=1",
					"--filter",
					"status=exited",
					"--format",
					"{{.Names}}",
				]);
				const zombies = stdout.split("\n").filter((n) => n.length > 0);
				for (const z of zombies) {
					await execFileAsync("docker", ["rm", z]).catch(() => {});
				}
			} catch {
				/* best-effort */
			}

			// Step 11: docker run -d.
			const hostUid = process.getuid?.() ?? 1000;
			const hostGid = process.getgid?.() ?? 1000;
			const runArgs: string[] = [
				"run",
				"-d",
				"--rm",
				"--name",
				generatedName,
				"--label",
				"tff-sandbox=1",
				"--user",
				`${hostUid}:${hostGid}`,
				"-w",
				"/home/tff/workspace",
			];
			// MOUNT ORDER MATTERS: ro parent first, rw child second — second
			// mount wins at sub-path. Do not reorder. (T08's tests pin the
			// resulting -v flag order to defend against future refactors that
			// might sort mounts.)
			for (const m of mounts) runArgs.push("-v", m);
			for (const [k, v] of Object.entries(merged)) runArgs.push("-e", `${k}=${v}`);
			runArgs.push(imageTag);

			try {
				await execFileAsync("docker", runArgs);
			} catch (err) {
				process.off("exit", onExit);
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
				throw new SandboxError(
					"CONTAINER_START_FAILED",
					getStderr(err) ?? getErrorMessage(err),
					err,
				);
			}
			containerName = generatedName;

			// Step 12: readiness probe.
			let ready = false;
			let probeErr: unknown = undefined;
			for (let i = 0; i < 5; i++) {
				try {
					await execFileAsync("docker", ["exec", containerName, "true"]);
					ready = true;
					break;
				} catch (e) {
					probeErr = e;
					await new Promise((r) => setTimeout(r, 100));
				}
			}
			if (!ready) {
				try {
					await execFileAsync("docker", ["rm", "-f", containerName]);
				} catch {
					/* best-effort */
				}
				process.off("exit", onExit);
				process.off("SIGINT", onSignal);
				process.off("SIGTERM", onSignal);
				throw new SandboxError(
					"CONTAINER_START_FAILED",
					"Container did not become ready within 500ms",
					probeErr,
				);
			}

			// Step 13: build handle. exec + dispose are stubs here; T09 rewrites
			// exec with streaming + onLine semantics, T10 hardens dispose with
			// the swallow regex + DISPOSE_FAILED classification.
			let disposed = false;
			const handle: SandboxHandle = {
				containerName: generatedName,
				workspacePath: "/home/tff/workspace",
				async exec(command, _execOpts) {
					try {
						const { stdout, stderr } = await execFileAsync("docker", [
							"exec",
							generatedName,
							"sh",
							"-c",
							command,
						]);
						return { stdout, stderr, exitCode: 0 };
					} catch (e) {
						const stderr = getStderr(e) ?? "";
						return { stdout: "", stderr, exitCode: 1 };
					}
				},
				async dispose() {
					if (disposed) return;
					disposed = true;
					try {
						await execFileAsync("docker", ["rm", "-f", generatedName]);
					} catch {
						/* best-effort, T10 hardens */
					}
					process.off("exit", onExit);
					process.off("SIGINT", onSignal);
					process.off("SIGTERM", onSignal);
				},
				async [Symbol.asyncDispose]() {
					await this.dispose();
				},
			};
			return handle;
		},
	};
}
