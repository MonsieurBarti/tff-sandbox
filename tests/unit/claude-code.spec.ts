import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runClaudeCode } from "../../src/agent/claude-code.js";
import type { ExecOptions, ExecResult, SandboxHandle } from "../../src/sandbox-provider.js";

const execFileAsync = promisify(execFile);

function loadFixture(name: string): string[] {
	const url = new URL(`../fixtures/stream-json/${name}`, import.meta.url);
	return readFileSync(fileURLToPath(url), "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
}

type StubExecCall = { command: string; opts: ExecOptions | undefined };

function stubHandle(behavior: {
	fixture?: string;
	exitCode: number;
}): { handle: SandboxHandle; calls: StubExecCall[] } {
	const calls: StubExecCall[] = [];
	const handle: SandboxHandle = {
		containerName: "stub",
		workspacePath: "/home/tff/workspace",
		async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
			calls.push({ command, opts });
			if (behavior.fixture !== undefined && opts?.onLine !== undefined) {
				for (const line of loadFixture(behavior.fixture)) opts.onLine(line);
			}
			return { stdout: "", stderr: "", exitCode: behavior.exitCode };
		},
		async dispose() {},
		async [Symbol.asyncDispose]() {},
	};
	return { handle, calls };
}

// Per-test isolation of host git layers.
let prevGitGlobal: string | undefined;
let prevGitSystem: string | undefined;
let emptyGitConfig: string;

beforeAll(() => {
	const tmp = mkdtempSync(path.join(tmpdir(), "s04-empty-"));
	emptyGitConfig = path.join(tmp, "empty-gitconfig");
	writeFileSync(emptyGitConfig, "");
});

describe("runClaudeCode (stubbed handle)", () => {
	beforeEach(() => {
		prevGitGlobal = process.env.GIT_CONFIG_GLOBAL;
		prevGitSystem = process.env.GIT_CONFIG_SYSTEM;
	});
	afterEach(() => {
		if (prevGitGlobal === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_GLOBAL");
		else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal;
		if (prevGitSystem === undefined) Reflect.deleteProperty(process.env, "GIT_CONFIG_SYSTEM");
		else process.env.GIT_CONFIG_SYSTEM = prevGitSystem;
	});

	it("AC#2: rejects with GIT_IDENTITY_NOT_CONFIGURED when global identity unset; never invokes exec", async () => {
		process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		const { handle, calls } = stubHandle({ exitCode: 0 });
		await expect(runClaudeCode(handle, "x")).rejects.toMatchObject({
			name: "AgentError",
			code: "GIT_IDENTITY_NOT_CONFIGURED",
		});
		expect(calls).toHaveLength(0);
	});

	it("AC#4: hostWorktreePath with empty effective config rejects; message includes the path; never invokes exec", async () => {
		process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
		process.env.GIT_CONFIG_SYSTEM = "/dev/null";
		const wt = mkdtempSync(path.join(tmpdir(), "s04-wt-empty-"));
		await execFileAsync("git", ["-C", wt, "init"]);
		const { handle, calls } = stubHandle({ exitCode: 0 });
		try {
			await expect(runClaudeCode(handle, "x", { hostWorktreePath: wt })).rejects.toThrow(
				new RegExp(wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			expect(calls).toHaveLength(0);
		} finally {
			rmSync(wt, { recursive: true, force: true });
		}
	});

	describe("with hostWorktreePath identity present (fixture)", () => {
		let wt: string;
		beforeEach(async () => {
			process.env.GIT_CONFIG_GLOBAL = emptyGitConfig;
			process.env.GIT_CONFIG_SYSTEM = "/dev/null";
			wt = mkdtempSync(path.join(tmpdir(), "s04-wt-id-"));
			await execFileAsync("git", ["-C", wt, "init"]);
			await execFileAsync("git", ["-C", wt, "config", "user.name", "O'Brien"]);
			await execFileAsync("git", ["-C", wt, "config", "user.email", "ob@ex.invalid"]);
		});
		afterEach(() => rmSync(wt, { recursive: true, force: true }));

		it("AC#6,#7: prompt via stdin; cwd === workspacePath; env-var prefixes present and shEscape'd; --print --output-format stream-json --verbose --dangerously-skip-permissions; no --prompt", async () => {
			const { handle, calls } = stubHandle({ fixture: "single-turn.ndjson", exitCode: 0 });
			await runClaudeCode(handle, "echo this exact \"weird\" 'prompt'\nmulti-line", {
				hostWorktreePath: wt,
			});
			expect(calls).toHaveLength(1);
			const c = calls[0];
			// Narrow for noUncheckedIndexedAccess.
			if (c === undefined) throw new Error("expected one exec call");
			// Stdin
			expect(c.opts?.stdin).toBe("echo this exact \"weird\" 'prompt'\nmulti-line");
			// Cwd
			expect(c.opts?.cwd).toBe("/home/tff/workspace");
			// Command shape
			expect(c.command).toContain(
				"--print --output-format stream-json --verbose --dangerously-skip-permissions",
			);
			expect(c.command).not.toMatch(/--prompt(\s|$)/);
			// Env prefixes (shEscape'd values for O'Brien must be 'O'\''Brien')
			expect(c.command).toContain("GIT_AUTHOR_NAME='O'\\''Brien'");
			expect(c.command).toContain("GIT_AUTHOR_EMAIL='ob@ex.invalid'");
			expect(c.command).toContain("GIT_COMMITTER_NAME='O'\\''Brien'");
			expect(c.command).toContain("GIT_COMMITTER_EMAIL='ob@ex.invalid'");
		});

		it("AC#13: stub stream + exit 0 → resolves with extracted finalText", async () => {
			const { handle } = stubHandle({ fixture: "single-turn.ndjson", exitCode: 0 });
			const r = await runClaudeCode(handle, "x", { hostWorktreePath: wt });
			expect(r).toEqual({ exitCode: 0, finalText: "hello world" });
		});

		it("AC#14: exit 0 + truncated stream → AgentError STREAM_TRUNCATED", async () => {
			const { handle } = stubHandle({ fixture: "truncated.ndjson", exitCode: 0 });
			await expect(runClaudeCode(handle, "x", { hostWorktreePath: wt })).rejects.toMatchObject({
				name: "AgentError",
				code: "STREAM_TRUNCATED",
			});
		});

		it("AC#15: exit 2 + truncated stream → resolves with exit 2 (no AgentError)", async () => {
			const { handle } = stubHandle({ fixture: "truncated.ndjson", exitCode: 2 });
			const r = await runClaudeCode(handle, "x", { hostWorktreePath: wt });
			expect(r.exitCode).toBe(2);
		});

		it("AC#16: exit 1 + complete stream with is_error:true result → resolves with exit 1, finalText extracted (no AgentError)", async () => {
			const { handle } = stubHandle({ fixture: "result-is-error-true.ndjson", exitCode: 1 });
			const r = await runClaudeCode(handle, "x", { hostWorktreePath: wt });
			expect(r.exitCode).toBe(1);
			expect(r.finalText).toContain("Not logged in");
		});
	});

	it("AC#17: public re-exports from src/index.ts", async () => {
		const mod = await import("../../src/index.js");
		expect(typeof mod.runClaudeCode).toBe("function");
		expect(typeof mod.AgentError).toBe("function");
		// Type-only re-exports (AgentResult, RunClaudeCodeOptions, AgentErrorCode) verified by tsc --noEmit.
	});
});
