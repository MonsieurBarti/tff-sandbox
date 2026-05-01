/**
 * Strip GIT_* env vars at vitest worker startup. When tests run inside a
 * git pre-commit hook, git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE
 * etc. into the hook environment; those leak through to `execFile` children
 * and override the `cwd:` option, so fixture `git init` becomes a no-op
 * against the tmp dir and writes spill into the outer repo. Mirrors the
 * convention used in tff-cc.
 */
for (const key of Object.keys(process.env)) {
	if (key.startsWith("GIT_")) {
		delete process.env[key];
	}
}
