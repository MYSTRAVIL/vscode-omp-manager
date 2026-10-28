import assert = require("node:assert/strict");
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { normPath } from "../src/config";
import { worktreeFolders } from "../src/worktrees";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-worktrees-")));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

const sorted = (paths: string[]) => paths.map(normPath).sort();

test("worktreeFolders maps a folder to the same folder in every worktree of its repository", () => {
	const main = path.join(tmp, "repo");
	fs.mkdirSync(path.join(main, "pkg"), { recursive: true });
	fs.writeFileSync(path.join(main, "pkg", "f.txt"), "x");
	git(main, "init", "-q");
	git(main, "add", ".");
	git(main, "commit", "-qm", "init");
	const wt = path.join(tmp, "repo-wt");
	git(main, "worktree", "add", "-q", wt);
	const expected = sorted([main, wt]);

	assert.deepEqual(sorted(worktreeFolders(main)), expected, "from the main checkout");
	assert.deepEqual(sorted(worktreeFolders(wt)), expected, "from a linked worktree");
	assert.deepEqual(sorted(worktreeFolders(path.join(main, "pkg"))), sorted([path.join(main, "pkg"), path.join(wt, "pkg")]), "a subfolder keeps its place");
	assert.equal(worktreeFolders(main)[0], main, "the folder itself comes first");
});

test("worktreeFolders is just the folder outside a repository", () => {
	const plain = path.join(tmp, "plain");
	fs.mkdirSync(plain);
	assert.deepEqual(worktreeFolders(plain), [plain]);
});
