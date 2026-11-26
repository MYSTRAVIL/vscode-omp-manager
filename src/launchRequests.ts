import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { agentDir, normPath } from "./config";
import type { TerminalTracker } from "./tracker";

// Launch requests let another program on this machine (omp-remote, for one) start omp in the
// VS Code window that has a project folder open, or in a new window it opened for the purpose.
// The README documents the files and the protocol. The focus requests in focusRequests.ts reuse
// the envelope parser, the exclusive claim, the sweep, the directory watcher, and the launcher.

const HANDLER_FILE = "vscode-launch-handler.json";
const REQUESTS_DIR = "vscode-launch";
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
// Requests that expired this long ago, with their claims, are deleted on activation.
const STALE_MS = 60 * 60 * 1000;
// Windows refuses to replace a file another process has open, which fails the rename with EPERM.
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 20;
// The version of focus request this extension takes, announced in the handler file.
const FOCUS_REQUESTS = 1;

export interface LaunchRequest {
	id: string;
	cwd: string;
	/** omp arguments, without the executable. */
	args: string[];
	/** Added to the terminal's environment. */
	env: Record<string, string>;
	/** The requester opened a new window for this request. */
	newWindow: boolean;
	createdAt: number;
	expiresAt: number;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");
}

/** The fields every request has, and the rest of the request, unchecked. */
export interface Envelope {
	fields: Record<string, unknown>;
	createdAt: number;
	expiresAt: number;
}

/** The envelope of the request in `text`, read from `<id>.json`, or undefined when it is not a v1 request for that id with finite times. */
export function parseEnvelope(text: string, id: string): Envelope | undefined {
	let r: unknown;
	try {
		r = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!r || typeof r !== "object") return undefined;
	const fields = r as Record<string, unknown>;
	const { v, id: ownId, createdAt, expiresAt } = fields;
	if (v !== 1 || ownId !== id || !ID_PATTERN.test(id)) return undefined;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
	return { fields, createdAt, expiresAt };
}

/** The request in `text`, read from `<id>.json`, or undefined when it is not a valid v1 request for that id. */
export function parseRequest(text: string, id: string): LaunchRequest | undefined {
	const base = parseEnvelope(text, id);
	if (!base) return undefined;
	const { cwd, args, env, newWindow } = base.fields;
	if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return undefined;
	if (!isStringArray(args) || !isStringRecord(env) || typeof newWindow !== "boolean") return undefined;
	return { id, cwd, args, env, newWindow, createdAt: base.createdAt, expiresAt: base.expiresAt };
}

/** Whether `cwd` is one of `folders`. A parent or child folder does not count. */
export function matchesFolder(cwd: string, folders: readonly string[]): boolean {
	const want = normPath(cwd);
	return folders.some((f) => normPath(f) === want);
}

/** Creates claim file `file` exclusively. False when it already exists or cannot be created. */
export function claim(file: string, now = Date.now()): boolean {
	let fd: number;
	try {
		fd = fs.openSync(file, "wx");
	} catch {
		return false;
	}
	try {
		fs.writeSync(fd, JSON.stringify({ by: "omp-manager", pid: process.pid, at: now }));
	} catch {
		// The request is ours once the file exists; its content is only informational.
	} finally {
		fs.closeSync(fd);
	}
	return true;
}

/**
 * Claims request file `name` in `dir` when `parse` accepts it, it has not expired, `wanted` says
 * this window should take it, and nobody claimed it yet. Returns the request when this call took it.
 */
export function takeMatching<R extends { expiresAt: number }>(
	dir: string,
	name: string,
	parse: (text: string, id: string) => R | undefined,
	wanted: (req: R) => boolean,
	now = Date.now(),
): R | undefined {
	if (!name.endsWith(".json")) return undefined;
	const id = name.slice(0, -".json".length);
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, name), "utf8");
	} catch {
		return undefined;
	}
	const req = parse(text, id);
	if (!req || now >= req.expiresAt || !wanted(req)) return undefined;
	// The exclusive create also refuses a request someone else already claimed.
	return claim(path.join(dir, `${id}.claim`), now) ? req : undefined;
}

/**
 * Claims launch request file `name` in `dir` when it is a valid, unexpired, unclaimed request for
 * one of `folders`. Returns the request when this call took it.
 */
export function takeRequest(dir: string, name: string, folders: readonly string[], now = Date.now()): LaunchRequest | undefined {
	return takeMatching(dir, name, parseRequest, (req) => matchesFolder(req.cwd, folders), now);
}

/**
 * Whether claiming `req` marks this window as opened for a launch request. Only a window whose
 * extension activated after the requester asked for a new window qualifies; one that was already
 * open never does.
 */
export function marksWindow(req: LaunchRequest, activatedAt: number): boolean {
	return req.newWindow && activatedAt >= req.createdAt;
}

/**
 * Deletes requests that expired over an hour ago, with their claims. Files no live request
 * explains (an unreadable request, a claim without a request, a leftover `.tmp`) go once they
 * are that old.
 */
export function sweep(dir: string, now = Date.now()): void {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	const isOld = (name: string) => {
		try {
			return now - fs.statSync(path.join(dir, name)).mtimeMs > STALE_MS;
		} catch {
			return false;
		}
	};
	const remove = (name: string) => {
		try {
			fs.rmSync(path.join(dir, name), { force: true });
		} catch {
			// Held open by another process; the next activation retries.
		}
	};
	for (const name of names) {
		if (name.endsWith(".json")) {
			let expiresAt: unknown;
			try {
				expiresAt = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).expiresAt;
			} catch {
				// Unreadable: judged by age below.
			}
			const stale = typeof expiresAt === "number" ? now - expiresAt > STALE_MS : isOld(name);
			if (!stale) continue;
			remove(name);
			remove(`${name.slice(0, -".json".length)}.claim`);
		} else if (name.endsWith(".claim")) {
			if (!names.includes(`${name.slice(0, -".claim".length)}.json`) && isOld(name)) remove(name);
		} else if (name.endsWith(".tmp") && isOld(name)) {
			remove(name);
		}
	}
}

/**
 * Calls `consider` with the name of every file in `dir` now, and with the name of every file that
 * changes later. It watches before it scans, so a request written in between is not missed. Returns
 * the watcher to close, or undefined when the directory cannot be watched: then only the requests
 * present now are considered.
 */
export function watchRequests(dir: string, consider: (name: string) => void): fs.FSWatcher | undefined {
	const scan = () => {
		let names: string[];
		try {
			names = fs.readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) consider(name);
	};
	let watcher: fs.FSWatcher | undefined;
	try {
		watcher = fs.watch(dir, (_event, name) => (name ? consider(String(name)) : scan()));
		watcher.on("error", () => watcher?.close());
	} catch {
		// Without a watcher, only requests present at activation are taken.
	}
	scan();
	return watcher;
}

/** Writes through `<file>.<pid>.tmp` and a rename, retried while a reader holds `file` open. */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	try {
		for (let attempt = 1; ; attempt++) {
			try {
				fs.renameSync(tmp, file);
				return;
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if ((code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") || attempt === RENAME_ATTEMPTS) throw err;
				await sleep(RENAME_RETRY_MS);
			}
		}
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

function isFile(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * What a requester runs, with no shell, as `<launcher> --new-window <folder>` to open a window of
 * this VS Code install, and what a window runs on its own workspace to raise itself. On Windows
 * that is the GUI executable: a `.cmd` would run through cmd.exe, which parses the folder path.
 * Elsewhere it is the install's CLI script.
 */
export function findLauncher(): string | undefined {
	if (process.platform === "win32") return /\.exe$/i.test(process.execPath) && isFile(process.execPath) ? process.execPath : undefined;
	let name: unknown;
	try {
		name = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8")).applicationName;
	} catch {
		return undefined;
	}
	if (typeof name !== "string" || !name) return undefined;
	// macOS keeps bin/ inside resources/app; Linux keeps it beside resources/.
	return [path.join(vscode.env.appRoot, "bin", name), path.join(vscode.env.appRoot, "..", "..", "bin", name)].find(isFile);
}

/** Takes launch requests for this window's folders and runs omp for them. Local windows only. */
export class LaunchRequestHandler implements vscode.Disposable {
	private watcher: fs.FSWatcher | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	/** This window was opened for a launch request. Kept in memory only, so a reload forgets it. */
	private openedForRequest = false;

	constructor(
		private readonly tracker: TerminalTracker,
		private readonly extension: vscode.Extension<unknown>,
		/** When this window's extension activated. */
		private readonly activatedAt: number,
	) {}

	async start(): Promise<void> {
		const dir = path.join(agentDir(), REQUESTS_DIR);
		fs.mkdirSync(dir, { recursive: true });
		const launcher = findLauncher();
		if (launcher) {
			const handler = {
				v: 1,
				extension: this.extension.id,
				version: String(this.extension.packageJSON.version),
				launcher,
				focusRequests: FOCUS_REQUESTS,
				updatedAt: Date.now(),
			};
			try {
				await writeJsonAtomic(path.join(agentDir(), HANDLER_FILE), handler);
			} catch (err) {
				this.tracker.log.warn(`Could not write ${HANDLER_FILE}: ${err}`);
			}
		} else {
			this.tracker.log.warn(`No VS Code launcher found for ${HANDLER_FILE}; launch requests can only reach open windows`);
		}
		sweep(dir);
		this.disposables.push(this.tracker.onDidCloseLast(() => this.closeIfOpenedForRequest()));
		this.watcher = watchRequests(dir, (name) => this.consider(dir, name));
	}

	private consider(dir: string, name: string): void {
		const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
		if (!folders.length) return;
		try {
			const req = takeRequest(dir, name, folders);
			if (!req) return;
			const mark = marksWindow(req, this.activatedAt);
			if (mark) this.openedForRequest = true;
			this.tracker.log.info(`Launch request ${req.id} claimed for ${req.cwd}${mark ? "; this window was opened for it" : ""}`);
			// Focus: VS Code starts no process for an editor terminal until its tab is laid out.
			this.tracker.launch({ cwd: req.cwd, args: req.args, env: req.env, preserveFocus: false });
		} catch (err) {
			this.tracker.log.error(`Launch request ${name} failed: ${err}`);
		}
	}

	private closeIfOpenedForRequest(): void {
		if (!this.openedForRequest || !vscode.workspace.getConfiguration("omp").get<boolean>("closeLaunchedWindow", true)) return;
		this.tracker.log.info("The last omp session in a window opened for a launch request closed; closing the window");
		void vscode.commands.executeCommand("workbench.action.closeWindow");
	}

	dispose(): void {
		this.watcher?.close();
		for (const d of this.disposables) d.dispose();
	}
}
