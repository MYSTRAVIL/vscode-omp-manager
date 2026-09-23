import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { sessionsDir } from "./config";

export interface SessionInfo {
	id: string;
	file: string;
	cwd: string;
	title: string;
	created: number;
	modified: number;
}

interface CacheEntry {
	mtimeMs: number;
	info: SessionInfo | null;
}

// The title and session header are the first two lines; the first prompt usually
// follows within a few KB. Title lines are padded so omp can rewrite them in place.
const HEAD_BYTES = 16 * 1024;
const FIRST_PROMPT_RE = /"role":"user","content":\[\{"type":"text","text":"((?:[^"\\]|\\.)*)/;

function readHead(file: string): string {
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(HEAD_BYTES);
		const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseSession(file: string, mtimeMs: number): SessionInfo | null {
	const head = readHead(file);
	let title = "";
	let header: { id?: unknown; cwd?: unknown; timestamp?: unknown; title?: unknown } | undefined;
	for (const line of head.split("\n", 3)) {
		try {
			const entry = JSON.parse(line);
			if (entry?.type === "title" && typeof entry.title === "string") title = entry.title;
			else if (entry?.type === "session") header = entry;
		} catch {
			// partial or foreign line
		}
	}
	if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return null;
	if (!title && typeof header.title === "string") title = header.title;
	if (!title) {
		// Untitled sessions fall back to the first prompt; sessions without one are empty.
		const m = FIRST_PROMPT_RE.exec(head);
		if (!m) return null;
		try {
			title = JSON.parse(`"${m[1]}"`);
		} catch {
			title = m[1];
		}
	}
	const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
	return {
		id: header.id,
		file,
		cwd: header.cwd,
		title: oneLine(title),
		created: Number.isFinite(created) ? created : mtimeMs,
		modified: mtimeMs,
	};
}

/**
 * Index of top-level omp sessions (`<agentDir>/sessions/<bucket>/*.jsonl`).
 * Subagent transcripts live in per-session subdirectories and are skipped.
 */
export class SessionIndex implements vscode.Disposable {
	private cache = new Map<string, CacheEntry>();
	private watcher: fs.FSWatcher | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor() {
		this.watch();
	}

	private watch(): void {
		try {
			this.watcher = fs.watch(sessionsDir(), { recursive: true }, (_event, name) => {
				if (name && !String(name).endsWith(".jsonl")) return;
				clearTimeout(this.debounce);
				this.debounce = setTimeout(() => this.changed.fire(), 1000);
			});
			this.watcher.on("error", () => this.watcher?.close());
		} catch {
			// No sessions dir yet; manual refresh still works.
		}
	}

	list(): SessionInfo[] {
		const root = sessionsDir();
		const seen = new Set<string>();
		const out: SessionInfo[] = [];
		let buckets: fs.Dirent[];
		try {
			buckets = fs.readdirSync(root, { withFileTypes: true });
		} catch {
			return [];
		}
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const dir = path.join(root, bucket.name);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const file = path.join(dir, entry.name);
				let mtimeMs: number;
				try {
					mtimeMs = fs.statSync(file).mtimeMs;
				} catch {
					continue;
				}
				seen.add(file);
				let cached = this.cache.get(file);
				if (!cached || cached.mtimeMs !== mtimeMs) {
					let info: SessionInfo | null = null;
					try {
						info = parseSession(file, mtimeMs);
					} catch {
						// unreadable; retry on next change
					}
					cached = { mtimeMs, info };
					this.cache.set(file, cached);
				}
				if (cached.info) out.push(cached.info);
			}
		}
		for (const file of this.cache.keys()) if (!seen.has(file)) this.cache.delete(file);
		return out.sort((a, b) => b.modified - a.modified);
	}

	dispose(): void {
		clearTimeout(this.debounce);
		this.watcher?.close();
		this.changed.dispose();
	}
	/** Cached metadata for one session file, parsing it on a miss. */
	find(file: string): SessionInfo | undefined {
		const cached = this.cache.get(file);
		if (cached) return cached.info ?? undefined;
		try {
			const mtimeMs = fs.statSync(file).mtimeMs;
			const info = parseSession(file, mtimeMs);
			this.cache.set(file, { mtimeMs, info });
			return info ?? undefined;
		} catch {
			return undefined;
		}
	}
}

