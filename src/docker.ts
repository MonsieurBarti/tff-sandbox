import { SandboxError } from "./errors.js";
import type { SandboxHandle, SandboxProvider, StartOptions } from "./sandbox-provider.js";

export type DockerOptions = {
	imageName?: string;
	shareClaudeConfig?: boolean;
	claudeConfigPath?: string;
	env?: Record<string, string>;
};

function getStderr(err: unknown): string | undefined {
	if (
		err !== null &&
		typeof err === "object" &&
		"stderr" in err &&
		typeof err.stderr === "string"
	) {
		return err.stderr;
	}
	return undefined;
}

function getErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	return JSON.stringify(err);
}

// Silence unused-import lint until later tasks consume them.
void getStderr;
void getErrorMessage;

export function docker(opts: DockerOptions = {}): SandboxProvider {
	return {
		name: "docker",
		async start(_startOpts: StartOptions): Promise<SandboxHandle> {
			// Step 1: synchronous option validation (AC#15) — must throw
			// before any side effect.
			if (opts.imageName !== undefined && opts.shareClaudeConfig !== false) {
				throw new SandboxError(
					"INVALID_OPTIONS",
					"shareClaudeConfig must be set to false explicitly when imageName is overridden — custom images may not provide /home/tff/.claude",
				);
			}

			// Steps 2+ land in T05 onwards.
			throw new SandboxError(
				"DOCKER_UNAVAILABLE",
				"docker().start() not yet implemented past step 1",
			);
		},
	};
}
