import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { docker } from "../../src/docker.js";
import { SandboxError } from "../../src/errors.js";

const execFileAsync = promisify(execFile);

let skipAll = false;

beforeAll(async () => {
	try {
		await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
	} catch (e) {
		skipAll = true;
		console.warn(`tff-sandbox: docker daemon unavailable, skipping suite — ${String(e)}`);
	}
	// T06 will extend this with the image pre-warm + coldBuildBudget capture.
});

async function makeWorkRepo(): Promise<{ dir: string; cleanup: () => void }> {
	const dir = mkdtempSync(path.join(tmpdir(), "tff-s03-repo-"));
	await execFileAsync("git", ["init", "-q", "."], { cwd: dir });
	await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
	await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
	return {
		dir,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

// Used by later tasks — silence unused-symbol lint here.
void makeWorkRepo;
void afterAll;
void afterEach;
void beforeEach;
void vi;
void fsp;
void statSync;

const dockerfilePath = fileURLToPath(
	new URL("../../runtime/claude-code/Dockerfile", import.meta.url),
);

describe("bundled Dockerfile", () => {
	it("pins node:22-bookworm to the captured manifest-list digest", () => {
		const contents = readFileSync(dockerfilePath, "utf8");
		expect(contents).toMatch(
			/^FROM node:22-bookworm@sha256:9059d9d7db987b86299e052ff6630cd95e5a770336967c21110e53289a877433$/m,
		);
	});

	it("has the IMPORTANT context-free maintainer comment", () => {
		const contents = readFileSync(dockerfilePath, "utf8");
		expect(contents).toMatch(/IMPORTANT:.*context-free.*no COPY\/ADD/i);
	});

	it("renames node user to tff and chmods $HOME 0777", () => {
		const contents = readFileSync(dockerfilePath, "utf8");
		expect(contents).toMatch(/usermod -d \/home\/tff -m -l tff node/);
		expect(contents).toMatch(/chmod 0777 \/home\/tff/);
	});

	it("uses sleep infinity ENTRYPOINT", () => {
		const contents = readFileSync(dockerfilePath, "utf8");
		expect(contents).toMatch(/ENTRYPOINT \["sleep", "infinity"\]/);
	});

	it("sets HOME=/home/tff and WORKDIR /home/tff", () => {
		const contents = readFileSync(dockerfilePath, "utf8");
		expect(contents).toMatch(/ENV HOME="\/home\/tff"/);
		expect(contents).toMatch(/WORKDIR \/home\/tff/);
	});

	it("ships in the published tarball via package.json#files", () => {
		const pkg = JSON.parse(
			readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
		);
		expect(Array.isArray(pkg.files)).toBe(true);
		expect(pkg.files).toContain("runtime");
	});
});

describe("SandboxError", () => {
	it("carries code, message, optional cause and name === 'SandboxError'", () => {
		const cause = new Error("boom");
		const err = new SandboxError("DOCKER_UNAVAILABLE", "daemon down", cause);
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe("SandboxError");
		expect(err.code).toBe("DOCKER_UNAVAILABLE");
		expect(err.message).toBe("daemon down");
		expect(err.cause).toBe(cause);
	});

	it("omits cause when none provided", () => {
		const err = new SandboxError("INVALID_OPTIONS", "bad input");
		expect(err.cause).toBeUndefined();
	});

	it("does not collide with WorktreeError", async () => {
		const { WorktreeError } = await import("../../src/errors.js");
		const wte = new WorktreeError("REPO_NOT_FOUND", "x");
		const sbe = new SandboxError("DOCKER_UNAVAILABLE", "y");
		expect(wte).not.toBeInstanceOf(SandboxError);
		expect(sbe).not.toBeInstanceOf(WorktreeError);
	});
});

describe("docker() factory", () => {
	it("returns a SandboxProvider with name === 'docker' and start()", () => {
		const provider = docker();
		expect(provider.name).toBe("docker");
		expect(typeof provider.start).toBe("function");
	});

	it("rejects synchronously with INVALID_OPTIONS when imageName is set without shareClaudeConfig: false", async () => {
		const provider = docker({ imageName: "custom:latest" });
		await expect(provider.start({ worktreePath: "/tmp" })).rejects.toMatchObject({
			name: "SandboxError",
			code: "INVALID_OPTIONS",
		});
	});

	it("accepts imageName when shareClaudeConfig is explicitly false (does not throw INVALID_OPTIONS)", async () => {
		const provider = docker({ imageName: "custom:latest", shareClaudeConfig: false });
		const err = await provider.start({ worktreePath: "/nonexistent-tff-fixture" }).catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err.code).not.toBe("INVALID_OPTIONS");
	});
});

describe("sandbox-provider interfaces (compile-time)", () => {
	it("module loads at runtime", async () => {
		const mod = await import("../../src/sandbox-provider.js");
		expect(typeof mod).toBe("object");
	});

	it("a structural conformance object satisfies SandboxHandle", () => {
		const handle: import("../../src/sandbox-provider.js").SandboxHandle = {
			containerName: "tff-sandbox-00000000-0000-0000-0000-000000000000",
			workspacePath: "/home/tff/workspace",
			async exec() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
			async dispose() {
				return;
			},
			async [Symbol.asyncDispose]() {
				return;
			},
		};
		expect(handle.workspacePath).toBe("/home/tff/workspace");
	});
});

describe("validation (real daemon)", () => {
	it("rejects with WORKTREE_NOT_FOUND when worktreePath does not exist", async () => {
		if (skipAll) return;
		const provider = docker();
		const err = await provider
			.start({ worktreePath: "/this/path/does/not/exist/tff-s03" })
			.catch((e) => e);
		expect(err).toBeInstanceOf(SandboxError);
		expect(err.code).toBe("WORKTREE_NOT_FOUND");
		expect(err.message).toContain(path.resolve("/this/path/does/not/exist/tff-s03"));
	});

	it("rejects with WORKTREE_NOT_FOUND when worktreePath is a file, not a directory", async () => {
		if (skipAll) return;
		const f = path.join(mkdtempSync(path.join(tmpdir(), "tff-s03-")), "afile");
		await fsp.writeFile(f, "x");
		const provider = docker();
		const err = await provider.start({ worktreePath: f }).catch((e) => e);
		expect(err).toBeInstanceOf(SandboxError);
		expect(err.code).toBe("WORKTREE_NOT_FOUND");
	});
});

describe("public surface", () => {
	it("AC#32: re-exports the full S03 surface at runtime", async () => {
		const mod = await import("../../src/index.js");
		expect(typeof mod.docker).toBe("function");
		expect(typeof mod.SandboxError).toBe("function");
	});

	it("AC#32 (compile-time): type-only re-exports are observable via import-type", () => {
		// If any of these named types goes missing from src/index.ts,
		// tsc rejects this binding. The runtime body is a placeholder.
		const _typecheck: {
			provider: import("../../src/index.js").SandboxProvider;
			handle: import("../../src/index.js").SandboxHandle;
			start: import("../../src/index.js").StartOptions;
			exec: import("../../src/index.js").ExecOptions;
			result: import("../../src/index.js").ExecResult;
			dockerOpts: import("../../src/index.js").DockerOptions;
			errCode: import("../../src/index.js").SandboxErrorCode;
		} | null = null;
		expect(_typecheck).toBeNull();
	});

	it("AC#32: RunOptions.sandbox is a SandboxProvider (not the old SandboxKind literal)", async () => {
		const mod = await import("../../src/index.js");
		const runOpts: import("../../src/index.js").RunOptions = {
			agent: "claude-code",
			sandbox: mod.docker(),
			prompt: "hi",
			branchStrategy: { type: "branch", branch: "agent/x" },
		};
		expect(runOpts.sandbox.name).toBe("docker");
	});
});
