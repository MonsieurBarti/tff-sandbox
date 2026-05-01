import { describe, expect, it } from "vitest";
import { AgentError, type AgentErrorCode } from "../../src/index.js";

describe("AgentError", () => {
	it("carries code, message, name, and optional cause", () => {
		const err = new AgentError("STREAM_TRUNCATED", "x");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(AgentError);
		expect(err.name).toBe("AgentError");
		expect(err.code).toBe("STREAM_TRUNCATED");
		expect(err.message).toBe("x");
		expect(err.cause).toBeUndefined();
	});

	it("preserves cause when provided", () => {
		const inner = new Error("inner");
		const err = new AgentError("GIT_IDENTITY_NOT_CONFIGURED", "y", inner);
		expect(err.cause).toBe(inner);
	});

	it("AgentErrorCode is a string-literal union (compile-time check)", () => {
		const codes: AgentErrorCode[] = ["GIT_IDENTITY_NOT_CONFIGURED", "STREAM_TRUNCATED"];
		expect(codes).toHaveLength(2);
	});
});
