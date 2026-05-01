import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

	describe("collisions", () => {
		it("reuses an existing managed worktree (clean) with reused=true and no warn", async () => {
			const first = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			const second = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(second.path).toBe(first.path);
			expect(second.reused).toBe(true);
			expect(second.branch).toBe("agent/foo");
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("warns once on dirty managed reuse", async () => {
			const first = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			const fs = await import("node:fs/promises");
			await fs.writeFile(path.join(first.path, "dirty.txt"), "x");
			const second = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(second.reused).toBe(true);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/uncommitted|dirty/i);
		});

		it("emits a separate warn when baseBranch is supplied alongside reuse", async () => {
			await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			const second = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: {
					type: "branch",
					branch: "agent/foo",
					baseBranch: "HEAD",
				},
			});
			expect(second.reused).toBe(true);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toMatch(/baseBranch/);
		});

		it("emits both warns when reuse is dirty and baseBranch supplied", async () => {
			const first = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			const fs = await import("node:fs/promises");
			await fs.writeFile(path.join(first.path, "dirty.txt"), "x");
			const second = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: {
					type: "branch",
					branch: "agent/foo",
					baseBranch: "HEAD",
				},
			});
			expect(second.reused).toBe(true);
			expect(warnSpy).toHaveBeenCalledTimes(2);
		});

		it("throws BRANCH_IN_USE_EXTERNAL when branch is checked out in main worktree", async () => {
			await execFileAsync("git", ["checkout", "-b", "agent/foo"], { cwd: repo.repoPath });
			await expect(
				createWorktree({
					repoPath: repo.repoPath,
					branchStrategy: { type: "branch", branch: "agent/foo" },
				}),
			).rejects.toMatchObject({ code: "BRANCH_IN_USE_EXTERNAL" });
		});

		it("throws BRANCH_IN_USE_EXTERNAL when branch is checked out in an external worktree", async () => {
			await execFileAsync("git", ["branch", "agent/foo"], { cwd: repo.repoPath });
			const ext = mkdtempSync(path.join(tmpdir(), "tff-external-"));
			// `git worktree add` requires the target dir not pre-exist; use a child path.
			const extWt = path.join(ext, "wt");
			try {
				await execFileAsync("git", ["worktree", "add", extWt, "agent/foo"], {
					cwd: repo.repoPath,
				});
				const err = await createWorktree({
					repoPath: repo.repoPath,
					branchStrategy: { type: "branch", branch: "agent/foo" },
				}).catch((e) => e);
				expect(err).toBeInstanceOf(WorktreeError);
				expect(err.code).toBe("BRANCH_IN_USE_EXTERNAL");
				expect(String(err?.message ?? "")).toMatch(/[/\\]wt\b/);
			} finally {
				await execFileAsync("git", ["worktree", "remove", "--force", extWt], {
					cwd: repo.repoPath,
				}).catch(() => {});
				rmSync(ext, { recursive: true, force: true });
			}
		});
	});

	describe("stale handling", () => {
		it("clears a prunable managed entry (directory removed externally) and proceeds", async () => {
			const first = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			// Simulate crash: the working dir is gone but git metadata persists.
			rmSync(first.path, { recursive: true, force: true });
			const { stdout: pre } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
				cwd: repo.repoPath,
			});
			expect(pre).toMatch(/prunable/);

			const second = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(second.path).toBe(first.path);
			expect(second.reused).toBe(false);
		});

		it("removes a stale managed worktree on a different branch and proceeds", async () => {
			const worktreePath = path.join(
				realpathSync(repo.repoPath),
				".tff-sandbox",
				"worktrees",
				"agent-foo",
			);
			mkdirSync(path.dirname(worktreePath), { recursive: true });
			await execFileAsync("git", ["worktree", "add", "-b", "otherbranch", worktreePath, "HEAD"], {
				cwd: repo.repoPath,
			});
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(handle.path).toBe(worktreePath);
			expect(handle.branch).toBe("agent/foo");
			// otherbranch ref still exists (we only nuked the worktree, not the ref)
			const { stdout: branches } = await execFileAsync("git", ["branch", "--list"], {
				cwd: repo.repoPath,
			});
			expect(branches).toMatch(/otherbranch/);
		});

		it("removes a stale detached managed worktree and proceeds", async () => {
			const worktreePath = path.join(
				realpathSync(repo.repoPath),
				".tff-sandbox",
				"worktrees",
				"agent-foo",
			);
			mkdirSync(path.dirname(worktreePath), { recursive: true });
			await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
				cwd: repo.repoPath,
			});
			const handle = await createWorktree({
				repoPath: repo.repoPath,
				branchStrategy: { type: "branch", branch: "agent/foo" },
			});
			expect(handle.path).toBe(worktreePath);
			expect(handle.branch).toBe("agent/foo");
		});
	});
});

describe("WorktreeHandle", () => {
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

	it("getHead returns the current SHA inside the worktree", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		const head = await handle.getHead();
		expect(head).toMatch(/^[0-9a-f]{40}$/);
		const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
			cwd: handle.path,
			env: cleanGitEnv(),
		});
		expect(head).toBe(stdout.trim());
	});

	it("listCommitsSince returns new commits in topo order, newest first", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		const before = await handle.getHead();
		await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "c1"], {
			cwd: handle.path,
			env: cleanGitEnv(),
		});
		await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "c2"], {
			cwd: handle.path,
			env: cleanGitEnv(),
		});
		const commits = await handle.listCommitsSince(before);
		expect(commits).toHaveLength(2);
		const head = await handle.getHead();
		expect(commits[0]?.sha).toBe(head); // newest first per --topo-order
	});

	it("listCommitsSince returns [] when no new commits exist", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		const head = await handle.getHead();
		const commits = await handle.listCommitsSince(head);
		expect(commits).toEqual([]);
	});

	it("dispose removes the worktree dir but preserves the branch ref", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		const fs = await import("node:fs");
		expect(fs.existsSync(handle.path)).toBe(true);
		await handle.dispose();
		expect(fs.existsSync(handle.path)).toBe(false);
		const { stdout } = await execFileAsync("git", ["branch", "--list", "agent/foo"], {
			cwd: repo.repoPath,
			env: cleanGitEnv(),
		});
		expect(stdout.trim().length).toBeGreaterThan(0);
	});

	it("dispose is idempotent: a second call does not throw", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		await handle.dispose();
		await expect(handle.dispose()).resolves.toBeUndefined();
	});

	it("dispose does not throw if the worktree was removed externally first", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		// External actor: nuke the dir AND prune the metadata.
		rmSync(handle.path, { recursive: true, force: true });
		await execFileAsync("git", ["worktree", "prune"], {
			cwd: repo.repoPath,
			env: cleanGitEnv(),
		});
		await expect(handle.dispose()).resolves.toBeUndefined();
	});

	it("handle.path is realpathed (macOS /private/var round-trip)", async () => {
		const handle = await createWorktree({
			repoPath: repo.repoPath,
			branchStrategy: { type: "branch", branch: "agent/foo" },
		});
		expect(handle.path).toBe(realpathSync(handle.path));
	});
});
