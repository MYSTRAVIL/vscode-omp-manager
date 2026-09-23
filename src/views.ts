import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { isWithin, normPath } from "./config";
import type { SessionIndex, SessionInfo } from "./sessions";
import type { SessionState, TerminalTracker } from "./tracker";
import type { UsageService } from "./usage";

const MAX_SESSIONS = 300;

// One webview holds both sections. Separate VS Code views split the sidebar height
// between them and cannot size to content; here usage takes its natural height and
// the session list fills and scrolls in the rest.
const CSS = `
:root { color-scheme: light dark; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
.muted { color: var(--vscode-descriptionForeground); }
.error { color: var(--vscode-errorForeground); margin: 6px 0; }

section { display: flex; flex-direction: column; min-height: 0; }
section + section { border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent)); }
#usage { flex: none; }
#sessions { flex: 1 1 auto; }
section.collapsed { flex: none; }
section.collapsed .body { display: none; }
.head { display: flex; align-items: center; gap: 2px; width: 100%; height: 22px; padding: 0 8px 0 2px; font-size: 11px; font-weight: 700; text-transform: uppercase; text-align: left; color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); }
.head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.chev { flex: none; transition: transform .1s; }
section.collapsed .chev { transform: rotate(-90deg); }
.body { padding: 0 12px 10px; }
#sessions .body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding-bottom: 0; }
section.collapsed#sessions .body { display: none; }

.provider { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 8px 0 8px; }
.limit { margin: 0 0 12px; }
.limit:last-child { margin-bottom: 2px; }
.row { display: flex; justify-content: space-between; margin-bottom: 5px; }
.bar { height: 4px; border-radius: 2px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); overflow: hidden; }
.fill { height: 100%; background: var(--vscode-descriptionForeground); }
.fill.warn { background: var(--vscode-editorWarning-foreground); }
.fill.full { background: var(--vscode-errorForeground); }
.reset { font-size: 11px; margin-top: 4px; }

.new { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 4px; margin: 4px 0 8px; border-radius: 4px; text-align: left; }
.new:hover, .item:hover { background: var(--vscode-list-hoverBackground); }
.new svg { flex: none; }
.search { display: flex; align-items: center; gap: 6px; padding: 4px 6px; margin-bottom: 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); border-radius: 4px; }
.search:focus-within { border-color: var(--vscode-focusBorder); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--vscode-input-foreground); font: inherit; }
#list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 12px; }
.item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 4px; border-radius: 4px; text-align: left; }
.item:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail { display: block; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.time { flex: none; font-size: 11px; }
.dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: transparent; }
.dot.idle { background: var(--vscode-testing-iconPassed, #3fb950); }
.dot.working { background: var(--vscode-progressBar-background, #0078d4); animation: pulse 1.2s ease-in-out infinite; }
.dot.waiting { background: var(--vscode-editorWarning-foreground, #cca700); }
@keyframes pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .dot.working { animation: none; } }
.group { font-size: 11px; margin: 10px 4px 4px; }
.group:first-child { margin-top: 0; }
`;

const CHEVRON_SVG = `<svg class="chev" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"/></svg>`;
const PLUS_SVG = `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`;
const SEARCH_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" class="muted"><path d="M15.25 14.19l-4.07-4.07a5.5 5.5 0 1 0-1.06 1.06l4.07 4.07 1.06-1.06zM6.5 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>`;

const BODY = `
<section id="usage">
	<button class="head" data-section="usage" aria-expanded="true">${CHEVRON_SVG}<span>Account &amp; Usage</span></button>
	<div class="body" id="usage-body"></div>
</section>
<section id="sessions">
	<button class="head" data-section="sessions" aria-expanded="true">${CHEVRON_SVG}<span>Session Manager</span></button>
	<div class="body">
		<button class="new" id="new">${PLUS_SVG}<span>New session</span></button>
		<div class="search">${SEARCH_SVG}<input id="q" placeholder="Search sessions" aria-label="Search sessions"></div>
		<div id="list"></div>
	</div>
</section>`;

const SCRIPT = `
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
	const m = Math.max(1, Math.ceil((ms - Date.now()) / 60000));
	const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
	if (d) return d + "d" + (h ? " " + h + "h" : "");
	if (h) return h + "h" + (min ? " " + min + "m" : "");
	return min + "m";
}

// Collapse state survives the webview being hidden and restored.
const state = vscode.getState() || { collapsed: {} };
function applyCollapsed() {
	for (const head of document.querySelectorAll(".head")) {
		const id = head.dataset.section, collapsed = !!state.collapsed[id];
		document.getElementById(id).classList.toggle("collapsed", collapsed);
		head.setAttribute("aria-expanded", String(!collapsed));
	}
}
for (const head of document.querySelectorAll(".head")) {
	head.addEventListener("click", () => {
		state.collapsed[head.dataset.section] = !state.collapsed[head.dataset.section];
		vscode.setState(state);
		applyCollapsed();
	});
}
applyCollapsed();

const usageBody = document.getElementById("usage-body");
let usage;
function renderUsage() {
	if (!usage) { usageBody.innerHTML = '<div class="muted">Loading usage…</div>'; return; }
	let html = usage.error ? '<div class="error">' + esc(usage.error) + '</div>' : "";
	if (!usage.providers.length && !usage.error) html += '<div class="muted">No usage data. Log in with omp first.</div>';
	for (const p of usage.providers) {
		html += '<div class="provider">' + esc(p.name) + '</div>';
		for (const l of p.limits) {
			const cls = l.usedPercent >= 100 || l.status === "exhausted" ? "full" : l.usedPercent >= 80 ? "warn" : "";
			html += '<div class="limit"><div class="row"><span>' + esc(l.label) + '</span><span>' + l.usedPercent + '%</span></div>'
				+ '<div class="bar"><div class="fill ' + cls + '" style="width:' + l.usedPercent + '%"></div></div>'
				+ (l.resetsAt ? '<div class="reset muted">Resets in ' + until(l.resetsAt) + '</div>' : "")
				+ '</div>';
		}
	}
	usageBody.innerHTML = html;
}

const list = document.getElementById("list");
const q = document.getElementById("q");
let items = null;
function group(ms) {
	const now = new Date();
	const day = 86400000, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= start) return "Today";
	if (ms >= start - day) return "Yesterday";
	if (ms >= start - 6 * day) return "This week";
	return "Older";
}
const STATE_LABEL = { idle: "open, idle", working: "open, working", waiting: "open, needs input" };
function renderSessions() {
	if (items === null) { list.innerHTML = '<div class="muted">Loading…</div>'; return; }
	const needle = q.value.trim().toLowerCase();
	const matched = needle ? items.filter(s => (s.title + " " + s.detail).toLowerCase().includes(needle)) : items;
	if (!matched.length) { list.innerHTML = '<div class="muted">' + (items.length ? "No matching sessions" : "No sessions yet") + '</div>'; return; }
	// Open sessions lead in their own group; the rest follow by recency.
	const shown = matched.filter(s => s.state).concat(matched.filter(s => !s.state));
	// Live sessions re-render this list about once a second; keep keyboard focus on the same row.
	const focused = document.activeElement && document.activeElement.classList.contains("item") ? document.activeElement.dataset.file : null;
	let html = "", last = "";
	for (const s of shown) {
		const g = s.state ? "Open" : group(s.modified);
		if (g !== last) { html += '<div class="group muted">' + g + '</div>'; last = g; }
		const ctx = { webviewSection: "session", file: s.file, id: s.id, sessionOpen: !!s.state, preventDefaultContextMenuItems: true };
		html += '<button class="item" tabindex="-1" data-file="' + esc(s.file) + '" data-vscode-context="' + esc(JSON.stringify(ctx)) + '"'
			+ ' title="' + esc(s.title) + (s.state ? " (" + STATE_LABEL[s.state] + ")" : "") + '">'
			+ '<span class="dot' + (s.state ? " " + s.state : "") + '"></span>'
			+ '<span class="title">' + esc(s.title) + (s.detail ? '<span class="detail muted">' + esc(s.detail) + '</span>' : "") + '</span>'
			+ '<span class="time muted">' + ago(s.modified) + '</span></button>';
	}
	list.innerHTML = html;
	const rows = [...list.querySelectorAll(".item")];
	const again = focused === null ? undefined : rows.find(r => r.dataset.file === focused);
	// One row is tabbable (roving tabindex); arrows move between rows.
	(again || rows[0]).tabIndex = 0;
	if (again) again.focus({ preventScroll: true });
}
function focusRow(row) {
	for (const r of list.querySelectorAll('.item[tabindex="0"]')) r.tabIndex = -1;
	row.tabIndex = 0;
	row.focus();
}
document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "new" }));
list.addEventListener("click", e => {
	const el = e.target.closest(".item");
	if (el) vscode.postMessage({ type: "open", file: el.dataset.file });
});
list.addEventListener("keydown", e => {
	const rows = [...list.querySelectorAll(".item")];
	const i = rows.indexOf(document.activeElement);
	if (i < 0) return;
	let next;
	if (e.key === "ArrowDown") next = rows[i + 1];
	else if (e.key === "ArrowUp") next = i > 0 ? rows[i - 1] : q;
	else if (e.key === "Home") next = rows[0];
	else if (e.key === "End") next = rows[rows.length - 1];
	else if (e.key === "Escape") next = q;
	else return;
	e.preventDefault();
	if (next === q) q.focus();
	else if (next) focusRow(next);
});
q.addEventListener("keydown", e => {
	const first = list.querySelector(".item");
	if (!first) return;
	if (e.key === "ArrowDown") { e.preventDefault(); focusRow(first); }
	else if (e.key === "Enter") { e.preventDefault(); first.click(); }
});
q.addEventListener("input", renderSessions);

window.addEventListener("message", e => {
	if (e.data.type === "usage") { usage = e.data.snapshot; renderUsage(); }
	else if (e.data.type === "sessions") { items = e.data.items; renderSessions(); }
});
setInterval(() => { renderUsage(); renderSessions(); }, 60000);
renderUsage();
renderSessions();
vscode.postMessage({ type: "ready" });
`;

interface SessionItem {
	file: string;
	id: string;
	title: string;
	detail: string;
	modified: number;
	/** Set only for sessions open in a terminal. */
	state?: SessionState;
}

/** Sessions started in (or under) the open workspace folders; all sessions when no folder is open. */
export function workspaceSessions(index: SessionIndex): SessionInfo[] {
	const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
	const all = index.list();
	return folders.length ? all.filter((s) => folders.some((f) => isWithin(s.cwd, f))) : all;
}

export class OmpViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private sessionsDirty = true;
	private usageTimer: NodeJS.Timeout | undefined;
	private readonly subs: vscode.Disposable[] = [];

	constructor(
		private readonly index: SessionIndex,
		private readonly tracker: TerminalTracker,
		private readonly usage: UsageService,
		private readonly onNew: () => void,
	) {
		this.subs.push(
			usage.onDidChange(() => this.postUsage()),
			index.onDidChange(() => this.refreshSessions()),
			tracker.onDidChange(() => this.refreshSessions()),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshSessions()),
		);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const nonce = crypto.randomBytes(16).toString("base64");
		view.webview.options = { enableScripts: true };
		view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body>${BODY}<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
		view.webview.onDidReceiveMessage((m) => {
			if (m?.type === "ready") {
				this.postUsage();
				this.refreshSessions(true);
			} else if (m?.type === "new") this.onNew();
			else if (m?.type === "open" && typeof m.file === "string") this.open(m.file);
		});
		view.onDidChangeVisibility(() => {
			this.scheduleUsage();
			if (view.visible && this.sessionsDirty) this.refreshSessions();
		});
		view.onDidDispose(() => {
			this.view = undefined;
			this.scheduleUsage();
		});
		this.scheduleUsage();
	}

	/** Polls usage only while the view is visible; refreshes on reveal when stale. */
	private scheduleUsage(): void {
		clearInterval(this.usageTimer);
		this.usageTimer = undefined;
		if (!this.view?.visible) return;
		const minutes = Math.max(1, vscode.workspace.getConfiguration("omp").get<number>("usageRefreshMinutes", 5));
		const age = Date.now() - (this.usage.current?.fetchedAt ?? 0);
		if (age > 60_000) void this.usage.refresh();
		this.usageTimer = setInterval(() => void this.usage.refresh(), minutes * 60_000);
	}

	private postUsage(): void {
		void this.view?.webview.postMessage({ type: "usage", snapshot: this.usage.current });
	}

	refreshSessions(force = false): void {
		if (!this.view || (!this.view.visible && !force)) {
			this.sessionsDirty = true;
			return;
		}
		this.sessionsDirty = false;
		const open = this.tracker.openSessions();
		const folders = vscode.workspace.workspaceFolders ?? [];
		const items: SessionItem[] = [];
		for (const s of workspaceSessions(this.index)) {
			const live = open.get(normPath(s.file));
			// Open sessions always show, however old.
			if (items.length >= MAX_SESSIONS && !live) continue;
			// Sessions from a subfolder (worktrees, scratch dirs) show where they ran.
			const folder = folders.find((f) => isWithin(s.cwd, f.uri.fsPath));
			const rel = folder ? path.relative(folder.uri.fsPath, s.cwd) : s.cwd;
			// The hook reports state shortly after launch; until then an open session shows as idle.
			const state = live ? (live.state ?? "idle") : undefined;
			items.push({ file: s.file, id: s.id, title: s.title, detail: rel, modified: s.modified, state });
		}
		void this.view.webview.postMessage({ type: "sessions", items });
	}

	private open(file: string): void {
		const info = this.index.find(file);
		void this.tracker.open({ sessionFile: file, cwd: info?.cwd });
	}

	dispose(): void {
		clearInterval(this.usageTimer);
		for (const s of this.subs) s.dispose();
	}
}
