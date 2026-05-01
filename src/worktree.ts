import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { WorktreeError } from "./errors.js";

/**
 * Promisified execFile. Returns {stdout, stderr} on success.
 * Rejects with NodeJS.ErrnoException-shaped error on non-zero exit:
 * { code, stdout, stderr, signal, cmd }. Call sites classify the rejection
 * (probe vs. unexpected) — this wrapper does not centralize error mapping.
 */
const execFileAsync = promisify(execFile);

export type CreateWorktreeOptions = {
	repoPath: string;
	branchStrategy: import("./index.js").BranchStrategy;
};

export type Commit = { sha: string };

export interface WorktreeHandle {
	readonly path: string;
	readonly branch: string;
	readonly reused: boolean;
	getHead(): Promise<string>;
	listCommitsSince(sha: string): Promise<Commit[]>;
	dispose(): Promise<void>;
}

export type WorktreeEntry = {
	path: string;
	branch: string | null;
	prunable: boolean;
	locked: boolean;
	detached: boolean;
};

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
	const repoPath = path.resolve(opts.repoPath);
	const { branch, baseBranch } = opts.branchStrategy;

	// 1. Validate repo
	try {
		await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: repoPath });
	} catch (err) {
		throw new WorktreeError("REPO_NOT_FOUND", `Not a git repository: ${repoPath}`, err);
	}

	// 1b. Validate branch name
	if (!branch || branch.length === 0) {
		throw new WorktreeError("INVALID_BRANCH_NAME", "Invalid branch name: ''");
	}
	try {
		await execFileAsync("git", ["check-ref-format", `refs/heads/${branch}`], {
			cwd: repoPath,
		});
	} catch {
		throw new WorktreeError("INVALID_BRANCH_NAME", `Invalid branch name: '${branch}'`);
	}

	// 2. Compute paths
	const worktreesDir = path.join(repoPath, ".tff-sandbox", "worktrees");
	const worktreeName = branch.replace(/\//g, "-");

	// 3. mkdir -p + realpath
	mkdirSync(worktreesDir, { recursive: true });
	let worktreesDirReal: string;
	try {
		worktreesDirReal = realpathSync(worktreesDir);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "EACCES") throw e;
		worktreesDirReal = worktreesDir;
	}
	const worktreePath = path.join(worktreesDirReal, worktreeName);

	// 4. List, then resolve stale-by-path collisions before classifying.
	let listed = await listWorktrees(repoPath);
	const stale = findStaleManaged(listed, branch, worktreePath, worktreesDirReal);
	if (stale.length > 0) {
		await execFileAsync("git", ["worktree", "prune"], { cwd: repoPath }).catch(() => {});
		for (const entry of stale) {
			try {
				await execFileAsync("git", ["worktree", "remove", "--force", entry.path], {
					cwd: repoPath,
				});
			} catch {
				// already gone (prunable case) — prune handled it
			}
		}
		listed = await listWorktrees(repoPath);
	}

	// 5. Classify collision against the (possibly pruned) listing.
	const collision = findCollision(listed, branch, worktreePath, worktreesDirReal);

	if (collision.kind === "managed-reuse") {
		const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
			cwd: collision.path,
		});
		if (status.trim().length > 0) {
			console.warn(`tff-sandbox: reusing worktree at ${collision.path} with uncommitted changes`);
		}
		if (baseBranch !== undefined) {
			console.warn("tff-sandbox: baseBranch is ignored when reusing an existing worktree");
		}
		return makeHandle(collision.path, branch, repoPath, true);
	}

	if (collision.kind === "external") {
		throw new WorktreeError(
			"BRANCH_IN_USE_EXTERNAL",
			`Branch '${branch}' is already checked out at '${collision.path}'. Use a different branch name, or remove that worktree first.`,
		);
	}

	// kind === "none" — proceed to add.
	let branchRefExists = false;
	try {
		await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
			cwd: repoPath,
		});
		branchRefExists = true;
	} catch {
		branchRefExists = false;
	}

	try {
		if (branchRefExists) {
			await execFileAsync("git", ["worktree", "add", worktreePath, branch], {
				cwd: repoPath,
			});
		} else {
			await execFileAsync(
				"git",
				["worktree", "add", "-b", branch, "--", worktreePath, baseBranch ?? "HEAD"],
				{ cwd: repoPath },
			);
		}
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr;
		throw new WorktreeError(
			"GIT_FAILED",
			stderr && stderr.length > 0 ? stderr : (err as Error).message,
			err,
		);
	}

	return makeHandle(worktreePath, branch, repoPath, false);
}

function makeHandle(
	worktreePath: string,
	branch: string,
	repoPath: string,
	reused: boolean,
): WorktreeHandle {
	let disposed = false;
	return {
		path: worktreePath,
		branch,
		reused,
		async getHead(): Promise<string> {
			try {
				const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
					cwd: worktreePath,
				});
				return stdout.trim();
			} catch (err) {
				const stderr = (err as { stderr?: string }).stderr;
				throw new WorktreeError(
					"GIT_FAILED",
					stderr && stderr.length > 0 ? stderr : (err as Error).message,
					err,
				);
			}
		},
		async listCommitsSince(sha: string): Promise<Commit[]> {
			try {
				const { stdout } = await execFileAsync(
					"git",
					["rev-list", "--topo-order", `^${sha}`, "HEAD"],
					{ cwd: worktreePath },
				);
				const trimmed = stdout.trim();
				if (trimmed.length === 0) return [];
				return trimmed.split("\n").map((line) => ({ sha: line.trim() }));
			} catch (err) {
				const stderr = (err as { stderr?: string }).stderr;
				throw new WorktreeError(
					"GIT_FAILED",
					stderr && stderr.length > 0 ? stderr : (err as Error).message,
					err,
				);
			}
		},
		async dispose(): Promise<void> {
			if (disposed) return;
			try {
				await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], {
					cwd: repoPath,
				});
				disposed = true;
				return;
			} catch (err) {
				// "Already gone" path: re-list, swallow if absent. `git worktree
				// list --porcelain` returns realpathed paths and `worktreePath`
				// is already realpathed (set during createWorktree step 3) so
				// the comparison is symmetric on macOS.
				try {
					const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
						cwd: repoPath,
					});
					const entries = parseWorktreeList(stdout);
					const stillThere = entries.some((e) => e.path === worktreePath);
					if (!stillThere) {
						disposed = true;
						return;
					}
				} catch {
					// fall through to throw
				}
				const stderr = (err as { stderr?: string }).stderr;
				throw new WorktreeError(
					"GIT_FAILED",
					stderr && stderr.length > 0 ? stderr : (err as Error).message,
					err,
				);
			}
		},
	};
}

/**
 * Pure parser for `git worktree list --porcelain`. Each entry is separated
 * by one blank line; trailing blank line tolerated. Branch absence (detached)
 * is normalized to `null`. Exported file-private (consumed by createWorktree
 * + tests; not re-exported from src/index.ts).
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	const blocks = stdout.split(/\n\n+/);
	for (const block of blocks) {
		const lines = block.split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) continue;
		let p: string | null = null;
		let branch: string | null = null;
		let prunable = false;
		let locked = false;
		let detached = false;
		for (const line of lines) {
			if (line.startsWith("worktree ")) {
				p = line.slice("worktree ".length);
			} else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length);
				branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			} else if (line === "detached") {
				detached = true;
			} else if (line === "locked" || line.startsWith("locked ")) {
				locked = true;
			} else if (line === "prunable" || line.startsWith("prunable ")) {
				prunable = true;
			}
		}
		if (p !== null) {
			entries.push({ path: p, branch, prunable, locked, detached });
		}
	}
	return entries;
}

type CollisionResult =
	| { kind: "none" }
	| { kind: "managed-reuse"; path: string }
	| { kind: "external"; path: string };

async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
	try {
		const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
			cwd: repoPath,
		});
		return parseWorktreeList(stdout);
	} catch (err) {
		const stderr = (err as { stderr?: string }).stderr;
		throw new WorktreeError(
			"GIT_FAILED",
			stderr && stderr.length > 0 ? stderr : (err as Error).message,
			err,
		);
	}
}

function findCollision(
	entries: WorktreeEntry[],
	branch: string,
	worktreePath: string,
	worktreesDirReal: string,
): CollisionResult {
	for (const entry of entries) {
		if (entry.branch === branch) {
			const inside =
				entry.path === worktreePath || entry.path.startsWith(`${worktreesDirReal}${path.sep}`);
			if (inside) {
				return { kind: "managed-reuse", path: entry.path };
			}
			return { kind: "external", path: entry.path };
		}
	}
	return { kind: "none" };
}

function findStaleManaged(
	entries: WorktreeEntry[],
	branch: string,
	worktreePath: string,
	_worktreesDirReal: string,
): WorktreeEntry[] {
	const stale: WorktreeEntry[] = [];
	for (const entry of entries) {
		if (entry.path !== worktreePath) continue;
		// Same managed path. Stale if prunable, detached, branch null, or wrong branch.
		if (entry.prunable || entry.detached || entry.branch === null || entry.branch !== branch) {
			stale.push(entry);
		}
	}
	return stale;
}
