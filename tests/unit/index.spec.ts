import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/index.js";
import type {
	ExecOptions,
	ExecResult,
	SandboxHandle,
	SandboxProvider,
} from "../../src/sandbox-provider.js";

const execFileP = promisify(execFile);

const TERMINATOR = JSON.stringify({ type: "result" });

function cleanGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

type StubExec = (
	cmd: string,
	opts: ExecOptions | undefined,
	ctx: { worktreePath: string },
) => Promise<ExecResult>;

type FakeOpts = {
	exec: StubExec;
	startThrows?: Error;
	disposeOrder: string[];
	disposeDelayMs?: number;
};

function fakeProvider(o: FakeOpts): SandboxProvider {
	return {
		name: "fake",
		async start({ worktreePath }) {
			if (o.startThrows !== undefined) throw o.startThrows;
			let disposed = false;
			const handle: SandboxHandle = {
				containerName: "fake",
				workspacePath: worktreePath,
				async exec(cmd, opts) {
					return await o.exec(cmd, opts, { worktreePath });
				},
				async dispose() {
					if (disposed) return;
					disposed = true;
					if (o.disposeDelayMs !== undefined) {
						await new Promise((r) => setTimeout(r, o.disposeDelayMs));
					}
					o.disposeOrder.push("sandbox");
				},
				async [Symbol.asyncDispose]() {
					await this.dispose();
				},
			};
			return handle;
		},
	};
}

async function gitCommit(
	worktreePath: string,
	file: string,
	content: string,
	msg: string,
): Promise<void> {
	writeFileSync(path.join(worktreePath, file), content);
	await execFileP("git", ["add", file], { cwd: worktreePath, env: cleanGitEnv() });
	await execFileP("git", ["commit", "-m", msg], {
		cwd: worktreePath,
		env: cleanGitEnv(),
	});
}

function emitTerminator(opts: ExecOptions | undefined): void {
	if (opts?.onLine !== undefined) opts.onLine(TERMINATOR);
}

describe("run", () => {
	let repo: string;
	let counter = 0;

	beforeEach(async () => {
		repo = mkdtempSync(path.join(tmpdir(), "tff-run-unit-"));
		await execFileP("git", ["init", "-b", "main", "-q"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		await execFileP("git", ["config", "user.email", "u@u.test"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		await execFileP("git", ["config", "user.name", "u"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		writeFileSync(path.join(repo, "seed"), "s");
		await execFileP("git", ["add", "."], { cwd: repo, env: cleanGitEnv() });
		await execFileP("git", ["commit", "-q", "-m", "seed"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		counter += 1;
	});

	afterEach(() => {
		if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
	});

	const branchName = (): string => `agent/u-${Date.now()}-${counter}`;

	it("happy path returns commits oldest-first with exitCode 0", async () => {
		const branch = branchName();
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			async exec(_cmd, opts, ctx) {
				await gitCommit(ctx.worktreePath, "out.txt", "hello", "agent commit");
				emitTerminator(opts);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});

		const result = await run({
			agent: "claude-code",
			sandbox: provider,
			prompt: "make a file",
			branchStrategy: { type: "branch", branch },
			repoPath: repo,
		});

		expect(result.branch).toBe(branch);
		expect(result.commits.length).toBe(1);
		expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.exitCode).toBe(0);
		expect(disposeOrder).toEqual(["sandbox"]);
	});

	it("returns empty commits when agent makes none", async () => {
		const branch = branchName();
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			async exec(_cmd, opts) {
				emitTerminator(opts);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});

		const result = await run({
			agent: "claude-code",
			sandbox: provider,
			prompt: "noop",
			branchStrategy: { type: "branch", branch },
			repoPath: repo,
		});

		expect(result.commits).toEqual([]);
		expect(result.exitCode).toBe(0);
	});

	it("returns commits even when agent exits non-zero", async () => {
		const branch = branchName();
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			async exec(_cmd, opts, ctx) {
				await gitCommit(ctx.worktreePath, "partial.txt", "x", "partial commit");
				emitTerminator(opts);
				return { stdout: "", stderr: "", exitCode: 1 };
			},
		});

		const result = await run({
			agent: "claude-code",
			sandbox: provider,
			prompt: "do partial work",
			branchStrategy: { type: "branch", branch },
			repoPath: repo,
		});

		expect(result.exitCode).toBe(1);
		expect(result.commits.length).toBe(1);
	});

	it("disposes sandbox before worktree when agent throws", async () => {
		const branch = branchName();
		const branchSlug = branch.replace(/\//g, "-");
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			disposeDelayMs: 30,
			async exec(_cmd, _opts, ctx) {
				await gitCommit(ctx.worktreePath, "boom.txt", "x", "before-throw");
				throw new Error("boom");
			},
		});

		await expect(
			run({
				agent: "claude-code",
				sandbox: provider,
				prompt: "explode",
				branchStrategy: { type: "branch", branch },
				repoPath: repo,
			}),
		).rejects.toThrow("boom");

		expect(disposeOrder).toEqual(["sandbox"]);

		const { stdout: list } = await execFileP("git", ["worktree", "list", "--porcelain"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		expect(list).not.toContain(branchSlug);
	});

	it("disposes worktree when sandbox.start throws", async () => {
		const branch = branchName();
		const branchSlug = branch.replace(/\//g, "-");
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			startThrows: new Error("nope"),
			async exec() {
				throw new Error("unreachable");
			},
		});

		await expect(
			run({
				agent: "claude-code",
				sandbox: provider,
				prompt: "noop",
				branchStrategy: { type: "branch", branch },
				repoPath: repo,
			}),
		).rejects.toThrow("nope");

		expect(disposeOrder).toEqual([]);
		const { stdout: list } = await execFileP("git", ["worktree", "list", "--porcelain"], {
			cwd: repo,
			env: cleanGitEnv(),
		});
		expect(list).not.toContain(branchSlug);
	});

	it("orders commits oldest-first across multiple agent commits", async () => {
		const branch = branchName();
		const disposeOrder: string[] = [];
		const provider = fakeProvider({
			disposeOrder,
			async exec(_cmd, opts, ctx) {
				await gitCommit(ctx.worktreePath, "a.txt", "1", "c1");
				await gitCommit(ctx.worktreePath, "b.txt", "2", "c2");
				await gitCommit(ctx.worktreePath, "c.txt", "3", "c3");
				emitTerminator(opts);
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		});

		const result = await run({
			agent: "claude-code",
			sandbox: provider,
			prompt: "make three commits",
			branchStrategy: { type: "branch", branch },
			repoPath: repo,
		});

		expect(result.commits.length).toBe(3);
		const messages: string[] = [];
		for (const c of result.commits) {
			const { stdout } = await execFileP("git", ["log", "-1", "--format=%s", c.sha], {
				cwd: repo,
				env: cleanGitEnv(),
			});
			messages.push(stdout.trim());
		}
		expect(messages).toEqual(["c1", "c2", "c3"]);
	});
});
