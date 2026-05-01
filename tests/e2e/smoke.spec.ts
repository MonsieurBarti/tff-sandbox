import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docker, run } from "../../src/index.js";

const execFileP = promisify(execFile);
const RUN_E2E = process.env.ANTHROPIC_API_KEY !== undefined;

describe.skipIf(!RUN_E2E)("e2e: run() with claude-code + docker", () => {
	let repoPath: string;

	beforeEach(async () => {
		repoPath = mkdtempSync(path.join(tmpdir(), "tff-sandbox-e2e-"));
		await execFileP("git", ["init", "-b", "main"], { cwd: repoPath });
		await execFileP("git", ["config", "user.email", "e2e@tff.local"], { cwd: repoPath });
		await execFileP("git", ["config", "user.name", "tff e2e"], { cwd: repoPath });
		await execFileP("sh", ["-c", "echo '# e2e' > README.md && git add . && git commit -m 'init'"], {
			cwd: repoPath,
		});
	});

	afterEach(() => {
		if (repoPath !== undefined) rmSync(repoPath, { recursive: true, force: true });
	});

	it("captures commits on the named branch", async () => {
		const branch = `agent/smoke-${Date.now()}`;
		const result = await run({
			agent: "claude-code",
			sandbox: docker(),
			prompt:
				"Create a file named out.txt containing the single word 'hello'. " +
				"Then run: git add out.txt && git commit -m 'add out.txt'.",
			branchStrategy: { type: "branch", branch },
			repoPath,
		});

		expect(result.branch).toBe(branch);
		expect(result.commits.length).toBeGreaterThan(0);
		expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);

		const { stdout: log } = await execFileP("git", ["log", branch, "--format=%H %s"], {
			cwd: repoPath,
		});
		expect(log).toContain(result.commits[0]?.sha ?? "");
		expect(log).toMatch(/add out\.txt/);
	}, 120_000);
});
