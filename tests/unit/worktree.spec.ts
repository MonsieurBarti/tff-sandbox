import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeError } from "../../src/errors.js";
import { createWorktree } from "../../src/worktree.js";

const execFileAsync = promisify(execFile);

/**
 * Strip GIT_* env vars that git pre-commit hooks export (GIT_DIR,
 * GIT_INDEX_FILE, GIT_WORK_TREE, etc.). Without this, fixture git commands
 * inherit the parent hook's repo and `cwd:` is silently ignored.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

async function makeRepo(): Promise<{ repoPath: string; cleanup: () => void }> {
	const tmp = mkdtempSync(path.join(tmpdir(), "tff-worktree-"));
	await execFileAsync("git", ["init", "-q", "."], { cwd: tmp, env: cleanGitEnv() });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], {
		cwd: tmp,
		env: cleanGitEnv(),
	});
	await execFileAsync("git", ["config", "user.name", "Test"], {
		cwd: tmp,
		env: cleanGitEnv(),
	});
	await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: tmp,
		env: cleanGitEnv(),
	});
	return {
		repoPath: tmp,
		cleanup: () => rmSync(tmp, { recursive: true, force: true }),
	};
}

describe("WorktreeError", () => {
	it("carries code, message, optional cause", () => {
		const cause = new Error("boom");
		const err = new WorktreeError("GIT_FAILED", "stderr blob", cause);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("WorktreeError");
		expect(err.code).toBe("GIT_FAILED");
		expect(err.message).toBe("stderr blob");
		expect(err.cause).toBe(cause);
	});
});

describe("createWorktree", () => {
	let repo: { repoPath: string; cleanup: () => void };
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		repo = await makeRepo();
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		repo.cleanup();
		warnSpy.mockRestore();
	});

	describe("validation", () => {
		it("throws REPO_NOT_FOUND for non-existent path", async () => {
			await expect(
				createWorktree({
					repoPath: path.join(repo.repoPath, "does-not-exist"),
					branchStrategy: { type: "branch", branch: "agent/foo" },
				}),
			).rejects.toMatchObject({
				name: "WorktreeError",
				code: "REPO_NOT_FOUND",
			});
		});

		it("throws REPO_NOT_FOUND for non-git directory", async () => {
			const nonGit = mkdtempSync(path.join(tmpdir(), "tff-not-git-"));
			try {
				await expect(
					createWorktree({
						repoPath: nonGit,
						branchStrategy: { type: "branch", branch: "agent/foo" },
					}),
				).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
			} finally {
				rmSync(nonGit, { recursive: true, force: true });
			}
		});

		it("throws INVALID_BRANCH_NAME for empty branch", async () => {
			await expect(
				createWorktree({
					repoPath: repo.repoPath,
					branchStrategy: { type: "branch", branch: "" },
				}),
			).rejects.toMatchObject({ code: "INVALID_BRANCH_NAME" });
		});

		it("throws INVALID_BRANCH_NAME for git-rejected branch (double dot)", async () => {
			await expect(
				createWorktree({
					repoPath: repo.repoPath,
					branchStrategy: { type: "branch", branch: "foo..bar" },
				}),
			).rejects.toMatchObject({ code: "INVALID_BRANCH_NAME" });
		});

		it("throws INVALID_BRANCH_NAME for branch with space", async () => {
			await expect(
				createWorktree({
					repoPath: repo.repoPath,
					branchStrategy: { type: "branch", branch: "has space" },
				}),
			).rejects.toMatchObject({ code: "INVALID_BRANCH_NAME" });
		});
	});

	describe("happy path", () => {
		it("creates worktree at <repoPath>/.tff-sandbox/worktrees/<name> for new branch", async () => {
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			const expected = path.join(
				realpathSync(repo.repoPath),
				".tff-sandbox",
				"worktrees",
				"agent-foo",
			);
			expect(handle.path).toBe(expected);
			expect(handle.branch).toBe("agent/foo");
			expect(handle.reused).toBe(false);
			const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
				cwd: handle.path,
				env: cleanGitEnv(),
			});
			const { stdout: srcHead } = await execFileAsync("git", ["rev-parse", "HEAD"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			expect(stdout.trim()).toBe(srcHead.trim());
		});

		it("maps slash to dash in directory name", async () => {
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo/bar" },
			});
			expect(path.basename(handle.path)).toBe("agent-foo-bar");
			expect(handle.branch).toBe("agent/foo/bar");
		});

		it("returns realpathed worktree path (macOS /private/var round-trip)", async () => {
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/realpath" },
			});
			const realRepo = realpathSync(repo.repoPath);
			expect(handle.path.startsWith(realRepo)).toBe(true);
		});

		it("resolves a relative repoPath against process.cwd()", async () => {
			const cwd = process.cwd();
			try {
				process.chdir(path.dirname(repo.repoPath));
				const rel = path.basename(repo.repoPath);
				const handle = await createWorktree({
					repoPath: rel,
					branchStrategy: { type: "branch", branch: "agent/rel" },
				});
				expect(handle.path).toBe(
					path.join(realpathSync(repo.repoPath), ".tff-sandbox", "worktrees", "agent-rel"),
				);
			} finally {
				process.chdir(cwd);
			}
		});

		it("honors baseBranch when branch does not yet exist", async () => {
			await execFileAsync("git", ["checkout", "-b", "base-x"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			const { stdout: baseTip } = await execFileAsync("git", ["rev-parse", "base-x"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			// Switch off base-x so the new worktree must follow baseBranch, not HEAD.
			await execFileAsync("git", ["checkout", "-"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/from-base", baseBranch: "base-x" },
			});
			const head = await handle.getHead();
			expect(head).toBe(baseTip.trim());
		});
	});

	describe("existing branch ref reuse", () => {
		it("attaches to a pre-existing branch ref without creating a commit", async () => {
			await execFileAsync("git", ["branch", "agent/foo"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			const { stdout: preTip } = await execFileAsync("git", ["rev-parse", "agent/foo"], {
				cwd: repo.repoPath,
				env: cleanGitEnv(),
			});
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(handle.reused).toBe(false);
			expect(handle.branch).toBe("agent/foo");
			const head = await handle.getHead();
			expect(head).toBe(preTip.trim());
		});
	});
});

describe("WorktreeHandle", () => {
	it.todo("populated by T05");
});
