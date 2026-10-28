import * as fs from "node:fs";
import * as path from "node:path";
import { normPath } from "./config";

/** A checkout's git directory: `<top>/.git`, or where a worktree's `.git` file points. */
function gitDirOf(top: string): string | undefined {
	const dotGit = path.join(top, ".git");
	try {
		if (fs.statSync(dotGit).isDirectory()) return dotGit;
		const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
		return m ? path.resolve(top, m[1]) : undefined;
	} catch {
		return undefined;
	}
}

function readTrimmed(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * `folder` and the same folder in every other worktree of its git repository, so a session
 * that `/wt` moved into a worktree still counts as the folder's, as in omp's resume picker.
 * Reads git's files directly: `commondir` leads a linked worktree to the main repository,
 * whose `worktrees/<name>/gitdir` files name each worktree's `.git`. Outside a repository
 * this is just `[folder]`.
 */
export function worktreeFolders(folder: string): string[] {
	let top = path.resolve(folder);
	let gitDir = gitDirOf(top);
	while (!gitDir) {
		const up = path.dirname(top);
		if (up === top) return [folder];
		top = up;
		gitDir = gitDirOf(top);
	}
	const commonRel = readTrimmed(path.join(gitDir, "commondir"));
	const common = commonRel ? path.resolve(gitDir, commonRel) : gitDir;
	const tops = [top];
	// A non-bare repository keeps its metadata in `<main checkout>/.git`.
	if (path.basename(common).toLowerCase() === ".git") tops.push(path.dirname(common));
	let names: string[] = [];
	try {
		names = fs.readdirSync(path.join(common, "worktrees"));
	} catch {
		// no linked worktrees
	}
	for (const name of names) {
		const dotGit = readTrimmed(path.join(common, "worktrees", name, "gitdir"));
		if (dotGit) tops.push(path.dirname(path.resolve(common, "worktrees", name, dotGit)));
	}
	const rel = path.relative(top, path.resolve(folder));
	const out = new Map<string, string>();
	for (const t of tops) {
		const f = path.join(t, rel);
		out.set(normPath(f), f);
	}
	return [...out.values()];
}
