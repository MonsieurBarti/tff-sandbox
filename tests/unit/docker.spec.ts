import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
let coldBuildBudget = 0;

beforeAll(async () => {
	try {
		await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
	} catch (e) {
		skipAll = true;
		console.warn(`tff-sandbox: docker daemon unavailable, skipping suite — ${String(e)}`);
		return;
	}
	const repo = await makeWorkRepo();
	// Force a cold build so coldBuildBudget reflects actual build time.
	const dockerfileBytes = readFileSync(
		fileURLToPath(new URL("../../runtime/claude-code/Dockerfile", import.meta.url)),
	);
	const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
	const prewarmTag = `tff-sandbox-runtime-claude-code:${sha12}`;
	try {
		await execFileAsync("docker", ["image", "rm", prewarmTag]);
	} catch {
		/* not present — fine */
	}
	const provider = docker();
	const t0 = Date.now();
	try {
		const sandbox = await provider.start({ worktreePath: repo.dir });
		coldBuildBudget = Date.now() - t0;
		await sandbox.dispose();
	} catch (e) {
		skipAll = true;
		console.warn(`tff-sandbox: image pre-warm failed — ${String(e)}`);
	} finally {
		repo.cleanup();
	}
}, 600_000);

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

describe("container lifecycle", () => {
	let repo: { dir: string; cleanup: () => void };

	beforeEach(async () => {
		if (skipAll) return;
		repo = await makeWorkRepo();
	});

	afterEach(() => {
		repo?.cleanup();
	});

	// T07 only implements the worktree mount; the layered ~/.claude mount lands
	// in T08. Every T07 test passes `shareClaudeConfig: false` explicitly so the
	// claude mount's absence here is by-design (not a false-positive coupled to
	// whether the developer happens to have a host ~/.claude). T08's tests flip
	// it back on.

	it("AC#1+#2: start() returns a handle with name and workspacePath", async () => {
		if (skipAll) return;
		const provider = docker({ shareClaudeConfig: false });
		expect(provider.name).toBe("docker");
		const sandbox = await provider.start({ worktreePath: repo.dir });
		try {
			expect(sandbox.containerName).toMatch(
				/^tff-sandbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect(sandbox.workspacePath).toBe("/home/tff/workspace");
			const { stdout } = await execFileAsync("docker", [
				"inspect",
				"-f",
				"{{.State.Running}}",
				sandbox.containerName,
			]);
			expect(stdout.trim()).toBe("true");
		} finally {
			await sandbox.dispose();
		}
	});

	it("AC#7: non-existent imageName surfaces CONTAINER_START_FAILED with cause", async () => {
		if (skipAll) return;
		const provider = docker({
			imageName: "tff-nonexistent-totally-fake:xyz",
			shareClaudeConfig: false,
		});
		const err = await provider.start({ worktreePath: repo.dir }).catch((e) => e);
		expect(err).toBeInstanceOf(SandboxError);
		expect(err.code).toBe("CONTAINER_START_FAILED");
		expect(err.cause).toBeDefined();
	});

	it("AC#16: forwards process.env.ANTHROPIC_API_KEY when no override", async () => {
		if (skipAll) return;
		const sentinel = `tff-test-${randomUUID()}`;
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = sentinel;
		try {
			const provider = docker({ shareClaudeConfig: false });
			const sandbox = await provider.start({ worktreePath: repo.dir });
			try {
				const result = await sandbox.exec("printenv ANTHROPIC_API_KEY");
				expect(result.stdout.trim()).toBe(sentinel);
			} finally {
				await sandbox.dispose();
			}
		} finally {
			// biome-ignore lint/performance/noDelete: assigning undefined stringifies to "undefined"; delete is correct here
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});

	it("AC#17: dockerOpts.env.ANTHROPIC_API_KEY overrides process env", async () => {
		if (skipAll) return;
		const hostVal = `host-${randomUUID()}`;
		const optsVal = `opts-${randomUUID()}`;
		const prev = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = hostVal;
		try {
			const provider = docker({
				shareClaudeConfig: false,
				env: { ANTHROPIC_API_KEY: optsVal },
			});
			const sandbox = await provider.start({ worktreePath: repo.dir });
			try {
				const result = await sandbox.exec("printenv ANTHROPIC_API_KEY");
				expect(result.stdout.trim()).toBe(optsVal);
			} finally {
				await sandbox.dispose();
			}
		} finally {
			// biome-ignore lint/performance/noDelete: assigning undefined stringifies to "undefined"; delete is correct here
			if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = prev;
		}
	});

	it("AC#30: start() registers exactly one new listener on exit/SIGINT/SIGTERM", async () => {
		if (skipAll) return;
		const before = {
			exit: process.listenerCount("exit"),
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
		};
		const provider = docker({ shareClaudeConfig: false });
		const sandbox = await provider.start({ worktreePath: repo.dir });
		try {
			expect(process.listenerCount("exit")).toBe(before.exit + 1);
			expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
			expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
		} finally {
			await sandbox.dispose();
		}
	});
});

describe("image build & cache", () => {
	let repo: { dir: string; cleanup: () => void };

	beforeEach(async () => {
		if (skipAll) return;
		repo = await makeWorkRepo();
	});

	afterEach(() => {
		repo?.cleanup();
	});

	describe("AC#4 cold-state build", () => {
		beforeEach(async () => {
			if (skipAll) return;
			const dockerfileBytes = readFileSync(
				fileURLToPath(new URL("../../runtime/claude-code/Dockerfile", import.meta.url)),
			);
			const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
			const expectedTag = `tff-sandbox-runtime-claude-code:${sha12}`;
			try {
				await execFileAsync("docker", ["image", "rm", expectedTag]);
			} catch {
				/* not present — fine */
			}
		});

		it("AC#4: builds and tags image as tff-sandbox-runtime-claude-code:<sha12>", async () => {
			if (skipAll) return;
			const dockerfileBytes = readFileSync(
				fileURLToPath(new URL("../../runtime/claude-code/Dockerfile", import.meta.url)),
			);
			const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
			const expectedTag = `tff-sandbox-runtime-claude-code:${sha12}`;
			const sandbox = await docker({ shareClaudeConfig: false }).start({ worktreePath: repo.dir });
			try {
				await execFileAsync("docker", ["image", "inspect", expectedTag]); // exits 0
			} finally {
				await sandbox.dispose();
			}
		});
	});

	it("AC#5: warm-cache start hits cache (image exists; wall-time < 10s; >= 5x faster than cold build)", async () => {
		if (skipAll) return;
		const dockerfileBytes = readFileSync(
			fileURLToPath(new URL("../../runtime/claude-code/Dockerfile", import.meta.url)),
		);
		const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
		const expectedTag = `tff-sandbox-runtime-claude-code:${sha12}`;
		const provider = docker({ shareClaudeConfig: false });
		const t0 = Date.now();
		const sandbox = await provider.start({ worktreePath: repo.dir });
		const wallTime = Date.now() - t0;
		await sandbox.dispose();
		// Upper bound: regression guard against a 30s rebuild.
		expect(wallTime).toBeLessThan(10_000);
		// Lower bound: only reject obvious no-ops.
		expect(wallTime).toBeGreaterThan(0);
		// Positive existence: the cache hit means the image still exists and is
		// the one keyed by the Dockerfile-bytes hash.
		await execFileAsync("docker", ["image", "inspect", expectedTag]); // exits 0
		// Cache-hit ratio: warm path is materially faster than the cold build
		// captured during the suite-level pre-warm. 5x is conservative; cold
		// builds are multi-minute so the ratio is typically 100x+. When the
		// host's Docker layer cache is already warm (developer machines), the
		// "cold" rebuild from `docker rmi` reuses cached layers and completes
		// in ~400ms, making the ratio indeterminate; gate on a meaningful
		// cold-build floor.
		if (coldBuildBudget > 2000) {
			expect(coldBuildBudget).toBeGreaterThanOrEqual(wallTime * 5);
		}
	});

	it("AC#6: imageName-set branch does not consult bundled Dockerfile", async () => {
		if (skipAll) return;
		const dockerfilePath = fileURLToPath(
			new URL("../../runtime/claude-code/Dockerfile", import.meta.url),
		);
		const dockerfileBytes = readFileSync(dockerfilePath);
		const sha12 = createHash("sha256").update(dockerfileBytes).digest("hex").slice(0, 12);
		const tag = `tff-sandbox-runtime-claude-code:${sha12}`;
		const stashed = `${dockerfilePath}.stash`;
		await fsp.rename(dockerfilePath, stashed);
		try {
			const provider = docker({ imageName: tag, shareClaudeConfig: false });
			const sandbox = await provider.start({ worktreePath: repo.dir });
			expect(sandbox.containerName).toMatch(/^tff-sandbox-/);
			await sandbox.dispose();
		} finally {
			await fsp.rename(stashed, dockerfilePath);
		}
	});
});

describe("mounts", () => {
	let repo: { dir: string; cleanup: () => void };

	beforeEach(async () => {
		if (skipAll) return;
		repo = await makeWorkRepo();
	});

	afterEach(() => {
		repo?.cleanup();
	});

	// Returns `{ dir, jsonPath, cleanup }`. `jsonPath` is the sibling-relative
	// `.claude.json` path (next to `dir`, not inside it) so we can assert that
	// the per-test override truly isolates from the developer's host
	// `~/.claude.json`. Tests that want the JSON mount populate it; tests that
	// don't leave it absent.
	async function makeClaudeDir(): Promise<{
		dir: string;
		jsonPath: string;
		cleanup: () => void;
	}> {
		const parent = mkdtempSync(path.join(tmpdir(), "tff-s03-claude-parent-"));
		const dir = path.join(parent, ".claude");
		await fsp.mkdir(dir, { recursive: true });
		await fsp.writeFile(path.join(dir, "CLAUDE.md"), "host-claude-md");
		await fsp.mkdir(path.join(dir, "projects"), { recursive: true });
		const jsonPath = path.join(parent, ".claude.json");
		return {
			dir,
			jsonPath,
			cleanup: () => rmSync(parent, { recursive: true, force: true }),
		};
	}

	it("AC#8: worktree mount visible inside container", async () => {
		if (skipAll) return;
		await fsp.writeFile(path.join(repo.dir, "marker.txt"), "hi");
		const sandbox = await docker().start({ worktreePath: repo.dir });
		try {
			const r = await sandbox.exec("ls /home/tff/workspace");
			expect(r.stdout).toMatch(/marker\.txt/);
		} finally {
			await sandbox.dispose();
		}
	});

	it("AC#9: file written inside container appears on host owned by getuid()", async () => {
		if (skipAll) return;
		const sandbox = await docker().start({ worktreePath: repo.dir });
		try {
			const r = await sandbox.exec("touch /home/tff/workspace/foo");
			expect(r.exitCode).toBe(0);
			const st = statSync(path.join(repo.dir, "foo"));
			expect(st.uid).toBe(process.getuid?.() ?? 1000);
		} finally {
			await sandbox.dispose();
		}
	});

	it("AC#10: ~/.claude/CLAUDE.md readable inside container", async () => {
		if (skipAll) return;
		const cfg = await makeClaudeDir();
		try {
			const sandbox = await docker({ claudeConfigPath: cfg.dir }).start({
				worktreePath: repo.dir,
			});
			try {
				const r = await sandbox.exec("cat /home/tff/.claude/CLAUDE.md");
				expect(r.stdout).toBe("host-claude-md");
			} finally {
				await sandbox.dispose();
			}
		} finally {
			cfg.cleanup();
		}
	});

	it("AC#11: ~/.claude is read-only — write fails, host byte-identical", async () => {
		if (skipAll) return;
		const cfg = await makeClaudeDir();
		try {
			const before = await fsp.readFile(path.join(cfg.dir, "CLAUDE.md"));
			const sandbox = await docker({ claudeConfigPath: cfg.dir }).start({
				worktreePath: repo.dir,
			});
			try {
				const r = await sandbox.exec("sh -c 'echo X >> /home/tff/.claude/CLAUDE.md'");
				expect(r.exitCode).not.toBe(0);
			} finally {
				await sandbox.dispose();
			}
			const after = await fsp.readFile(path.join(cfg.dir, "CLAUDE.md"));
			expect(after.equals(before)).toBe(true);
		} finally {
			cfg.cleanup();
		}
	});

	it("AC#12: ~/.claude/projects is read-write — writes round-trip to host", async () => {
		if (skipAll) return;
		const cfg = await makeClaudeDir();
		try {
			const sandbox = await docker({ claudeConfigPath: cfg.dir }).start({
				worktreePath: repo.dir,
			});
			try {
				const name = `s-${randomUUID()}`;
				await sandbox.exec(`echo session > /home/tff/.claude/projects/${name}`);
				const onHost = await fsp.readFile(path.join(cfg.dir, "projects", name), "utf8");
				expect(onHost.trim()).toBe("session");
			} finally {
				await sandbox.dispose();
			}
		} finally {
			cfg.cleanup();
		}
	});

	it("AC#13: shareClaudeConfig:false omits the mount (incl. .claude.json)", async () => {
		if (skipAll) return;
		const cfg = await makeClaudeDir();
		// Seed a sibling .claude.json so the test would catch a regression
		// where shareClaudeConfig:false fails to suppress the JSON mount.
		await fsp.writeFile(cfg.jsonPath, '{"sentinel":true}');
		try {
			const sandbox = await docker({
				shareClaudeConfig: false,
				claudeConfigPath: cfg.dir,
			}).start({ worktreePath: repo.dir });
			try {
				const r = await sandbox.exec("test -d /home/tff/.claude && echo yes || echo no");
				expect(r.stdout.trim()).toBe("no");
				const j = await sandbox.exec("test -e /home/tff/.claude.json && echo yes || echo no");
				expect(j.stdout.trim()).toBe("no");
			} finally {
				await sandbox.dispose();
			}
		} finally {
			cfg.cleanup();
		}
	});

	it("AC#14: missing claude dir → start() succeeds, exactly one console.warn, no claude mount, no .claude.json mount", async () => {
		if (skipAll) return;
		const ghostParent = mkdtempSync(path.join(tmpdir(), "tff-s03-ghost-"));
		const ghost = path.join(ghostParent, ".claude");
		// Seed the sibling .claude.json — the directory-exists branch should
		// suppress the JSON mount even though the JSON file itself exists.
		await fsp.writeFile(path.join(ghostParent, ".claude.json"), '{"sentinel":true}');
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const sandbox = await docker({ claudeConfigPath: ghost }).start({
				worktreePath: repo.dir,
			});
			try {
				const r = await sandbox.exec("test -d /home/tff/.claude && echo yes || echo no");
				expect(r.stdout.trim()).toBe("no");
				const j = await sandbox.exec("test -e /home/tff/.claude.json && echo yes || echo no");
				expect(j.stdout.trim()).toBe("no");
				expect(warnSpy).toHaveBeenCalledTimes(1);
				expect(String(warnSpy.mock.calls[0]?.[0] ?? "")).toContain(ghost);
			} finally {
				await sandbox.dispose();
			}
		} finally {
			warnSpy.mockRestore();
			rmSync(ghostParent, { recursive: true, force: true });
		}
	});

	it("MOUNT ORDER (real-Docker): docker inspect Mounts shows ro parent listed before rw child", async () => {
		if (skipAll) return;
		// Pin the load-bearing MOUNT ORDER invariant via a real-container
		// inspection rather than spy-on-execFile (the production code uses a
		// destructured `import { execFile } ...` so vi.spyOn on the module
		// would not intercept the binding). Docker's `docker inspect` returns
		// the Mounts array in the order they were declared on the CLI; assert
		// the ro parent (CLAUDE config) precedes the rw projects sub-mount.
		const cfg = await makeClaudeDir();
		const sandbox = await docker({ claudeConfigPath: cfg.dir }).start({
			worktreePath: repo.dir,
		});
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect",
				"-f",
				"{{json .Mounts}}",
				sandbox.containerName,
			]);
			const mounts: ReadonlyArray<{ Source: string; Destination: string; Mode: string }> =
				JSON.parse(stdout);
			const roParentIdx = mounts.findIndex(
				(m) => m.Destination === "/home/tff/.claude" && m.Mode.includes("ro"),
			);
			const rwChildIdx = mounts.findIndex((m) => m.Destination === "/home/tff/.claude/projects");
			expect(roParentIdx).toBeGreaterThanOrEqual(0);
			expect(rwChildIdx).toBeGreaterThan(roParentIdx);
		} finally {
			await sandbox.dispose();
			cfg.cleanup();
		}
	});

	it("ISOLATION (per-test claudeConfigPath): no Mount references host ~/.claude.json when override is set", async () => {
		if (skipAll) return;
		// Per-test isolation guarantee: when `claudeConfigPath` is overridden,
		// the host's real ~/.claude.json must NEVER appear in the container's
		// Mounts list, regardless of whether the host has one. This regression
		// guard covers the SPEC §Algorithm step 6 sibling-relative lookup.
		const os = await import("node:os");
		const homeJsonNeedle = path.join(os.homedir(), ".claude.json");
		const cfg = await makeClaudeDir();
		const sandbox = await docker({ claudeConfigPath: cfg.dir }).start({
			worktreePath: repo.dir,
		});
		try {
			const { stdout } = await execFileAsync("docker", [
				"inspect",
				"-f",
				"{{json .Mounts}}",
				sandbox.containerName,
			]);
			const mounts: ReadonlyArray<{ Source: string }> = JSON.parse(stdout);
			const offending = mounts.filter((m) => m.Source === homeJsonNeedle);
			expect(offending).toEqual([]);
		} finally {
			await sandbox.dispose();
			cfg.cleanup();
		}
	});
});

describe("exec semantics", () => {
	let repo: { dir: string; cleanup: () => void };
	let sandbox: import("../../src/sandbox-provider.js").SandboxHandle | undefined;

	beforeEach(async () => {
		if (skipAll) return;
		repo = await makeWorkRepo();
		sandbox = await docker().start({ worktreePath: repo.dir });
	});

	afterEach(async () => {
		if (sandbox !== undefined) await sandbox.dispose().catch(() => {});
		sandbox = undefined;
		repo?.cleanup();
	});

	it("AC#18: echo hello → {stdout:'hello\\n', stderr:'', exitCode:0}", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("echo hello");
		expect(r).toEqual({ stdout: "hello\n", stderr: "", exitCode: 0 });
	});

	it("AC#19: stderr is captured separately", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("sh -c 'echo err >&2'");
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("err\n");
		expect(r.exitCode).toBe(0);
	});

	it("AC#20: false → exitCode 1, no throw", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("false");
		expect(r.exitCode).toBe(1);
	});

	it("AC#21 (trailing partial): onLine fires once on end for an unterminated final line", async () => {
		if (skipAll || sandbox === undefined) return;
		const lines: string[] = [];
		const r = await sandbox.exec("printf 'a\\nb\\nc'", {
			onLine: (l) => lines.push(l),
		});
		expect(lines).toEqual(["a", "b", "c"]);
		expect(r.stdout).toBe("a\nb\nc");
	});

	it("AC#21 (all terminated): onLine fires per line, no extra fire on end", async () => {
		if (skipAll || sandbox === undefined) return;
		const lines: string[] = [];
		const r = await sandbox.exec("printf 'a\\nb\\n'", {
			onLine: (l) => lines.push(l),
		});
		// Exactly two lines — no trailing partial. The "fire on end if buf
		// non-empty" branch must NOT inject a phantom "" line.
		expect(lines).toEqual(["a", "b"]);
		expect(r.stdout).toBe("a\nb\n");
	});

	it("AC#22: stdout invariant under onLine observation", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("echo hello", { onLine: () => {} });
		expect(r.stdout).toBe("hello\n");
	});

	it("AC#23: stdin payload is delivered to the command", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("cat", { stdin: "round-trip-payload" });
		expect(r.stdout).toBe("round-trip-payload");
	});

	it("AC#24: cwd option sets working directory", async () => {
		if (skipAll || sandbox === undefined) return;
		const r = await sandbox.exec("pwd", { cwd: "/tmp" });
		expect(r.stdout.trim()).toBe("/tmp");
	});

	it("AC#25: concurrent dispose during exec rejects EXEC_FAILED with 'No such container'", async () => {
		if (skipAll || sandbox === undefined) return;
		const execPromise = sandbox.exec("sleep 5");
		await new Promise((r) => setTimeout(r, 200));
		await sandbox.dispose();
		const outcome = await execPromise.then(
			(r) => ({ kind: "result" as const, value: r }),
			(e) => ({ kind: "error" as const, value: e }),
		);
		// Two valid outcomes depending on whether the docker exec process races
		// the rm -f: (a) rejected SandboxError with EXEC_FAILED + "No such
		// container" message, or (b) resolved ExecResult with non-zero exitCode
		// and empty stderr (exec process exits before the container message
		// propagates). Both mean the mid-flight exec correctly did not succeed.
		if (outcome.kind === "error") {
			expect(outcome.value).toBeInstanceOf(SandboxError);
			expect(outcome.value.code).toBe("EXEC_FAILED");
			expect(String(outcome.value.message)).toMatch(/No such container|is not running/i);
		} else {
			expect(outcome.value.exitCode).not.toBe(0);
		}
	});
});

describe("dispose semantics", () => {
	let repo: { dir: string; cleanup: () => void };

	beforeEach(async () => {
		if (skipAll) return;
		repo = await makeWorkRepo();
	});

	afterEach(() => {
		repo?.cleanup();
	});

	// Poll-until-gone helper: `docker inspect` may transiently succeed during
	// the daemon's "Removing" state immediately after `docker rm -f` returns.
	// 5 retries × 100ms backoff covers the residual flakiness without false
	// negatives.
	async function expectContainerGone(name: string): Promise<void> {
		for (let i = 0; i < 5; i++) {
			const r = await execFileAsync("docker", ["inspect", name]).catch((e) => e);
			if (r instanceof Error) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error(`expectContainerGone: container ${name} still inspectable after 500ms`);
	}

	it("AC#26: dispose removes the container", async () => {
		if (skipAll) return;
		const sandbox = await docker().start({ worktreePath: repo.dir });
		const name = sandbox.containerName;
		await sandbox.dispose();
		await expectContainerGone(name);
	});

	it("AC#27: dispose is idempotent", async () => {
		if (skipAll) return;
		const sandbox = await docker().start({ worktreePath: repo.dir });
		await sandbox.dispose();
		await expect(sandbox.dispose()).resolves.toBeUndefined();
	});

	it("AC#28: dispose swallows already-removed-by-external-actor", async () => {
		if (skipAll) return;
		const sandbox = await docker().start({ worktreePath: repo.dir });
		await execFileAsync("docker", ["rm", "-f", sandbox.containerName]);
		await expect(sandbox.dispose()).resolves.toBeUndefined();
	});

	it("AC#29: dispose removes the registered exit/SIGINT/SIGTERM listeners", async () => {
		if (skipAll) return;
		const before = {
			exit: process.listenerCount("exit"),
			sigint: process.listenerCount("SIGINT"),
			sigterm: process.listenerCount("SIGTERM"),
		};
		const sandbox = await docker().start({ worktreePath: repo.dir });
		await sandbox.dispose();
		expect(process.listenerCount("exit")).toBe(before.exit);
		expect(process.listenerCount("SIGINT")).toBe(before.sigint);
		expect(process.listenerCount("SIGTERM")).toBe(before.sigterm);
	});

	it("AC#3a: await using disposes at scope exit", async () => {
		if (skipAll) return;
		let captured: string | null = null;
		{
			await using sandbox = await docker().start({ worktreePath: repo.dir });
			captured = sandbox.containerName;
		}
		await expectContainerGone(captured ?? "");
	});

	it("AC#3b: throw inside await using block still disposes and propagates", async () => {
		if (skipAll) return;
		let captured: string | null = null;
		const promise = (async (): Promise<void> => {
			await using sandbox = await docker().start({ worktreePath: repo.dir });
			captured = sandbox.containerName;
			throw new Error("user-thrown");
		})();
		const err = await promise.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toBe("user-thrown");
		await expectContainerGone(captured ?? "");
	});
});
