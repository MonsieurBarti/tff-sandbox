import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { docker } from "../../src/docker.js";
import { SandboxError } from "../../src/errors.js";

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
