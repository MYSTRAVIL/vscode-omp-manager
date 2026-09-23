import * as vscode from "vscode";
import { SessionIndex } from "./sessions";
import { TerminalTracker } from "./tracker";
import { UsageService } from "./usage";
import { OmpViewProvider, workspaceSessions } from "./views";

let tracker: TerminalTracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const index = new SessionIndex();
	const usage = new UsageService();
	const t = new TerminalTracker(context, (file) => index.find(file)?.title);
	tracker = t;

	const newSession = async () => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length <= 1) {
			t.open({ cwd: folders[0]?.uri.fsPath });
			return;
		}
		const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Start omp in which folder?" });
		if (picked) t.open({ cwd: picked.uri.fsPath });
	};

	const view = new OmpViewProvider(index, t, usage, () => void newSession());

	context.subscriptions.push(
		index,
		usage,
		t,
		view,
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
			if (picked) t.open({ sessionFile: picked.session.file, cwd: picked.session.cwd, title: picked.session.title });
		}),
	);

	await t.start();
}

export function deactivate(): void {
	tracker?.dispose();
}
