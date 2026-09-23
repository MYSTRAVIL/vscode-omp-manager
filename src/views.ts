import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { isWithin, normPath } from "./config";
import type { SessionIndex, SessionInfo } from "./sessions";
import type { TerminalTracker } from "./tracker";
import type { UsageService } from "./usage";

const MAX_SESSIONS = 300;

const BASE_CSS = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 4px 12px 12px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
.muted { color: var(--vscode-descriptionForeground); }
.heading { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 10px 0 8px; }
.error { color: var(--vscode-errorForeground); margin: 6px 0; }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
`;

function shell(webview: vscode.Webview, css: string, body: string, script: string): string {
	const nonce = crypto.randomBytes(16).toString("base64");
	return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${BASE_CSS}${css}</style></head>
<body>${body}<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function ago(ms) {
	const s = Math.max(0, (Date.now() - ms) / 1000);
	if (s < 60) return "now";
	if (s < 3600) return Math.floor(s / 60) + "m";
	if (s < 86400) return Math.floor(s / 3600) + "h";
	if (s < 604800) return Math.floor(s / 86400) + "d";
	return new Date(ms).toLocaleDateString();
}
function until(ms) {
	const s = Math.max(0, (ms - Date.now()) / 1000);
	if (s < 3600) return Math.max(1, Math.ceil(s / 60)) + "m";
	if (s < 86400) return Math.round(s / 3600) + "h";
	return Math.round(s / 86400) + "d";
}
${script}
</script></body></html>`;
}

// ---------------------------------------------------------------- usage

const USAGE_CSS = `
.limit { margin: 0 0 12px; }
.row { display: flex; justify-content: space-between; margin-bottom: 5px; }
.bar { height: 4px; border-radius: 2px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); overflow: hidden; }
.fill { height: 100%; background: var(--vscode-descriptionForeground); }
.fill.warn { background: var(--vscode-editorWarning-foreground); }
.fill.full { background: var(--vscode-errorForeground); }
.reset { font-size: 11px; margin-top: 4px; }
`;

const USAGE_SCRIPT = `
const root = document.getElementById("root");
let data;
function render() {
	if (!data) { root.innerHTML = '<div class="muted">Loading usage…</div>'; return; }
	let html = data.error ? '<div class="error">' + esc(data.error) + '</div>' : "";
	if (!data.providers.length && !data.error) html += '<div class="muted">No usage data. Log in with omp first.</div>';
	for (const p of data.providers) {
		html += '<div class="heading">' + esc(p.name) + '</div>';
		for (const l of p.limits) {
			const cls = l.usedPercent >= 100 || l.status === "exhausted" ? "full" : l.usedPercent >= 80 ? "warn" : "";
			html += '<div class="limit"><div class="row"><span>' + esc(l.label) + '</span><span>' + l.usedPercent + '%</span></div>'
				+ '<div class="bar"><div class="fill ' + cls + '" style="width:' + l.usedPercent + '%"></div></div>'
				+ (l.resetsAt ? '<div class="reset muted">Resets in ' + until(l.resetsAt) + '</div>' : "")
				+ '</div>';
		}
	}
	root.innerHTML = html;
}
window.addEventListener("message", e => { if (e.data.type === "usage") { data = e.data.snapshot; render(); } });
setInterval(render, 60000);
render();
vscode.postMessage({ type: "ready" });
`;

export class UsageViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly subs: vscode.Disposable[] = [];

	constructor(private readonly usage: UsageService) {
		this.subs.push(usage.onDidChange(() => this.post()));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = shell(view.webview, USAGE_CSS, '<div id="root"></div>', USAGE_SCRIPT);
		view.webview.onDidReceiveMessage((m) => {
			if (m?.type === "ready") this.post();
		});
		view.onDidChangeVisibility(() => this.schedule());
		view.onDidDispose(() => {
			this.view = undefined;
			this.schedule();
		});
		this.schedule();
	}

	/** Polls only while the view is visible; refreshes on reveal when stale. */
	private schedule(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		if (!this.view?.visible) return;
		const minutes = Math.max(1, vscode.workspace.getConfiguration("omp").get<number>("usageRefreshMinutes", 5));
		const age = Date.now() - (this.usage.current?.fetchedAt ?? 0);
		if (age > 60_000) void this.usage.refresh();
		this.timer = setInterval(() => void this.usage.refresh(), minutes * 60_000);
	}

	private post(): void {
		void this.view?.webview.postMessage({ type: "usage", snapshot: this.usage.current });
	}

	dispose(): void {
		clearInterval(this.timer);
		for (const s of this.subs) s.dispose();
	}
}

// ---------------------------------------------------------------- sessions

const SESSIONS_CSS = `
.new { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 4px; margin: 2px 0 8px; border-radius: 4px; text-align: left; }
.new:hover, .item:hover { background: var(--vscode-list-hoverBackground); }
.new svg { flex: none; }
.search { display: flex; align-items: center; gap: 6px; padding: 4px 6px; margin-bottom: 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); border-radius: 4px; }
.search:focus-within { border-color: var(--vscode-focusBorder); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--vscode-input-foreground); font: inherit; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 4px; border-radius: 4px; text-align: left; }
.item:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { display: block; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.time { flex: none; font-size: 11px; }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
.dot.open { background: var(--vscode-testing-iconPassed, #3fb950); }
.group { font-size: 11px; margin: 10px 4px 4px; }
`;

const PLUS_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`;
const SEARCH_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="muted"><path d="M15.25 14.19l-4.07-4.07a5.5 5.5 0 1 0-1.06 1.06l4.07 4.07 1.06-1.06zM6.5 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>`;

const SESSIONS_BODY = `
<button class="new" id="new">${PLUS_SVG}<span>New session</span></button>
<div class="search">${SEARCH_SVG}<input id="q" placeholder="Search sessions" aria-label="Search sessions"></div>
<div id="list"></div>`;

const SESSIONS_SCRIPT = `
const list = document.getElementById("list");
const q = document.getElementById("q");
let items = null;
function group(ms) {
	const d = new Date(ms), now = new Date();
	const day = 86400000, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= start) return "Today";
	if (ms >= start - day) return "Yesterday";
	if (ms >= start - 6 * day) return "This week";
	return "Older";
}
function render() {
	if (items === null) { list.innerHTML = '<div class="muted">Loading…</div>'; return; }
	const needle = q.value.trim().toLowerCase();
	const shown = needle ? items.filter(s => (s.title + " " + s.detail).toLowerCase().includes(needle)) : items;
	if (!shown.length) { list.innerHTML = '<div class="muted">' + (items.length ? "No matching sessions" : "No sessions yet") + '</div>'; return; }
	let html = "", last = "";
	for (const s of shown) {
		const g = group(s.modified);
		if (g !== last) { html += '<div class="group muted">' + g + '</div>'; last = g; }
		html += '<button class="item" data-file="' + esc(s.file) + '" title="' + esc(s.title) + (s.open ? " (open)" : "") + '">'
			+ '<span class="dot' + (s.open ? " open" : "") + '"></span>'
			+ '<span class="title">' + esc(s.title) + (s.detail ? '<span class="detail muted">' + esc(s.detail) + '</span>' : "") + '</span>'
			+ '<span class="time muted">' + ago(s.modified) + '</span></button>';
	}
	list.innerHTML = html;
}
document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "new" }));
list.addEventListener("click", e => {
	const el = e.target.closest(".item");
	if (el) vscode.postMessage({ type: "open", file: el.dataset.file });
});
q.addEventListener("input", render);
window.addEventListener("message", e => { if (e.data.type === "sessions") { items = e.data.items; render(); } });
setInterval(render, 60000);
render();
vscode.postMessage({ type: "ready" });
`;

interface SessionItem {
	file: string;
	title: string;
	detail: string;
	modified: number;
	open: boolean;
}

/** Sessions started in (or under) the open workspace folders; all sessions when no folder is open. */
export function workspaceSessions(index: SessionIndex): SessionInfo[] {
	const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
	const all = index.list();
	return folders.length ? all.filter((s) => folders.some((f) => isWithin(s.cwd, f))) : all;
}

export class SessionsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private dirty = true;
	private readonly subs: vscode.Disposable[] = [];

	constructor(
		private readonly index: SessionIndex,
		private readonly tracker: TerminalTracker,
		private readonly onNew: () => void,
	) {
		this.subs.push(
			index.onDidChange(() => this.refresh()),
			tracker.onDidChange(() => this.refresh()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = shell(view.webview, SESSIONS_CSS, SESSIONS_BODY, SESSIONS_SCRIPT);
		view.webview.onDidReceiveMessage((m) => {
			if (m?.type === "ready") this.refresh(true);
			else if (m?.type === "new") this.onNew();
			else if (m?.type === "open" && typeof m.file === "string") this.open(m.file);
		});
		view.onDidChangeVisibility(() => {
			if (view.visible && this.dirty) this.refresh();
		});
		view.onDidDispose(() => (this.view = undefined));
	}

	refresh(force = false): void {
		if (!this.view || (!this.view.visible && !force)) {
			this.dirty = true;
			return;
		}
		this.dirty = false;
		const open = this.tracker.openSessions();
		const folders = vscode.workspace.workspaceFolders ?? [];
		const items: SessionItem[] = workspaceSessions(this.index)
			.slice(0, MAX_SESSIONS)
			.map((s) => {
				// Sessions from a subfolder (worktrees, scratch dirs) show where they ran.
				const folder = folders.find((f) => isWithin(s.cwd, f.uri.fsPath));
				const rel = folder ? path.relative(folder.uri.fsPath, s.cwd) : s.cwd;
				return { file: s.file, title: s.title, detail: rel, modified: s.modified, open: open.has(normPath(s.file)) };
			});
		void this.view.webview.postMessage({ type: "sessions", items });
	}

	private open(file: string): void {
		const info = this.index.find(file);
		this.tracker.open({ sessionFile: file, cwd: info?.cwd, title: info?.title });
	}

	dispose(): void {
		for (const s of this.subs) s.dispose();
	}
}
