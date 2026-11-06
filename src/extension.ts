import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { SessionAttention } from "./attention";
import { normPath } from "./config";
import { SessionPins } from "./pins";
import { parseSession, SessionIndex, type SessionInfo } from "./sessions";
import { systemNotify } from "./systemNotify";
import { type StateChange, TerminalTracker } from "./tracker";
import { UsageService } from "./usage";
import { UsageMonitor } from "./usageMonitor";
import { OmpViewProvider, workspaceSessions } from "./views";

/** What `data-vscode-context` on a session row passes to its context menu commands. */
interface SessionContext {
	file?: unknown;
	id?: unknown;
	sessionMissing?: unknown;
}

function sessionFileOf(arg: SessionContext | undefined): string | undefined {
	return typeof arg?.file === "string" ? arg.file : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const index = new SessionIndex();
	const usage = new UsageService();
	const tracker = new TerminalTracker(context, context.asAbsolutePath("hook/vscode-session-restore.ts"));
	const attention = new SessionAttention(context, tracker);
	const pins = new SessionPins();

	const newSession = async () => {
		const config = vscode.workspace.getConfiguration("omp");
		const mode = config.get<string>("newSessionCwd", "workspaceRoot");
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (mode === "ask") {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				defaultUri: folders[0]?.uri,
				openLabel: "Start omp here",
			});
			if (picked?.[0]) await tracker.open({ cwd: picked[0].fsPath });
			return;
		}
		const doc = vscode.window.activeTextEditor?.document;
		if (mode === "activeFileFolder" && doc?.uri.scheme === "file") {
			await tracker.open({ cwd: path.dirname(doc.uri.fsPath) });
			return;
		}
		if (folders.length <= 1) {
			await tracker.open({ cwd: folders[0]?.uri.fsPath });
			return;
		}
		const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Start omp in which folder?" });
		if (picked) await tracker.open({ cwd: picked.uri.fsPath });
	};

	const openIn = (location: "editor" | "panel") => (arg: SessionContext | undefined) => {
		const file = sessionFileOf(arg);
		if (file) return view.openSession(file, arg, location);
	};

	// A session that stops working in a terminal you are not looking at gets a notification.
	// `activeTerminal` outlives focus moving to a file, so a terminal tab must also be showing.
	// A panel terminal has no tab and counts as not looked at. A question also notifies from
	// idle: omp ends the turn before it opens a plan review.
	const notify = ({ sessionFile, terminal, previous, state, workedMs }: StateChange) => {
		if (previous === undefined || (state !== "waiting" && !(state === "idle" && previous === "working"))) return;
		const config = vscode.workspace.getConfiguration("omp");
		if (state === "waiting" ? !config.get<boolean>("notify.onInput", true) : !config.get<boolean>("notify.onFinish", true)) return;
		// Questions always notify; a quick reply finishing does not.
		const minMs = Math.max(0, config.get<number>("notify.minWorkSeconds", 10)) * 1000;
		if (state === "idle" && workedMs !== undefined && workedMs < minMs) return;
		const focused = vscode.window.state.focused;
		// Notification suppression is deliberately less strict than unread acknowledgement:
		// restored foreground terminals may not yet have a confirmed tab association.
		const terminalTabShown = vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTerminal;
		if (focused && vscode.window.activeTerminal === terminal && terminalTabShown) return;

		const title = index.find(sessionFile)?.title ?? "omp session";
		const text = state === "waiting" ? `"${title}" needs input` : `"${title}" finished`;
		const showInVsCode = () =>
			void vscode.window.showInformationMessage(text, "Show").then(async (choice) => {
				if (choice && !(await tracker.revealExisting(sessionFile, terminal))) {
					void vscode.window.showInformationMessage("That session is no longer open. No new terminal was started.");
				}
			});
		const style = config.get<string>("notify.style", "vscode");
		// A system notification is for when VS Code is in the background; a focused window gets its own.
		if (style === "vscode" || focused) {
			showInVsCode();
			return;
		}
		if (style === "both") showInVsCode();
		void systemNotify(vscode.env.appName, state === "waiting" ? "omp needs input" : "omp finished", title).then((shown) => {
			if (!shown && style === "system") showInVsCode();
		});
	};

	// Cycles through waiting sessions in tab order, starting after the active terminal.
	const focusNextWaiting = async () => {
		const open = [...tracker.openSessions()];
		const active = open.findIndex(([, s]) => s.terminal === vscode.window.activeTerminal);
		const next = open.find(([, s], i) => i > active && s.state === "waiting") ?? open.find(([, s]) => s.state === "waiting");
		if (next) {
			if (!(await tracker.revealExisting(next[0], next[1].terminal))) {
				void vscode.window.showInformationMessage("That session is no longer open.");
			}
		} else void vscode.window.showInformationMessage("No omp session needs input.");
	};

	const view = new OmpViewProvider(index, tracker, usage, attention, pins, (cwd) => void (cwd ? tracker.open({ cwd }) : newSession()));
	const setPinned = (pinned: boolean) => (arg?: SessionContext) => {
		try {
			if (!pinned) {
				if (typeof arg?.id !== "string") throw new Error("Session ID is not available");
				pins.unpin(arg.id);
				return;
			}
			const file = sessionFileOf(arg);
			const session = file && parseSession(file, fs.statSync(file).mtimeMs);
			if (!session || (typeof arg?.id === "string" && session.id !== arg.id)) {
				throw new Error("Session metadata changed or is not available yet. Refresh and try again.");
			}
			pins.pin(session);
		} catch (error) {
			void vscode.window.showWarningMessage(`Cannot update pinned session: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	context.subscriptions.push(
		index,
		usage,
		tracker,
		attention,
		pins,
		view,
		new UsageMonitor(usage, context.globalState),
		tracker.onDidChangeState(notify),
		vscode.commands.registerCommand("omp.focusNextWaiting", focusNextWaiting),
		vscode.commands.registerCommand("omp.settings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:mystravil.omp-manager")),
		vscode.commands.registerCommand("omp.session.pin", setPinned(true)),
		vscode.commands.registerCommand("omp.session.unpin", setPinned(false)),
		vscode.commands.registerCommand("omp.session.markRead", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (!file) return;
			let current: SessionInfo | null = null;
			try { current = parseSession(file, fs.statSync(file).mtimeMs); } catch { /* Unavailable bookmarks can still be acknowledged. */ }
			if (current && typeof arg?.id === "string" && current.id !== arg.id) {
				void vscode.window.showWarningMessage("The session file changed. Refresh before marking it read.");
				return;
			}
			attention.forget(file);
		}),
		vscode.window.registerWebviewViewProvider("omp.main", view),
		vscode.commands.registerCommand("omp.newSession", newSession),
		// The same command with the colored π icon, for the editor tab bar.
		vscode.commands.registerCommand("omp.newSessionFromEditorTitle", newSession),
		vscode.commands.registerCommand("omp.refresh", () => {
			pins.refresh();
			view.refreshSessions(true);
			return usage.refresh();
		}),
		vscode.commands.registerCommand("omp.resumeSession", async () => {
			const sortByCreated = vscode.workspace.getConfiguration("omp").get<string>("sessions.sortBy") === "created";
			// The picker opens at once and shows a busy bar until the first scan finishes.
			const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { session: SessionInfo }>(
				index.ensure().then(() =>
					workspaceSessions(index).map((s) => ({
						label: s.title,
						description: new Date(sortByCreated ? s.created : s.modified).toLocaleString(),
						detail: s.cwd,
						session: s,
					})),
				),
				{ placeHolder: "Resume an omp session", matchOnDetail: true },
			);
			if (picked) await tracker.open({ sessionFile: picked.session.file, cwd: picked.session.cwd });
		}),
		vscode.commands.registerCommand("omp.session.openInEditor", openIn("editor")),
		vscode.commands.registerCommand("omp.session.openInPanel", openIn("panel")),
		vscode.commands.registerCommand("omp.session.copyId", (arg?: SessionContext) => {
			if (typeof arg?.id === "string") return vscode.env.clipboard.writeText(arg.id);
		}),
		vscode.commands.registerCommand("omp.session.copyPath", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.env.clipboard.writeText(file);
		}),
		vscode.commands.registerCommand("omp.session.reveal", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
		}),
		vscode.commands.registerCommand("omp.session.delete", async (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (!file) return;
			if (tracker.openSessions().has(normPath(file))) {
				void vscode.window.showWarningMessage("Close this session's terminal before deleting it.");
				return;
			}
			const title = index.find(file)?.title ?? file;
			const deletedId = index.find(file)?.id;
			const ok = await vscode.window.showWarningMessage(
				`Delete "${title}"?`,
				{ modal: true, detail: "The session file and its subagent transcripts move to the trash." },
				"Delete",
			);
			if (ok !== "Delete") return;
			if (arg?.sessionMissing === true) {
				void vscode.window.showWarningMessage("This bookmark's transcript is unavailable. Use Unpin Session to remove the bookmark.");
				return;
			}
			if (typeof arg?.id === "string") {
				let current: SessionInfo | null = null;
				try { current = parseSession(file, fs.statSync(file).mtimeMs); } catch {}
				if (!current || current.id !== arg.id) {
					void vscode.window.showWarningMessage("The session file changed or is unavailable. Refresh before deleting it.");
					return;
				}
			}
			if (tracker.openSessions().has(normPath(file))) {
				void vscode.window.showWarningMessage("Close this session's terminal before deleting it.");
				return;
			}
			// Subagent transcripts live in a sibling directory named like the file without `.jsonl`.
			const dir = file.replace(/\.jsonl$/, "");
			for (const target of [file, dir]) {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
				} catch (err) {
					if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound")) throw err;
				}
			}
			attention.forget(file);
			if (deletedId) pins.unpin(deletedId);
		}),
	);

	await tracker.start();

	if (vscode.workspace.getConfiguration("omp").get<boolean>("focusOnStartup", true)) {
		void vscode.commands.executeCommand("workbench.view.extension.omp");
	}
}
