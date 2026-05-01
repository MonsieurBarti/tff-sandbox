export type StreamParser = {
	feed(line: string): void;
	finish(): { finalText: string; truncated: boolean };
};

type AssistantEvent = {
	type: "assistant";
	message: { content: unknown[] };
};

type ResultEvent = { type: "result" };

type TextBlock = { type: "text"; text: string };

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object";
}

function isAssistantEvent(v: unknown): v is AssistantEvent {
	if (!isObject(v)) return false;
	if (v.type !== "assistant") return false;
	if (!("message" in v) || !isObject(v.message)) return false;
	if (!("content" in v.message) || !Array.isArray(v.message.content)) return false;
	return true;
}

function isResultEvent(v: unknown): v is ResultEvent {
	return isObject(v) && v.type === "result";
}

function isTextBlock(v: unknown): v is TextBlock {
	return isObject(v) && v.type === "text" && typeof v.text === "string";
}

function extractText(content: unknown[]): string {
	let out = "";
	for (const block of content) {
		if (isTextBlock(block)) out += block.text;
	}
	return out;
}

export function createStreamParser(): StreamParser {
	let lastAssistantText = "";
	let sawResult = false;

	return {
		feed(line: string) {
			if (line.length === 0) return;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				return; // tolerate non-JSON debug noise
			}
			if (isAssistantEvent(parsed)) {
				lastAssistantText = extractText(parsed.message.content);
				return;
			}
			if (isResultEvent(parsed)) {
				sawResult = true;
			}
		},
		finish() {
			return { finalText: lastAssistantText, truncated: !sawResult };
		},
	};
}
