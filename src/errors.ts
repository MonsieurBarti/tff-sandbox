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
