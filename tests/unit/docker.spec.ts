import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
