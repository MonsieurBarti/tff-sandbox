import { describe, expect, it } from "vitest";
import { run } from "../../src/index.js";

describe.skip("e2e: run() with claude-code + docker", () => {
	it("captures commits on the named branch", async () => {
		const result = await run({
			agent: "claude-code",
			sandbox: "docker",
			prompt: "echo hello > out.txt && git add . && git commit -m 'test'",
			branchStrategy: { type: "branch", branch: "agent/smoke" },
		});
		expect(result.branch).toBe("agent/smoke");
		expect(result.commits.length).toBeGreaterThan(0);
		expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
	});
});
