import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { agentDir } from "./config";
import type { SessionInfo } from "./sessions";

export interface SessionPin {
	version: 1;
	id: string;
	file: string;
	title: string;
	cwd: string;
}

/** Independent atomic records let windows change different bookmarks without lost updates. */
export class SessionPins implements vscode.Disposable {
	private records = new Map<string, SessionPin>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly watcher: fs.FSWatcher;

	constructor(private readonly dir = path.join(agentDir(), "vscode-pins")) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.refresh();
		this.watcher = fs.watch(dir, () => this.refresh());
		this.watcher.on("error", (error) => void vscode.window.showWarningMessage(`Cannot watch pinned sessions: ${error.message}`));
	}

	private recordPath(id: string): string {
		if (!id) throw new Error("Session ID is not available yet");
		return path.join(this.dir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
	}

	refresh(): void {
		const records = new Map<string, SessionPin>();
		try {
			for (const name of fs.readdirSync(this.dir).sort()) {
				if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
				try {
					const record: Partial<SessionPin> = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
					if (record && record.version === 1 && typeof record.id === "string" && record.id
						&& typeof record.file === "string" && path.isAbsolute(record.file)
						&& typeof record.title === "string" && typeof record.cwd === "string"
						&& this.recordPath(record.id) === path.join(this.dir, name)) {
						records.set(record.id, record as SessionPin);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} catch (error) {
			void vscode.window.showWarningMessage(`Cannot read pinned sessions: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (JSON.stringify([...records]) !== JSON.stringify([...this.records])) {
			this.records = records;
			this.changed.fire();
		}
	}

	list(): SessionPin[] { return [...this.records.values()]; }
	has(id: string): boolean { return this.records.has(id); }

	pin(session: Pick<SessionInfo, "id" | "file" | "title" | "cwd">): void {
		const target = this.recordPath(session.id);
		const temp = `${target}.${crypto.randomBytes(8).toString("hex")}.tmp`;
		try {
			const record: SessionPin = { version: 1, id: session.id, file: session.file, title: session.title, cwd: session.cwd };
			fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
			fs.renameSync(temp, target);
		} finally {
			try { fs.unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		this.refresh();
	}

	unpin(id: string): void {
		try { fs.unlinkSync(this.recordPath(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		this.refresh();
	}

	dispose(): void {
		this.watcher.close();
		this.changed.dispose();
	}
}
