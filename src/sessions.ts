import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import * as vscode from "vscode";
import { normPath, sessionsDir } from "./config";

export interface SessionInfo {
	id: string;
	file: string;
	cwd: string;
	/** Shown in lists; a placeholder when the session is empty. */
	title: string;
	/** No title and no prompt yet. Lists skip these unless `omp.sessions.showEmpty` is on. */
	empty: boolean;
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
const DEBOUNCE_MS = 1000;
// Files parsed between yields to the event loop during a full scan. Each parse is a stat
// and a 16KB read, so a chunk stays well under a frame even on a slow disk.
const SCAN_CHUNK = 25;
const EMPTY_TITLE = "(empty session)";

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

/** Title, header, and first prompt from a session file's head; null for foreign files. */
export function parseSession(file: string, mtimeMs: number): SessionInfo | null {
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
		if (m) {
			try {
				title = JSON.parse(`"${m[1]}"`);
			} catch {
				title = m[1];
			}
		}
	}
	const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
	return {
		id: header.id,
		file,
		cwd: header.cwd,
		title: title ? oneLine(title) : EMPTY_TITLE,
		empty: !title,
		created: Number.isFinite(created) ? created : mtimeMs,
		modified: mtimeMs,
	};
}

export interface SessionIndexOptions {
	root?: string;
	debounceMs?: number;
}

/**
 * Index of top-level omp sessions (`<root>/<bucket>/*.jsonl`). Subagent transcripts
 * live in per-session subdirectories and are skipped.
 *
 * `ensure()` scans everything once, in chunks, so hundreds of sessions do not block the
 * extension host. After that the watcher names each changed file, and only those are
 * re-read. Every running omp appends to its session about once a second, so a full
 * rescan per change would cost time proportional to the whole history.
 */
export class SessionIndex implements vscode.Disposable {
	private readonly root: string;
	private readonly debounceMs: number;
	// Keyed by normPath(file).
	private readonly cache = new Map<string, CacheEntry>();
	private sorted: SessionInfo[] | undefined;
	/** The first full scan; set once `ensure()` is called. */
	private scanned: Promise<void> | undefined;
	// Scans and flushes run one at a time, so a rescan never races the first scan.
	private queue: Promise<unknown> = Promise.resolve();
	private readonly pending = new Set<string>();
	private rescan = false;
	private watcher: fs.FSWatcher | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(opts: SessionIndexOptions = {}) {
		this.root = opts.root ?? sessionsDir();
		this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
		this.watch();
	}

	private watch(): void {
		try {
			this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => this.onFsEvent(name));
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			// No sessions dir yet; a later rescan starts the watcher once it exists.
		}
	}

	private onFsEvent(name: string | Buffer | null): void {
		if (name === null) {
			this.rescan = true;
		} else {
			const parts = String(name).split(/[\\/]/);
			// A bucket directory itself changed (created, renamed, deleted): its files may go unreported.
			if (parts.length === 1) this.rescan = true;
			else if (parts.length === 2 && parts[1].endsWith(".jsonl")) this.pending.add(path.join(this.root, ...parts));
			else return;
		}
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.run(() => this.flush()), this.debounceMs);
	}

	private run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.queue.then(job);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async flush(): Promise<void> {
		const files = [...this.pending];
		this.pending.clear();
		const rescan = this.rescan;
		this.rescan = false;
		// Nothing has been listed yet, so the first scan reads these anyway.
		if (!this.scanned) return;
		let dirty = false;
		if (rescan) dirty = await this.scan();
		else for (const file of files) dirty = this.update(file) || dirty;
		if (!dirty) return;
		this.sorted = undefined;
		this.changed.fire();
	}

	/** Re-reads one session file. Returns whether the listing changed. */
	private update(file: string): boolean {
		const key = normPath(file);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			return this.cache.delete(key);
		}
		const cached = this.cache.get(key);
		if (cached?.mtimeMs === mtimeMs) return false;
		let info: SessionInfo | null = null;
		try {
			info = parseSession(file, mtimeMs);
		} catch {
			// unreadable; retried on the next change
		}
		this.cache.set(key, { mtimeMs, info });
		// A foreign file that stays foreign does not change what is listed.
		return !!(info || cached?.info);
	}

	/** Full scan of every bucket, yielding between chunks. Returns whether the listing changed. */
	private async scan(): Promise<boolean> {
		const seen = new Set<string>();
		let dirty = false;
		let parsed = 0;
		let buckets: fs.Dirent[];
		try {
			buckets = fs.readdirSync(this.root, { withFileTypes: true });
		} catch {
			buckets = [];
		}
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const dir = path.join(this.root, bucket.name);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const file = path.join(dir, entry.name);
				seen.add(normPath(file));
				dirty = this.update(file) || dirty;
				if (++parsed % SCAN_CHUNK === 0) await setImmediate();
			}
		}
		for (const key of this.cache.keys()) {
			if (!seen.has(key)) dirty = this.cache.delete(key) || dirty;
		}
		if (!this.watcher) this.watch();
		return dirty;
	}

	/** Resolves once the first full scan is done; starts it on the first call. */
	ensure(): Promise<void> {
		this.scanned ??= this.run(async () => {
			await this.scan();
			this.sorted = undefined;
		});
		return this.scanned;
	}

	/** Every session scanned so far, empty ones included, most recently modified first. Await `ensure()` first. */
	list(): SessionInfo[] {
		if (!this.sorted) {
			this.sorted = [];
			for (const { info } of this.cache.values()) if (info) this.sorted.push(info);
			this.sorted.sort((a, b) => b.modified - a.modified);
		}
		return this.sorted;
	}

	/** Metadata for one session file; parses it when it is not indexed (e.g. never listed). */
	find(file: string): SessionInfo | undefined {
		const cached = this.cache.get(normPath(file));
		if (cached) return cached.info ?? undefined;
		try {
			return parseSession(file, fs.statSync(file).mtimeMs) ?? undefined;
		} catch {
			return undefined;
		}
	}

	dispose(): void {
		clearTimeout(this.debounce);
		this.watcher?.close();
		this.changed.dispose();
	}
}
