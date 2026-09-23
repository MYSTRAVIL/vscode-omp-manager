import * as vscode from "vscode";
import { normPath } from "./config";
import { SessionIndex } from "./sessions";
import { type StateChange, TerminalTracker } from "./tracker";
import { UsageService } from "./usage";
import { OmpViewProvider, workspaceSessions } from "./views";

/** What `data-vscode-context` on a session row passes to its context menu commands. */
interface SessionContext {
	file?: unknown;
	id?: unknown;
}

function sessionFileOf(arg: SessionContext | undefined): string | undefined {
	return typeof arg?.file === "string" ? arg.file : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const index = new SessionIndex();
	const usage = new UsageService();
	const tracker = new TerminalTracker(context, context.asAbsolutePath("hook/vscode-session-restore.ts"));

	const newSession = async () => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			await tracker.open({ cwd: folders[0]?.uri.fsPath });
			return;
		}
		const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Start omp in which folder?" });
		if (picked) await tracker.open({ cwd: picked.uri.fsPath });
	};

	const openIn = (location: "editor" | "panel") => (arg: SessionContext | undefined) => {
		const file = sessionFileOf(arg);
		if (file) return tracker.open({ sessionFile: file, cwd: index.find(file)?.cwd, location });
	};

	// A session that stops working in a terminal you are not looking at gets a notification.
	// `activeTerminal` outlives focus moving to a file, so a terminal tab must also be showing.
	// A panel terminal has no tab and counts as not looked at.
	const notify = ({ sessionFile, terminal, previous, state }: StateChange) => {
		if (previous !== "working" || state === "working") return;
		if (!vscode.workspace.getConfiguration("omp").get<boolean>("notifyWhenDone", true)) return;
		const terminalTabShown = vscode.window.tabGroups.all.some((g) => g.activeTab?.input instanceof vscode.TabInputTerminal);
		if (vscode.window.state.focused && vscode.window.activeTerminal === terminal && terminalTabShown) return;
		const title = index.find(sessionFile)?.title ?? "omp session";
		const text = state === "waiting" ? `"${title}" needs input` : `"${title}" finished`;
		void vscode.window.showInformationMessage(text, "Show").then((choice) => {
			if (choice) terminal.show();
		});
	};

	const view = new OmpViewProvider(index, tracker, usage, () => void newSession());

	context.subscriptions.push(
		index,
		usage,
		tracker,
		view,
		tracker.onDidChangeState(notify),
		vscode.window.registerWebviewViewProvider("omp.main", view),
		vscode.commands.registerCommand("omp.newSession", newSession),
		vscode.commands.registerCommand("omp.refresh", () => {
			view.refreshSessions(true);
			return usage.refresh();
		}),
		vscode.commands.registerCommand("omp.resumeSession", async () => {
			const picked = await vscode.window.showQuickPick(
				workspaceSessions(index).map((s) => ({
					label: s.title,
					description: new Date(s.modified).toLocaleString(),
					detail: s.cwd,
					session: s,
				})),
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
			const ok = await vscode.window.showWarningMessage(
				`Delete "${title}"?`,
				{ modal: true, detail: "The session file and its subagent transcripts move to the trash." },
				"Delete",
			);
			if (ok !== "Delete") return;
			// Subagent transcripts live in a sibling directory named like the file without `.jsonl`.
			const dir = file.replace(/\.jsonl$/, "");
			for (const target of [file, dir]) {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
				} catch (err) {
					if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound")) throw err;
				}
			}
		}),
	);

	await tracker.start();
}
