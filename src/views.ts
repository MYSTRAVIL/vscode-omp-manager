import * as crypto from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { isWithin, normPath } from "./config";
import type { SessionIndex, SessionInfo } from "./sessions";
import type { SessionState, TerminalTracker } from "./tracker";
import { refreshMinutes, type UsageService, visibleProviders, warnPercent } from "./usage";

// One webview holds both sections. Separate VS Code views split the sidebar height
// between them and cannot size to content; here usage takes its natural height and
// the session list fills and scrolls in the rest.
const CSS = `
:root { color-scheme: light dark; --inset: 8px; --lane: 10px; }
html, body { height: 100%; }
/* VS Code's default webview style pads the body 20px; sections and the list reach the sidebar edges, as in native views. */
body { margin: 0; padding: 0; display: flex; flex-direction: column; overflow: hidden; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
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
/* Content ends where the list's scrollbar lane begins, so everything shares one right edge. */
.body { padding: 0 var(--lane) 10px var(--inset); }
#sessions .body { display: flex; flex-direction: column; flex: 1; min-height: 0; padding-bottom: 0; }
section.collapsed#sessions .body { display: none; }

.provider, .group { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.provider { margin: 8px 0; }
.limit { margin: 0 0 12px; }
.limit:last-child { margin-bottom: 2px; }
.row { display: flex; justify-content: space-between; margin-bottom: 5px; }
.bar { height: 4px; border-radius: 2px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); overflow: hidden; }
.fill { height: 100%; background: var(--vscode-descriptionForeground); }
.fill.warn { background: var(--vscode-editorWarning-foreground); }
.fill.full { background: var(--vscode-errorForeground); }
.reset { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; margin-top: 4px; }
/* The local time keeps its right-hand place when the countdown is hidden. */
.reset .at { margin-left: auto; }

.new { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 4px; margin: 4px 0 8px; border-radius: 4px; text-align: left; }
.new:hover, .item:hover { background: var(--vscode-list-hoverBackground); }
.new svg { flex: none; }
.search { display: flex; align-items: center; gap: 6px; padding: 4px 6px; margin-bottom: 8px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); border-radius: 4px; }
.search:focus-within { border-color: var(--vscode-focusBorder); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--vscode-input-foreground); font: inherit; }
/* The list reaches the right edge so its scrollbar sits there, as in native lists. The stable
   gutter is the lane width, so rows end on the same edge as the search box and the meters,
   whether or not the list scrolls. */
#list { flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; margin-right: calc(-1 * var(--lane)); padding-bottom: 12px; }
/* Native list scrollbars: 10px, square, no arrows or track, thumb shown while the list is hovered
   or scrolling. VS Code's default webview style sets scrollbar-color, which makes Chromium ignore these. */
html { scrollbar-color: auto; }
::-webkit-scrollbar { width: var(--lane); height: var(--lane); }
/* Chromium repaints a scrollbar only when its element's own style changes, so hover and scrolling
   set a variable on the list instead of matching the thumb. */
::-webkit-scrollbar-thumb { background-color: var(--thumb, transparent); }
#list:hover, #list.scrolling { --thumb: var(--vscode-scrollbarSlider-background); }
#list::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
#list::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground); }
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
.group { display: flex; margin: 10px 4px 4px; white-space: nowrap; }
.group:first-child { margin-top: 0; }
/* A long folder path gives way before its last segment, which tells groups apart and ellipsizes only when it alone is too wide. */
.group span { overflow: hidden; text-overflow: ellipsis; }
.group span:last-child { flex: none; max-width: 100%; }
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
// Local wall-clock reset time; adds the weekday once the reset is not today.
function resetAt(ms) {
	const d = new Date(ms);
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.toDateString() === new Date().toDateString() ? time : d.toLocaleDateString([], { weekday: "short" }) + " " + time;
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
let usage, warnPercent, resetDisplay;
function renderUsage() {
	if (!usage) { usageBody.innerHTML = '<div class="muted">Loading usage…</div>'; return; }
	let html = usage.error ? '<div class="error">' + esc(usage.error) + '</div>' : "";
	if (!usage.providers.length && !usage.error) html += '<div class="muted">No usage data. Log in with omp first.</div>';
	for (const p of usage.providers) {
		html += '<div class="provider">' + esc(p.name) + '</div>';
		for (const l of p.limits) {
			const cls = l.usedPercent >= 100 || l.status === "exhausted" ? "full" : l.usedPercent >= warnPercent ? "warn" : "";
			html += '<div class="limit"><div class="row"><span>' + esc(l.label) + '</span><span>' + l.usedPercent + '%</span></div>'
				+ '<div class="bar"><div class="fill ' + cls + '" style="width:' + l.usedPercent + '%"></div></div>'
				+ (l.resetsAt ? '<div class="reset muted">'
					+ (resetDisplay !== "time" ? '<span>Resets in ' + until(l.resetsAt) + '</span>' : "")
					+ (resetDisplay !== "countdown" ? '<span class="at">' + resetAt(l.resetsAt) + '</span>' : "")
					+ '</div>' : "")
				+ '</div>';
		}
	}
	usageBody.innerHTML = html;
}

const list = document.getElementById("list");
const q = document.getElementById("q");
let items = null, groupBy;
function group(ms) {
	const now = new Date();
	const day = 86400000, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= start) return "Today";
	if (ms >= start - day) return "Yesterday";
	if (ms >= start - 6 * day) return "This week";
	return "Older";
}
const STATE_LABEL = { idle: "open, idle", working: "open, working", waiting: "open, needs input" };
function headHtml(label) {
	if (groupBy === "none") return "";
	const cut = Math.max(0, label.lastIndexOf("/"), label.lastIndexOf("\\\\"));
	return '<div class="group" title="' + esc(label) + '"><span>' + esc(label.slice(0, cut)) + '</span><span>' + esc(label.slice(cut)) + '</span></div>';
}
function rowHtml(s, detail) {
	const ctx = { webviewSection: "session", file: s.file, id: s.id, sessionOpen: !!s.state, preventDefaultContextMenuItems: true };
	return '<button class="item" tabindex="-1" data-file="' + esc(s.file) + '" data-vscode-context="' + esc(JSON.stringify(ctx)) + '"'
		+ ' title="' + esc(s.title) + (s.state ? " (" + STATE_LABEL[s.state] + ")" : "") + '">'
		+ '<span class="dot' + (s.state ? " " + s.state : "") + '"></span>'
		+ '<span class="title">' + esc(s.title) + (detail ? '<span class="detail muted">' + esc(detail) + '</span>' : "") + '</span>'
		+ '<span class="time muted">' + ago(s.time) + '</span></button>';
}
function renderSessions() {
	if (items === null) { list.innerHTML = '<div class="muted">Loading…</div>'; return; }
	const needle = q.value.trim().toLowerCase();
	const matched = needle ? items.filter(s => (s.title + " " + s.detail).toLowerCase().includes(needle)) : items;
	if (!matched.length) { list.innerHTML = '<div class="muted">' + (items.length ? "No matching sessions" : "No sessions yet") + '</div>'; return; }
	// Open sessions lead; the rest keep their order inside their group. Only matched rows are
	// grouped, so a group the search empties loses its header too.
	const open = [], groups = new Map();
	for (const s of matched) {
		if (s.state) { open.push(s); continue; }
		const g = groupBy === "none" ? "" : groupBy === "folder" ? s.folder : group(s.time);
		const members = groups.get(g);
		if (members) members.push(s);
		else groups.set(g, [s]);
	}
	// Live sessions re-render this list about once a second; keep keyboard focus on the same row.
	const focused = document.activeElement && document.activeElement.classList.contains("item") ? document.activeElement.dataset.file : null;
	let html = open.length ? headHtml("Open") + open.map(s => rowHtml(s, s.detail)).join("") : "";
	// A folder header already names the folder each row's detail would repeat.
	for (const [label, members] of groups) html += headHtml(label) + members.map(s => rowHtml(s, groupBy === "folder" ? "" : s.detail)).join("");
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
// Like native lists, the scrollbar thumb shows while the list is hovered or scrolling.
let scrollEnd;
list.addEventListener("scroll", () => {
	list.classList.add("scrolling");
	clearTimeout(scrollEnd);
	scrollEnd = setTimeout(() => list.classList.remove("scrolling"), 800);
});

window.addEventListener("message", e => {
	if (e.data.type === "usage") { ({ snapshot: usage, warnPercent, resetDisplay } = e.data); renderUsage(); }
	else if (e.data.type === "sessions") { ({ items, groupBy } = e.data); renderSessions(); }
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
	/** Modified or created time, per `omp.sessions.sortBy`: the row shows it and date groups use it. */
	time: number;
	/** Group label when grouping by folder. */
	folder?: string;
	/** Set only for sessions open in a terminal. */
	state?: SessionState;
}

/** A workspace root goes by its name; anything else by the path its row shows as detail. */
function folderLabel(folder: vscode.WorkspaceFolder | undefined, rel: string, roots: number): string {
	if (!folder) return rel;
	if (!rel) return folder.name;
	// Each root can have a subfolder of the same name.
	return roots > 1 ? path.join(folder.name, rel) : rel;
}

/**
 * The sessions to list: started in or under the open workspace folders (every session with
 * scope "all" or when no folder is open), empty ones only with showEmpty, newest first by sortBy.
 */
export function workspaceSessions(index: SessionIndex): SessionInfo[] {
	const config = vscode.workspace.getConfiguration("omp");
	const all = config.get<string>("sessions.scope", "workspace") === "all";
	const folders = all ? [] : (vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? []);
	const showEmpty = config.get<boolean>("sessions.showEmpty", false);
	const sessions = index.list().filter((s) => (showEmpty || !s.empty) && (!folders.length || folders.some((f) => isWithin(s.cwd, f))));
	// The index lists by modified time already.
	if (config.get<string>("sessions.sortBy", "modified") === "created") sessions.sort((a, b) => b.created - a.created);
	return sessions;
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
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("omp.usage.refreshMinutes")) this.scheduleUsage();
				if (e.affectsConfiguration("omp.usage")) this.postUsage();
				if (e.affectsConfiguration("omp.sessions")) this.refreshSessions();
			}),
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
		const minutes = refreshMinutes();
		const age = Date.now() - (this.usage.current?.fetchedAt ?? 0);
		if (age > 60_000) void this.usage.refresh();
		this.usageTimer = setInterval(() => void this.usage.refresh(), minutes * 60_000);
	}

	private postUsage(): void {
		if (!this.view) return;
		const snapshot = this.usage.current;
		void this.view.webview.postMessage({
			type: "usage",
			snapshot: snapshot && { ...snapshot, providers: visibleProviders(snapshot.providers) },
			warnPercent: warnPercent(),
			resetDisplay: vscode.workspace.getConfiguration("omp").get<string>("usage.resetDisplay", "both"),
		});
	}

	refreshSessions(force = false): void {
		if (!this.view || (!this.view.visible && !force)) {
			this.sessionsDirty = true;
			return;
		}
		this.sessionsDirty = false;
		const config = vscode.workspace.getConfiguration("omp");
		const max = Math.max(1, config.get<number>("sessions.maxShown", 300));
		const groupBy = config.get<string>("sessions.groupBy", "date");
		const sortBy = config.get<string>("sessions.sortBy", "modified") === "created" ? "created" : "modified";
		const open = this.tracker.openSessions();
		const folders = vscode.workspace.workspaceFolders ?? [];
		const items: SessionItem[] = [];
		for (const s of workspaceSessions(this.index)) {
			const live = open.get(normPath(s.file));
			// Open sessions always show, however old.
			if (items.length >= max && !live) continue;
			// Sessions from a subfolder (worktrees, scratch dirs) show where they ran.
			const folder = folders.find((f) => isWithin(s.cwd, f.uri.fsPath));
			const rel = folder ? path.relative(folder.uri.fsPath, s.cwd) : s.cwd;
			// The hook reports state shortly after launch; until then an open session shows as idle.
			const state = live ? (live.state ?? "idle") : undefined;
			const item: SessionItem = { file: s.file, id: s.id, title: s.title, detail: rel, time: s[sortBy], state };
			if (groupBy === "folder") item.folder = folderLabel(folder, rel, folders.length);
			items.push(item);
		}
		void this.view.webview.postMessage({ type: "sessions", items, groupBy });
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
