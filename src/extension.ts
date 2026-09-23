import * as vscode from "vscode";
import { SessionIndex } from "./sessions";
import { TerminalTracker } from "./tracker";
import { UsageService } from "./usage";
import { SessionsViewProvider, UsageViewProvider, workspaceSessions } from "./views";

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

	const sessionsView = new SessionsViewProvider(index, t, () => void newSession());
	const usageView = new UsageViewProvider(usage);

	context.subscriptions.push(
		index,
		usage,
		t,
		sessionsView,
		usageView,
		vscode.window.registerWebviewViewProvider("omp.usage", usageView),
		vscode.window.registerWebviewViewProvider("omp.sessions", sessionsView),
		vscode.commands.registerCommand("omp.newSession", newSession),
		vscode.commands.registerCommand("omp.refreshUsage", () => usage.refresh()),
		vscode.commands.registerCommand("omp.refreshSessions", () => sessionsView.refresh(true)),
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
