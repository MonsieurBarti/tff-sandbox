export type WorktreeErrorCode =
	| "REPO_NOT_FOUND"
	| "INVALID_BRANCH_NAME"
	| "BRANCH_IN_USE_EXTERNAL"
	| "GIT_FAILED";

export class WorktreeError extends Error {
	readonly code: WorktreeErrorCode;
	override readonly cause?: unknown;

	constructor(code: WorktreeErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "WorktreeError";
		this.code = code;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}

export type SandboxErrorCode =
	| "INVALID_OPTIONS"
	| "DOCKER_UNAVAILABLE"
	| "WORKTREE_NOT_FOUND"
	| "IMAGE_BUILD_FAILED"
	| "CONTAINER_START_FAILED"
	| "EXEC_FAILED"
	| "DISPOSE_FAILED";

export class SandboxError extends Error {
	readonly code: SandboxErrorCode;
	override readonly cause?: unknown;

	constructor(code: SandboxErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "SandboxError";
		this.code = code;
		if (cause !== undefined) {
			this.cause = cause;
		}
	}
}
