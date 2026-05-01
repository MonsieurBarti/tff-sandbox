import { describe, expect, it } from "vitest";
import { run } from "../../src/index.js";

describe("run", () => {
	it("throws not-implemented for valid inputs", async () => {
		await expect(
			run({
				agent: "claude-code",
				sandbox: "docker",
				prompt: "noop",
				branchStrategy: { type: "branch", branch: "agent/test" },
			}),
		).rejects.toThrow(/not implemented/);
	});
});
