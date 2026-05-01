import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentError } from "../errors.js";
import type { SandboxHandle } from "../sandbox-provider.js";
import { createStreamParser } from "./stream-json-parser.js";

const execFileAsync = promisify(execFile);

export type AgentResult = {
	exitCode: number;
	finalText: string;
};

export type RunClaudeCodeOptions = {
	hostWorktreePath?: string;
};

const shEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

type IdentityReadResult = { ok: true; value: string } | { ok: false };

async function readGitField(args: string[]): Promise<IdentityReadResult> {
	try {
		const { stdout } = await execFileAsync("git", args);
		const trimmed = stdout.trim();
		if (trimmed.length === 0) return { ok: false };
		return { ok: true, value: trimmed };
	} catch (err) {
		// Re-throw ENOENT (git binary missing) — that's not a config issue.
		if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			throw err;
		}
		return { ok: false };
	}
}

type Identity = { name: string; email: string };

async function resolveIdentity(opts: RunClaudeCodeOptions | undefined): Promise<Identity> {
	if (opts?.hostWorktreePath !== undefined) {
		const worktreePath = opts.hostWorktreePath;
		const email = await readGitField(["-C", worktreePath, "config", "user.email"]);
		const name = await readGitField(["-C", worktreePath, "config", "user.name"]);
		if (!email.ok) {
			throw new AgentError(
				"GIT_IDENTITY_NOT_CONFIGURED",
				`no effective 'git config user.email' for worktree ${worktreePath}; configure with: git -C ${worktreePath} config user.email <value> (or set --global)`,
			);
		}
		if (!name.ok) {
			throw new AgentError(
				"GIT_IDENTITY_NOT_CONFIGURED",
				`no effective 'git config user.name' for worktree ${worktreePath}; configure with: git -C ${worktreePath} config user.name <value> (or set --global)`,
			);
		}
		return { name: name.value, email: email.value };
	}
	const email = await readGitField(["config", "--global", "user.email"]);
	const name = await readGitField(["config", "--global", "user.name"]);
	if (!email.ok) {
		throw new AgentError(
			"GIT_IDENTITY_NOT_CONFIGURED",
			"host has no 'git config --global user.email'; configure with: git config --global user.email <value>",
		);
	}
	if (!name.ok) {
		throw new AgentError(
			"GIT_IDENTITY_NOT_CONFIGURED",
			"host has no 'git config --global user.name'; configure with: git config --global user.name <value>",
		);
	}
	return { name: name.value, email: email.value };
}

export async function runClaudeCode(
	handle: SandboxHandle,
	prompt: string,
	opts?: RunClaudeCodeOptions,
): Promise<AgentResult> {
	const id = await resolveIdentity(opts);

	const parser = createStreamParser();
	const cmd = `GIT_AUTHOR_NAME=${shEscape(id.name)} GIT_AUTHOR_EMAIL=${shEscape(id.email)} GIT_COMMITTER_NAME=${shEscape(id.name)} GIT_COMMITTER_EMAIL=${shEscape(id.email)} claude --print --output-format stream-json --verbose --dangerously-skip-permissions`;

	const result = await handle.exec(cmd, {
		stdin: prompt,
		cwd: handle.workspacePath,
		onLine: (line) => parser.feed(line),
	});

	const { finalText, truncated } = parser.finish();
	if (truncated && result.exitCode === 0) {
		throw new AgentError(
			"STREAM_TRUNCATED",
			"claude exited cleanly but stream-json had no terminating 'result' event",
		);
	}
	return { exitCode: result.exitCode, finalText };
}
