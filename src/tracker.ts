import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { normPath, ompExecutable, terminalMapDir } from "./config";

/** Env var the omp-side hook reads to tie a session to the terminal that runs it. */
export const TERMINAL_ENV = "OMP_VSCODE_TERMINAL";

const STATE_KEY = "omp.openSessions";
// Window close can surface as a non-shutdown exit before the extension host stops.
// Removal waits this long so a closing window never forgets its sessions.
const CLOSE_GRACE_MS = 1500;
const SPAWN_WAIT_MS = 10_000;
// Map files written for omp started by hand in a shell terminal, not by this extension.
const ADOPTED_PREFIX = "pid-";

/** Written by the omp hook to `<agentDir>/vscode-terminals/<key>.json`. */
interface MapRecord {
	terminalId?: string;
	pid?: number;
	ppid?: number;
	sessionFile?: string;
	cwd?: string;
	updatedAt?: number;
}

interface SavedSession {
	sessionFile: string;
	cwd: string;
}

interface Tracked {
	key: string;
	terminal: vscode.Terminal;
	cwd: string;
	sessionFile?: string;
}

export interface LaunchOptions {
	cwd?: string;
	sessionFile?: string;
	preserveFocus?: boolean;
}

function fileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function envKey(terminal: vscode.Terminal): string | undefined {
	const opts = terminal.creationOptions;
	const value = "env" in opts ? opts.env?.[TERMINAL_ENV] : undefined;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Tracks omp terminals in open order and persists them per workspace, so the
 * sessions open when VS Code closed come back in the same order on next start.
 */
export class TerminalTracker implements vscode.Disposable {
	private tracked: Tracked[] = [];
	private readonly pids = new Map<vscode.Terminal, number>();
	private readonly pendingClose = new Map<vscode.Terminal, NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: fs.FSWatcher | undefined;
	private restoring = false;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly ctx: vscode.ExtensionContext) {}

	async start(): Promise<void> {
		const dir = terminalMapDir();
		fs.mkdirSync(dir, { recursive: true });
		this.disposables.push(
			vscode.window.onDidOpenTerminal((t) => void this.notePid(t)),
			vscode.window.onDidCloseTerminal((t) => this.onClose(t)),
		);
		try {
			this.watcher = fs.watch(dir, (_event, name) => {
				if (name && String(name).endsWith(".json")) this.applyMapFile(path.join(dir, String(name)));
			});
			this.watcher.on("error", () => this.watcher?.close());
		} catch {
			// Without a watcher, session switches inside a terminal go unnoticed until the next event.
		}

		// Terminals survive an extension host restart; re-adopt ours before restoring.
		await Promise.all(vscode.window.terminals.map((t) => this.notePid(t)));
		for (const terminal of vscode.window.terminals) {
			const key = envKey(terminal);
			if (key) this.track(terminal, key, "");
		}
		for (const name of fs.readdirSync(dir)) {
			if (name.endsWith(".json")) this.applyMapFile(path.join(dir, name));
		}

		if (vscode.workspace.getConfiguration("omp").get<boolean>("restoreOnStartup", true)) await this.restore();
		this.save();
		this.changed.fire();
	}

	/** Session file -> terminal for every open omp terminal. */
	openSessions(): Map<string, vscode.Terminal> {
		const out = new Map<string, vscode.Terminal>();
		for (const t of this.tracked) if (t.sessionFile) out.set(normPath(t.sessionFile), t.terminal);
		return out;
	}

	/** Focuses the terminal already running `sessionFile`, or resumes it in a new one. */
	open(opts: LaunchOptions): void {
		const existing = opts.sessionFile ? this.openSessions().get(normPath(opts.sessionFile)) : undefined;
		if (existing) existing.show(opts.preserveFocus);
		else this.launch(opts);
	}

	private launch(opts: LaunchOptions): vscode.Terminal {
		const key = crypto.randomUUID();
		const inPanel = vscode.workspace.getConfiguration("omp").get<string>("terminalLocation") === "panel";
		const terminal = vscode.window.createTerminal({
			// No `name`: a fixed name would pin the tab label. Without one, the tab follows
			// the title omp sets (`π > <session title>`) when `terminal.integrated.tabs.title`
			// includes `${sequence}`.
			shellPath: ompExecutable(),
			shellArgs: opts.sessionFile ? ["--resume", opts.sessionFile] : [],
			cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined,
			env: { [TERMINAL_ENV]: key },
			iconPath: new vscode.ThemeIcon("sparkle"),
			// VS Code must not revive these itself; this tracker restores them.
			isTransient: true,
			location: inPanel
				? vscode.TerminalLocation.Panel
				: { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus },
		});
		if (inPanel) terminal.show(opts.preserveFocus);
		this.track(terminal, key, opts.cwd ?? "", opts.sessionFile);
		this.save();
		this.changed.fire();
		return terminal;
	}

	// Launches one at a time: VS Code defers spawning a terminal until its editor is
	// laid out, and a burst of hidden editor terminals at startup can come up blank.
	// Each restored tab takes focus in turn so it spawns before the next opens.
	private async restore(): Promise<void> {
		const saved = this.ctx.workspaceState.get<SavedSession[]>(STATE_KEY) ?? [];
		const open = this.openSessions();
		this.restoring = true;
		try {
			for (const s of saved) {
				if (!fileExists(s.sessionFile) || open.has(normPath(s.sessionFile))) continue;
				const terminal = this.launch({ cwd: s.cwd, sessionFile: s.sessionFile });
				await Promise.race([terminal.processId, sleep(SPAWN_WAIT_MS)]);
			}
		} finally {
			this.restoring = false;
		}
	}

	private track(terminal: vscode.Terminal, key: string, cwd: string, sessionFile?: string): Tracked {
		const existing = this.tracked.find((t) => t.terminal === terminal);
		if (existing) return existing;
		const entry: Tracked = { key, terminal, cwd, sessionFile };
		this.tracked.push(entry);
		return entry;
	}

	private async notePid(terminal: vscode.Terminal): Promise<void> {
		const pid = await terminal.processId;
		if (pid !== undefined) this.pids.set(terminal, pid);
	}

	private applyMapFile(file: string): void {
		const key = path.basename(file, ".json");
		let rec: MapRecord;
		try {
			rec = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			// A deleted pid map means omp exited cleanly in a shell that stays open.
			const gone = (err as NodeJS.ErrnoException).code === "ENOENT";
			const adopted = this.tracked.find((t) => t.key === key && key.startsWith(ADOPTED_PREFIX));
			if (gone && adopted) this.untrack(adopted);
			return;
		}
		if (typeof rec.pid === "number" && !pidAlive(rec.pid)) {
			// omp is gone (VS Code closed or it crashed); the saved workspace state already has the session.
			fs.rmSync(file, { force: true });
			return;
		}
		if (typeof rec.sessionFile !== "string") return;

		let entry = this.tracked.find((t) => t.key === key);
		if (!entry && key.startsWith(ADOPTED_PREFIX)) {
			const terminal = vscode.window.terminals.find((t) => {
				const pid = this.pids.get(t);
				return pid !== undefined && (pid === rec.ppid || pid === rec.pid);
			});
			if (terminal) entry = this.track(terminal, key, "");
		}
		if (!entry) return;
		const cwd = typeof rec.cwd === "string" ? rec.cwd : entry.cwd;
		if (entry.sessionFile === rec.sessionFile && entry.cwd === cwd) return;
		entry.sessionFile = rec.sessionFile;
		entry.cwd = cwd;
		this.save();
		this.changed.fire();
	}

	private onClose(terminal: vscode.Terminal): void {
		this.pids.delete(terminal);
		const entry = this.tracked.find((t) => t.terminal === terminal);
		if (!entry || terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) return;
		this.pendingClose.set(
			terminal,
			setTimeout(() => {
				this.pendingClose.delete(terminal);
				this.untrack(entry);
			}, CLOSE_GRACE_MS),
		);
	}

	private untrack(entry: Tracked): void {
		this.tracked = this.tracked.filter((t) => t !== entry);
		fs.rmSync(path.join(terminalMapDir(), `${entry.key}.json`), { force: true });
		this.save();
		this.changed.fire();
	}

	private save(): void {
		if (this.restoring) return;
		const list: SavedSession[] = [];
		for (const t of this.tracked) if (t.sessionFile) list.push({ sessionFile: t.sessionFile, cwd: t.cwd });
		void this.ctx.workspaceState.update(STATE_KEY, list);
	}

	dispose(): void {
		// Pending removals are dropped on purpose: disposal means the window is going away.
		for (const timer of this.pendingClose.values()) clearTimeout(timer);
		this.pendingClose.clear();
		this.watcher?.close();
		for (const d of this.disposables) d.dispose();
		this.changed.dispose();
	}
}
