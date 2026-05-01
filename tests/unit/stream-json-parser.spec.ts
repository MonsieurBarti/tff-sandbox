import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStreamParser } from "../../src/agent/stream-json-parser.js";

function loadFixture(name: string): string[] {
	const url = new URL(`../fixtures/stream-json/${name}`, import.meta.url);
	const p = fileURLToPath(url);
	return readFileSync(p, "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
}

function feedAll(lines: string[]) {
	const parser = createStreamParser();
	for (const line of lines) parser.feed(line);
	return parser.finish();
}

describe("createStreamParser", () => {
	it("AC#8: single assistant + result → finalText, truncated:false", () => {
		const r = feedAll(loadFixture("single-turn.ndjson"));
		expect(r).toEqual({ finalText: "hello world", truncated: false });
	});

	it("AC#9: multi-turn with tool blocks → last assistant turn's text only", () => {
		const r = feedAll(loadFixture("multi-turn-with-tools.ndjson"));
		expect(r).toEqual({ finalText: "final answer", truncated: false });
	});

	it("AC#10: stream with no result envelope → truncated:true", () => {
		const r = feedAll(loadFixture("truncated.ndjson"));
		expect(r.truncated).toBe(true);
	});

	it("AC#11: malformed line ignored, valid events still parsed", () => {
		const r = feedAll(loadFixture("malformed-line.ndjson"));
		expect(r).toEqual({ finalText: "survived", truncated: false });
	});

	it("AC#12: zero assistant events but clean result → finalText:'', truncated:false", () => {
		const r = feedAll(loadFixture("empty-assistant.ndjson"));
		expect(r).toEqual({ finalText: "", truncated: false });
	});
});
