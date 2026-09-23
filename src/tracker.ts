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
// Restore waits this long for each terminal's process before opening the next. A focused
// editor terminal spawns within a few hundred ms; one that does not should not hold up the rest.
const SPAWN_WAIT_MS = 2000;
// omp reports its session a second or two after it starts. Silence past this means
// the hook did not load, and restore cannot follow the terminal.
const REPORT_TIMEOUT_MS = 10_000;
// Map files written for omp started by hand in a shell terminal, not by this extension.
const ADOPTED_PREFIX = "pid-";

/** What the omp in a terminal is doing, as reported by the hook. */
export type SessionState = "idle" | "working" | "waiting";
const STATES: readonly string[] = ["idle", "working", "waiting"] satisfies SessionState[];

/** Written by the omp hook to `<agentDir>/vscode-terminals/<key>.json`. */
interface MapRecord {
	terminalId?: string;
	pid?: number;
	ppid?: number;
	sessionFile?: string;
	cwd?: string;
	state?: string;
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
	state?: SessionState;
	/** The hook has written a record for this terminal. */
	reported: boolean;
	/** Launched by this window and not reported within REPORT_TIMEOUT_MS. */
	stalled?: boolean;
	/** When this window launched the terminal; timings in the log are relative to it. */
	launchedAt?: number;
	/** Timestamp when this terminal entered the working state. */
	workingSince?: number;
}

export interface OpenSession {
	terminal: vscode.Terminal;
	state?: SessionState;
	/** Launched and not yet reported by omp, which can take several seconds to boot. */
	launching: boolean;
}

export interface StateChange {
	sessionFile: string;
	terminal: vscode.Terminal;
	previous?: SessionState;
	state: SessionState;
	/** How long the terminal was in the working state, when leaving working. */
	workedMs?: number;
}

export interface LaunchOptions {
	cwd?: string;
	sessionFile?: string;
	preserveFocus?: boolean;
	/** Overrides the `omp.terminalLocation` setting. */
	location?: "editor" | "panel";
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
	private readonly reportTimers = new Set<NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: fs.FSWatcher | undefined;
	/** Launch timings, for diagnosing slow session starts. */
	private readonly log = vscode.window.createOutputChannel("OMP", { log: true });
	private restoring = false;
	private warnedUnreported = false;
	/**
	 * Saved sessions awaiting an answer to the "ask" restore prompt. save() keeps them in
	 * the saved list, so neither a pending nor a dismissed prompt forgets them.
	 */
	private pendingRestore: SavedSession[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly stateChanged = new vscode.EventEmitter<StateChange>();
	readonly onDidChangeState = this.stateChanged.event;

	/** `hookPath`: the bundled omp extension that reports each terminal's session. */
	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly hookPath: string,
	) {}

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

		const saved = this.ctx.workspaceState.get<SavedSession[]>(STATE_KEY) ?? [];
		const open = this.openSessions();
		const toRestore = saved.filter((s) => fileExists(s.sessionFile) && !open.has(normPath(s.sessionFile)));
		const mode = vscode.workspace.getConfiguration("omp").get<string>("restoreOnStartup", "always");
		if (mode === "always") await this.restore(toRestore);
		else if (mode === "ask" && toRestore.length) this.askRestore(toRestore);
		this.save();
		this.changed.fire();
	}

	/** Session file (normalized) -> terminal and state, for every open omp terminal. */
	openSessions(): Map<string, OpenSession> {
		const out = new Map<string, OpenSession>();
		for (const t of this.tracked) {
			if (t.sessionFile) out.set(normPath(t.sessionFile), { terminal: t.terminal, state: t.state, launching: !t.reported && !t.stalled });
		}
		return out;
	}

	/**
	 * Focuses the terminal already running `sessionFile`, or resumes it in a new one.
	 * With `location`, an open terminal also moves there.
	 */
	async open(opts: LaunchOptions): Promise<void> {
		const existing = opts.sessionFile ? this.openSessions().get(normPath(opts.sessionFile)) : undefined;
		if (!existing) {
			this.launch(opts);
			return;
		}
		existing.terminal.show(opts.preserveFocus);
		// Both commands act on the active terminal, which show() just set.
		if (opts.location === "panel") await vscode.commands.executeCommand("workbench.action.terminal.moveToTerminalPanel");
		else if (opts.location === "editor") await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor");
	}

	private launch(opts: LaunchOptions): vscode.Terminal {
		const launchedAt = Date.now();
		const cfg = vscode.workspace.getConfiguration("omp");
		const key = crypto.randomUUID();
		const location = opts.location ?? cfg.get<string>("terminalLocation");
		const inPanel = location === "panel";

		// Apply extraArgs after the hook, before --resume
		const args = ["-e", this.hookPath];
		const extraArgs = cfg.get<unknown[]>("extraArgs", []);
		for (const a of extraArgs) if (typeof a === "string") args.push(a);
		if (opts.sessionFile) args.push("--resume", opts.sessionFile);

		// Merge custom env, but let OMP_VSCODE_TERMINAL always win
		const env: Record<string, string> = { [TERMINAL_ENV]: key };
		const customEnv = cfg.get<Record<string, unknown>>("env", {});
		for (const [k, v] of Object.entries(customEnv)) {
			if (typeof v === "string" && k !== TERMINAL_ENV) env[k] = v;
		}

		const iconId = cfg.get<string>("terminalIcon")?.trim() || "sparkle";
		const colorId = cfg.get<string>("terminalColor")?.trim();
		const color = colorId ? new vscode.ThemeColor(colorId) : undefined;

		const terminal = vscode.window.createTerminal({
			// No `name`: a fixed name would pin the tab label. Without one, the tab follows
			// the title omp sets (`π > <session title>`) when `terminal.integrated.tabs.title`
			// includes `${sequence}`.
			shellPath: ompExecutable(),
			shellArgs: args,
			cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined,
			env,
			iconPath: new vscode.ThemeIcon(iconId, color),
			color,
			// VS Code must not revive these itself; this tracker restores them.
			isTransient: true,
			location: inPanel
				? vscode.TerminalLocation.Panel
				: { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus },
		});
		if (inPanel) terminal.show(opts.preserveFocus);
		const entry = this.track(terminal, key, opts.cwd ?? "", opts.sessionFile);
		entry.launchedAt = launchedAt;
		this.log.info(`[${key.slice(0, 8)}] ${opts.sessionFile ? `resume ${opts.sessionFile}` : "new session"} in ${inPanel ? "panel" : "editor"}; terminal created ${this.since(entry)}`);
		void terminal.processId.then((pid) => this.log.info(`[${key.slice(0, 8)}] process ${pid ?? "(none)"} started ${this.since(entry)}`));
		this.watchForReport(entry);
		this.save();
		this.changed.fire();
		return terminal;
	}

	private since(entry: Tracked): string {
		return entry.launchedAt === undefined ? "" : `+${Date.now() - entry.launchedAt}ms`;
	}

	// Launches one at a time: VS Code defers spawning a terminal until its editor is
	// laid out, and a burst of hidden editor terminals at startup can come up blank.
	// Each restored tab takes focus in turn so it spawns before the next opens.
	private async restore(sessions: SavedSession[]): Promise<void> {
		this.restoring = true;
		try {
			for (const s of sessions) {
				// A session may have been opened by hand while the "ask" prompt waited.
				if (this.openSessions().has(normPath(s.sessionFile))) continue;
				const terminal = this.launch({ cwd: s.cwd, sessionFile: s.sessionFile });
				const spawned = await Promise.race([terminal.processId.then(() => true), sleep(SPAWN_WAIT_MS).then(() => false)]);
				if (!spawned) this.log.warn(`No process ${SPAWN_WAIT_MS}ms after restoring ${s.sessionFile}; restoring the next session`);
			}
		} finally {
			this.restoring = false;
		}
	}

	/** Asks without blocking activation. Unanswered sessions stay saved for the next start. */
	private askRestore(sessions: SavedSession[]): void {
		this.pendingRestore = sessions;
		const n = sessions.length;
		const msg = n === 1 ? "Restore 1 omp session?" : `Restore ${n} omp sessions?`;
		void vscode.window.showInformationMessage(msg, "Restore").then(async (choice) => {
			if (choice !== "Restore") return;
			this.pendingRestore = [];
			await this.restore(sessions);
			this.save();
			this.changed.fire();
		});
	}

	/** Warns once per window when a launched omp never reports its session. */
	private watchForReport(entry: Tracked): void {
		const timer = setTimeout(() => {
			this.reportTimers.delete(timer);
			const alive = this.tracked.includes(entry) && entry.terminal.exitStatus === undefined;
			if (!alive || entry.reported) return;
			entry.stalled = true;
			this.changed.fire();
			this.log.warn(`[${entry.key.slice(0, 8)}] omp has not reported ${this.since(entry)}; check that it can load ${this.hookPath} with -e`);
			if (this.warnedUnreported) return;
			this.warnedUnreported = true;
			void vscode.window
				.showWarningMessage(
					"omp has not reported its session, so this terminal will not be restored and shows no status. " +
						`Check that this omp version can load extensions with -e (${this.hookPath}).`,
					"Show Log",
				)
				.then((choice) => {
					if (choice) this.log.show();
				});
		}, REPORT_TIMEOUT_MS);
		this.reportTimers.add(timer);
	}

	private track(terminal: vscode.Terminal, key: string, cwd: string, sessionFile?: string): Tracked {
		const existing = this.tracked.find((t) => t.terminal === terminal);
		if (existing) return existing;
		const entry: Tracked = { key, terminal, cwd, sessionFile, reported: false };
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
		if (!entry.reported && entry.launchedAt !== undefined) this.log.info(`[${key.slice(0, 8)}] omp reported (${rec.state ?? "idle"}) ${this.since(entry)}`);
		entry.reported = true;
		entry.stalled = false;
		const cwd = typeof rec.cwd === "string" ? rec.cwd : entry.cwd;
		// Hooks older than state reporting write no state; treat those sessions as idle.
		const state = (rec.state && STATES.includes(rec.state) ? rec.state : "idle") as SessionState;
		const previous = entry.state;
		const moved = entry.sessionFile !== rec.sessionFile || entry.cwd !== cwd;
		if (!moved && previous === state) return;
		entry.sessionFile = rec.sessionFile;
		entry.cwd = cwd;

		// Track working time
		let workedMs: number | undefined;
		if (state === "working" && previous !== "working") {
			entry.workingSince = Date.now();
		} else if (state !== "working" && previous === "working" && entry.workingSince) {
			workedMs = Date.now() - entry.workingSince;
			entry.workingSince = undefined;
		}

		entry.state = state;
		if (moved) this.save();
		this.changed.fire();
		if (previous !== state) {
			const change: StateChange = { sessionFile: rec.sessionFile, terminal: entry.terminal, previous, state };
			if (workedMs !== undefined) change.workedMs = workedMs;
			this.stateChanged.fire(change);
		}
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
		// Sessions still awaiting the restore prompt go after the open ones.
		const saved = new Set(list.map((s) => normPath(s.sessionFile)));
		for (const s of this.pendingRestore) if (!saved.has(normPath(s.sessionFile))) list.push(s);
		void this.ctx.workspaceState.update(STATE_KEY, list);
	}

	dispose(): void {
		// Pending removals are dropped on purpose: disposal means the window is going away.
		for (const timer of this.pendingClose.values()) clearTimeout(timer);
		this.pendingClose.clear();
		for (const timer of this.reportTimers) clearTimeout(timer);
		this.reportTimers.clear();
		this.watcher?.close();
		for (const d of this.disposables) d.dispose();
		this.changed.dispose();
		this.stateChanged.dispose();
		this.log.dispose();
	}
}