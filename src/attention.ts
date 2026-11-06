import * as vscode from "vscode";
import { normPath } from "./config";
import { TerminalTracker, type RevealSession, type StateChange } from "./tracker";

const STATE_KEY = "omp.unreadCompletions";

/** Host-owned completion history, acknowledged only by explicit extension actions. */
export class SessionAttention implements vscode.Disposable {
	private readonly unread = new Set<string>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(private readonly ctx: vscode.ExtensionContext, private readonly tracker: TerminalTracker) {
		const saved = ctx.workspaceState.get<unknown>(STATE_KEY);
		if (Array.isArray(saved)) {
			for (const file of saved) if (typeof file === "string" && file) this.unread.add(normPath(file));
		}
		this.disposables.push(
			tracker.onDidChangeState((change) => this.onState(change)),
			tracker.onDidRevealSession((change) => this.onReveal(change)),
		);
	}

	isUnread(file: string): boolean { return this.unread.has(normPath(file)); }

	forget(file: string): void {
		if (this.unread.delete(normPath(file))) this.save();
	}

	private save(): void {
		void this.ctx.workspaceState.update(STATE_KEY, [...this.unread]);
		this.changed.fire();
	}

	private onState({ sessionFile, previous, state }: StateChange): void {
		if (previous !== "working" || state !== "idle") return;
		const file = normPath(sessionFile);
		if (!this.unread.has(file)) {
			this.unread.add(file);
			this.save();
		}
	}

	private onReveal({ sessionFile, terminal }: RevealSession): void {
		if (this.tracker.openSessions().get(normPath(sessionFile))?.terminal === terminal) this.forget(sessionFile);
	}

	dispose(): void {
		for (const disposable of this.disposables) disposable.dispose();
		this.changed.dispose();
	}
}
