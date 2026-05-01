import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeError } from "../../src/errors.js";

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<{ repoPath: string; cleanup: () => void }> {
	const tmp = mkdtempSync(path.join(tmpdir(), "tff-worktree-"));
	await execFileAsync("git", ["init", "-q", "."], { cwd: tmp });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: tmp });
	await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: tmp });
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

	it.todo("populated by T02+");
});

describe("WorktreeHandle", () => {
	it.todo("populated by T05");
});

// Suppress unused-symbol lint until later tasks consume them
void realpathSync;
