import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { agentDir } from "./config";
import { findLauncher, parseEnvelope, sweep, takeMatching, watchRequests } from "./launchRequests";
import type { TerminalTracker } from "./tracker";

// Focus requests let another program on this machine (a session dashboard, for one) bring an omp
// session's terminal to the front. The window that runs the session shows the terminal and, when
// the window is in the background, raises itself. The README documents the files and the protocol.

const FOCUS_DIR = "vscode-focus";

export interface FocusRequest {
	id: string;
	/** The omp session whose terminal to show. */
	sessionId: string;
	/** The omp process that runs it. */
	pid: number;
	createdAt: number;
	expiresAt: number;
}

/** The request in `text`, read from `<id>.json`, or undefined when it is not a valid v1 focus request for that id. */
export function parseFocusRequest(text: string, id: string): FocusRequest | undefined {
	const base = parseEnvelope(text, id);
	if (!base) return undefined;
	const { sessionId, pid } = base.fields;
	if (typeof sessionId !== "string" || !sessionId) return undefined;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	return { id, sessionId, pid, createdAt: base.createdAt, expiresAt: base.expiresAt };
}

/**
 * Claims focus request file `name` in `dir` when it is a valid, unexpired, unclaimed request and
 * `serves` says this window runs its session. Returns the request when this call took it.
 */
export function takeFocusRequest(dir: string, name: string, serves: (req: FocusRequest) => boolean, now = Date.now()): FocusRequest | undefined {
	return takeMatching(dir, name, parseFocusRequest, serves, now);
}

interface UriLike {
	scheme: string;
	fsPath: string;
}

/**
 * What a launcher names to bring this window to the front: its saved `.code-workspace` file, else
 * its first local folder. VS Code focuses the window that has exactly that open. An untitled
 * workspace has no file and no folder of its own to name: its first folder would open a new window.
 */
export function workspaceTarget(workspaceFile: UriLike | undefined, folders: readonly { uri: UriLike }[] | undefined): string | undefined {
	if (workspaceFile) return workspaceFile.scheme === "file" ? workspaceFile.fsPath : undefined;
	return folders?.find((f) => f.uri.scheme === "file")?.uri.fsPath;
}

// What VS Code strips from the environment of the processes it starts for the user
// (`sanitizeProcessEnvironment` in its main process bundle). The extension host runs with
// variables that make a launched Code.exe run as plain Node (`ELECTRON_RUN_AS_NODE`) or take this
// window's state for its own.
const HOST_ENV = [/^ELECTRON_.+$/, /^VSCODE_(?!(PORTABLE|SHELL_LOGIN|ENV_REPLACE|ENV_APPEND|ENV_PREPEND)).+$/, /^SNAP(|_.*)$/, /^GDK_PIXBUF_.+$/];

/** `env` without the variables that belong to the extension host. */
export function launcherEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !HOST_ENV.some((pattern) => pattern.test(key))));
}

/**
 * Brings the window that has `workspace` open to the front: runs the launcher on it, detached,
 * with no shell. That process hands its arguments to the running VS Code and exits; VS Code then
 * focuses the window that already has that workspace open, and restores it when minimized.
 * `window.openFoldersInNewWindow` does not change that, since VS Code looks for an open window
 * before it asks that setting. Resolves once the process has started.
 */
export function raiseWindow(workspace: string): Promise<void> {
	const launcher = findLauncher();
	if (!launcher) return Promise.reject(new Error("no VS Code launcher found"));
	// Not Promise.withResolvers: VS Code 1.90's extension host runs Node 20.
	return new Promise((resolve, reject) => {
		const child = spawn(launcher, [workspace], { detached: true, stdio: "ignore", windowsHide: true, env: launcherEnv(process.env) });
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/** Takes focus requests for sessions that run in this window's terminals and brings them to the front. Local windows only. */
export class FocusRequestHandler implements vscode.Disposable {
	private watcher: fs.FSWatcher | undefined;

	constructor(
		private readonly tracker: Pick<TerminalTracker, "terminalOf" | "log">,
		private readonly dir = path.join(agentDir(), FOCUS_DIR),
		/** Brings this window to the front, given its workspace. */
		private readonly raise: (workspace: string) => Promise<void> = raiseWindow,
	) {}

	start(): void {
		fs.mkdirSync(this.dir, { recursive: true });
		sweep(this.dir);
		this.watcher = watchRequests(this.dir, (name) => this.consider(name));
	}

	private consider(name: string): void {
		try {
			const req = takeFocusRequest(this.dir, name, (r) => this.tracker.terminalOf(r.sessionId, r.pid) !== undefined);
			const terminal = req && this.tracker.terminalOf(req.sessionId, req.pid);
			if (!req || !terminal) return;
			this.tracker.log.info(`Focus request ${req.id} claimed for session ${req.sessionId}`);
			terminal.show(false);
			// A window that has the operating system's focus has nothing left to do.
			if (vscode.window.state.focused) return;
			const workspace = workspaceTarget(vscode.workspace.workspaceFile, vscode.workspace.workspaceFolders);
			if (!workspace) {
				this.tracker.log.warn("This window has no workspace on disk, so it cannot raise itself");
				return;
			}
			this.tracker.log.info(`Raising this window through ${workspace}`);
			void this.raise(workspace).catch((err) => this.tracker.log.warn(`Could not raise this window: ${err}`));
		} catch (err) {
			this.tracker.log.error(`Focus request ${name} failed: ${err}`);
		}
	}

	dispose(): void {
		this.watcher?.close();
	}
}
