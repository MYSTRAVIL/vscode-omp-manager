import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionAttention } from "./attention";
import { isWithin, normPath } from "./config";
import type { SessionPins } from "./pins";
import { parseSession, type SessionIndex, type SessionInfo } from "./sessions";
import type { SessionState, TerminalTracker } from "./tracker";
import { refreshMinutes, showPace, type UsageService, visibleProviders, warnPercent } from "./usage";
import { worktreeFolders } from "./worktrees";

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
.provider { display: flex; align-items: center; gap: 2px; width: 100%; margin: 8px 0; padding: 1px 4px 1px 0; border-radius: 3px; text-align: left; }
.provider:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.provider .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.provider.collapsed .chev { transform: rotate(-90deg); }
.limit { margin: 0 0 12px; }
.limit:last-child { margin-bottom: 2px; }
.row { display: flex; justify-content: space-between; margin-bottom: 5px; }
.bar { position: relative; height: 4px; border-radius: 2px; background: var(--vscode-editorWidget-border, rgba(128,128,128,.25)); overflow: hidden; }
.fill { height: 100%; background: var(--vscode-descriptionForeground); }
.fill.warn { background: var(--vscode-editorWarning-foreground); }
.fill.full { background: var(--vscode-errorForeground); }
/* Where usage would be at an even pace through the window. The sidebar-colored edges keep it visible on any fill color. */
.mark { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--vscode-foreground); box-shadow: 0 0 0 1px var(--vscode-sideBar-background, var(--vscode-editor-background)); }
.pace { font-size: 11px; margin-right: 6px; }
.pace.over { color: var(--vscode-editorWarning-foreground); }
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
/* Resumed, and omp has not reported yet: it can take several seconds to boot and paint. */
.dot.launching { box-shadow: inset 0 0 0 1px var(--vscode-descriptionForeground); animation: pulse 1.2s ease-in-out infinite; }
.dot.unread { background: var(--vscode-testing-iconPassed, #3fb950); }
.item.current { box-shadow: inset 0 0 0 2px var(--vscode-omp-session-currentBorder, var(--vscode-focusBorder)); }
.item.current:focus-visible { outline-offset: -4px; }
body.comfortable .item { padding: 8px; }
body.background .item { margin-bottom: 2px; }
body.background .item.working { background: var(--vscode-omp-session-workingBackground); }
body.background .item.waiting { background: var(--vscode-omp-session-waitingBackground); }
body.background .item.unread { background: var(--vscode-omp-session-unreadBackground); }
body.background .item:is(.working, .waiting, .unread) { color: var(--vscode-omp-session-statusForeground); }
body.background .item:is(.working, .waiting, .unread) .muted { color: var(--vscode-omp-session-statusDescriptionForeground); }
@keyframes pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .dot.working, .dot.launching { animation: none; } }
.group { display: flex; align-items: center; margin: 10px 0 4px; }
.group:first-child { margin-top: 0; }
.gtoggle { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; padding: 1px 4px 1px 0; border-radius: 3px; text-align: left; white-space: nowrap; }
.gtoggle:focus-visible, .gnew:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.group.collapsed .chev { transform: rotate(-90deg); }
.label { display: flex; min-width: 0; }
/* A long folder path gives way before its last segment, which tells groups apart and ellipsizes only when it alone is too wide. */
.label span { overflow: hidden; text-overflow: ellipsis; }
.label span:last-child { flex: none; max-width: 100%; }
.count { margin-left: auto; padding-left: 8px; font-weight: 400; }
/* New session in this folder; shown while the header is hovered or the button has focus. */
.gnew { flex: none; display: flex; padding: 1px; border-radius: 3px; opacity: 0; }
.group:hover .gnew, .gnew:focus-visible { opacity: 1; }
.gnew:hover { background: var(--vscode-toolbar-hoverBackground); }
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
const CHEVRON = ${JSON.stringify(CHEVRON_SVG)}, PLUS = ${JSON.stringify(PLUS_SVG.replace('width="16" height="16"', 'width="14" height="14"'))};
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
let usage, warnPercent, resetDisplay, showPace;
function renderUsage() {
	if (!usage) { usageBody.innerHTML = '<div class="muted">Loading usage…</div>'; return; }
	let html = usage.error ? '<div class="error">' + esc(usage.error) + '</div>' : "";
	if (!usage.providers.length && !usage.error) html += '<div class="muted">No usage data. Log in with omp first.</div>';
	const now = Date.now();
	for (const p of usage.providers) {
		const collapsed = !!state.providers[p.name];
		// A collapsed account still shows its highest usage.
		const top = Math.max(0, ...p.limits.map(l => l.usedPercent));
		html += '<button class="provider' + (collapsed ? " collapsed" : "") + '" data-provider="' + esc(p.name) + '" aria-expanded="' + !collapsed + '">' + CHEVRON
			+ '<span class="name">' + esc(p.name) + '</span>' + (collapsed ? '<span class="count">' + top + '%</span>' : "") + '</button>';
		if (collapsed) continue;
		for (const l of p.limits) {
			const cls = l.usedPercent >= 100 || l.status === "exhausted" ? "full" : l.usedPercent >= warnPercent ? "warn" : "";
			// Matches paceHeadroom in usage.ts.
			const elapsed = showPace && l.resetsAt && l.windowMs ? Math.min(Math.max((now - (l.resetsAt - l.windowMs)) / l.windowMs, 0), 1) * 100 : null;
			const headroom = elapsed === null ? null : Math.round(elapsed - l.usedPercent);
			const pace = headroom === null ? "" : headroom >= 0
				? '<span class="pace muted">' + headroom + '% under pace</span>'
				: '<span class="pace over">' + -headroom + '% over pace</span>';
			html += '<div class="limit"><div class="row"><span>' + esc(l.label) + '</span><span>' + pace + l.usedPercent + '%</span></div>'
				+ '<div class="bar"><div class="fill ' + cls + '" style="width:' + l.usedPercent + '%"></div>'
				+ (elapsed === null ? "" : '<div class="mark" style="left:' + elapsed + '%"></div>') + '</div>'
				+ (l.resetsAt ? '<div class="reset muted">'
					+ (resetDisplay !== "time" ? '<span>Resets in ' + until(l.resetsAt) + '</span>' : "")
					+ (resetDisplay !== "countdown" ? '<span class="at">' + resetAt(l.resetsAt) + '</span>' : "")
					+ '</div>' : "")
				+ '</div>';
		}
	}
	usageBody.innerHTML = html;
}
// Collapsed accounts by name.
state.providers = state.providers || {};
usageBody.addEventListener("click", e => {
	const head = e.target.closest(".provider");
	if (!head) return;
	const name = head.dataset.provider;
	if (state.providers[name]) delete state.providers[name];
	else state.providers[name] = true;
	vscode.setState(state);
	renderUsage();
});

const list = document.getElementById("list");
const q = document.getElementById("q");
let items = null, groupBy, recentCount = 0, sortOrder = "time", highlightCurrent = true;
function group(ms) {
	const now = new Date();
	const day = 86400000, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	if (ms >= start) return "Today";
	if (ms >= start - day) return "Yesterday";
	if (ms >= start - 6 * day) return "This week";
	return "Older";
}
const STATE_LABEL = { launching: "Open, starting", idle: "Open, idle", working: "Open, working", waiting: "Open, needs input", unknown: "Open, status unknown" };
// Collapsed groups by key; ignored while searching so every match shows.
state.groups = state.groups || {};
function headHtml(key, label, count, collapsed, cwd) {
	if (groupBy === "none" && key !== "pinned" && key !== "unpinned") return "";
	const cut = Math.max(0, label.lastIndexOf("/"), label.lastIndexOf("\\\\"));
	return '<div class="group' + (collapsed ? " collapsed" : "") + '">'
		+ '<button class="gtoggle" tabindex="-1" data-group="' + esc(key) + '" aria-expanded="' + !collapsed + '" title="' + esc(label) + '">' + CHEVRON
		+ '<span class="label"><span>' + esc(label.slice(0, cut)) + '</span><span>' + esc(label.slice(cut)) + '</span></span>'
		+ '<span class="count">' + count + '</span></button>'
		+ (cwd ? '<button class="gnew" data-cwd="' + esc(cwd) + '" title="New session in ' + esc(label) + '" aria-label="New session in ' + esc(label) + '">' + PLUS + '</button>' : "")
		+ '</div>';
}
function sessionPriority(s) {
	return s.state === "waiting" ? 0 : s.state === "working" ? 2 : s.unreadCompletion ? 1 : 3;
}
function sorted(members) {
	return [...members].sort((a, b) => (sortOrder === "attention" ? sessionPriority(a) - sessionPriority(b) : 0) || b.time - a.time);
}
function groupHtml(key, label, members, detail, cwd) {
	const collapsed = !searching && !!state.groups[key];
	return headHtml(key, label, members.length, collapsed, cwd) + (collapsed ? "" : sorted(members).map(s => rowHtml(s, detail(s))).join(""));
}
let searching = false;
function rowHtml(s, detail) {
	const ctx = { webviewSection: "session", file: s.file, id: s.id, sessionHasIdentity: !!s.id, sessionOpen: !!s.state, sessionPinned: !!s.pinned, sessionMissing: !!s.missing, sessionUnread: !!s.unreadCompletion, preventDefaultContextMenuItems: true };
	const highlight = s.state === "waiting" ? "waiting" : s.state === "working" ? "working" : s.unreadCompletion ? "unread" : "";
	const status = s.missing && !s.state ? "Session file unavailable" : highlight === "unread" ? "Completed, not viewed" : STATE_LABEL[s.state] || "Closed";
	const description = s.title + " — " + status + (s.cwd ? " — " + s.cwd : "") + " — " + s.file;
	return '<button class="item' + (highlight ? " " + highlight : "") + '" tabindex="-1" data-file="' + esc(s.file) + '" data-id="' + esc(s.id) + '" data-missing="' + !!s.missing + '" data-vscode-context="' + esc(JSON.stringify(ctx)) + '"'
		+ ' title="' + esc(description) + '" aria-label="' + esc(description) + '">'
		+ '<span aria-hidden="true" class="dot' + ((highlight || s.state) ? " " + (highlight || s.state) : "") + '"></span>'
		+ '<span class="title">' + esc(s.title) + (detail ? '<span class="detail muted">' + esc(detail) + '</span>' : "") + '</span>'
		+ '<span class="time muted">' + (s.time ? ago(s.time) : "") + '</span></button>';
}
let renderedHtml, pointerActive = false, pendingRender = false, pointerEnd;
function decorateCurrent() {
	const selected = highlightCurrent && items && items.find(s => s.current);
	for (const row of list.querySelectorAll(".item")) {
		const current = !!selected && row.dataset.file === selected.file && row.dataset.id === selected.id;
		row.classList.toggle("current", current);
		row.setAttribute("aria-current", String(current));
	}
}
function commitSessions(html) {
	if (html === renderedHtml) { decorateCurrent(); return; }
	if (pointerActive) { pendingRender = true; decorateCurrent(); return; }
	const active = document.hasFocus() ? document.activeElement : null;
	const focused = active && list.contains(active)
		? active.classList.contains("item") ? "f:" + active.dataset.file + ":" + active.dataset.id
		: active.classList.contains("gtoggle") ? "g:" + active.dataset.group : null : null;
	list.innerHTML = html;
	renderedHtml = html;
	decorateCurrent();
	const rows = navRows();
	const again = focused === null ? undefined : rows.find(r => (r.classList.contains("item") ? "f:" + r.dataset.file + ":" + r.dataset.id : "g:" + r.dataset.group) === focused);
	if (rows.length) (again || rows[0]).tabIndex = 0;
	if (again && document.hasFocus()) again.focus({ preventScroll: true });
}
function releasePointer() {
	clearTimeout(pointerEnd);
	pointerActive = false;
	if (pendingRender) { pendingRender = false; renderSessions(); }
}
function finishPointer() {
	clearTimeout(pointerEnd);
	pointerEnd = setTimeout(releasePointer, 0);
}
list.addEventListener("pointerdown", e => {
	if (e.button !== 0 || e.ctrlKey) { finishPointer(); return; }
	clearTimeout(pointerEnd);
	pointerActive = true;
});
window.addEventListener("pointerup", finishPointer);
window.addEventListener("pointercancel", releasePointer);
window.addEventListener("blur", releasePointer);
list.addEventListener("contextmenu", finishPointer);
function renderSessions() {
	if (items === null) { commitSessions('<div class="muted">Loading…</div>'); return; }
	const needle = q.value.trim().toLowerCase();
	searching = !!needle;
	const matched = needle ? items.filter(s => (s.title + " " + s.detail + " " + s.cwd + " " + s.file).toLowerCase().includes(needle)) : items;
	if (!matched.length) { commitSessions('<div class="muted">' + (items.length ? "No matching sessions" : "No sessions yet") + '</div>'); return; }
	const recentFiles = new Set(groupBy === "folder"
		? items.filter(s => !s.state && !s.pinned).sort((a, b) => b.time - a.time).slice(0, recentCount).map(s => s.file)
		: []);
	const pinned = [], open = [], recent = [], groups = new Map();
	for (const s of matched) {
		if (s.pinned) { pinned.push(s); continue; }
		if (s.state) { open.push(s); continue; }
		if (recentFiles.has(s.file)) { recent.push(s); continue; }
		const g = groupBy === "none" ? "" : groupBy === "folder" ? s.folder : group(s.time);
		const members = groups.get(g);
		if (members) members.push(s);
		else groups.set(g, [s]);
	}
	let html = pinned.length ? groupHtml("pinned", "Pinned", pinned, s => s.detail) : "";
	if (groupBy === "none") {
		const remaining = [...sorted(open), ...sorted(groups.get("") || [])];
		if (remaining.length) {
			const collapsed = !searching && !!state.groups.unpinned;
			html += (pinned.length ? headHtml("unpinned", "Sessions", remaining.length, collapsed) : "")
				+ (pinned.length && collapsed ? "" : remaining.map(s => rowHtml(s, s.detail)).join(""));
		}
	} else {
		if (open.length) html += groupHtml("open", "Open", open, s => s.detail);
		if (recent.length) html += groupHtml("recent", "Recent", recent, s => s.detail);
		for (const [label, members] of groups) {
			html += groupBy === "folder"
				? groupHtml("folder:" + label, label, members, () => "", members[0].cwd)
				: groupHtml(groupBy + ":" + label, label, members, s => s.detail);
		}
	}
	commitSessions(html);
}
function navRows() { return [...list.querySelectorAll(".item, .gtoggle")]; }
function focusRow(row) {
	for (const r of list.querySelectorAll('.item[tabindex="0"], .gtoggle[tabindex="0"]')) r.tabIndex = -1;
	row.tabIndex = 0;
	row.focus();
}
document.getElementById("new").addEventListener("click", () => vscode.postMessage({ type: "new" }));
list.addEventListener("click", e => {
	const add = e.target.closest(".gnew");
	if (add) { vscode.postMessage({ type: "new", cwd: add.dataset.cwd }); return; }
	const toggle = e.target.closest(".gtoggle");
	if (toggle) {
		// Collapse only applies outside a search.
		if (searching) return;
		const key = toggle.dataset.group;
		if (state.groups[key]) delete state.groups[key];
		else state.groups[key] = true;
		vscode.setState(state);
		renderSessions();
		return;
	}
	const el = e.target.closest(".item");
	if (el) vscode.postMessage({ type: "open", file: el.dataset.file, id: el.dataset.id, sessionMissing: el.dataset.missing === "true" });
});
list.addEventListener("keydown", e => {
	const rows = navRows();
	const i = rows.indexOf(document.activeElement);
	if (i < 0) return;
	let next;
	if (e.key === "ArrowDown") next = rows[i + 1];
	else if (e.key === "ArrowUp") next = i > 0 ? rows[i - 1] : q;
	else if (e.key === "Home") next = rows[0];
	else if (e.key === "End") next = rows[rows.length - 1];
	else if (e.key === "Escape") next = q;
	else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && rows[i].classList.contains("gtoggle")) {
		// Like a tree: left collapses a header, right expands it.
		if ((rows[i].getAttribute("aria-expanded") === "true") === (e.key === "ArrowLeft")) rows[i].click();
		e.preventDefault();
		return;
	}
	else return;
	e.preventDefault();
	if (next === q) q.focus();
	else if (next) focusRow(next);
});
q.addEventListener("keydown", e => {
	if (!list.querySelector(".item, .gtoggle")) return;
	if (e.key === "ArrowDown") { e.preventDefault(); focusRow(navRows()[0]); }
	else if (e.key === "Enter" && list.querySelector(".item")) { e.preventDefault(); list.querySelector(".item").click(); }
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
	if (e.data.type === "usage") { ({ snapshot: usage, warnPercent, resetDisplay, showPace } = e.data); renderUsage(); }
	else if (e.data.type === "sessions") {
		({ items, groupBy, recentCount, sortOrder, highlightCurrent } = e.data);
		document.body.classList.toggle("comfortable", e.data.density === "comfortable");
		document.body.classList.toggle("background", e.data.statusStyle === "background");
		renderSessions();
	}
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
	/** Where the session ran; a folder group's new-session button starts there. */
	cwd: string;
	/** Set only for sessions open in a terminal; "launching" until omp first reports. */
	state?: SessionState | "launching";
	pinned?: boolean;
	missing?: boolean;
	unreadCompletion?: boolean;
	current?: boolean;
}

/** A workspace root goes by its name; anything else by the path its row shows as detail. */
function folderLabel(folder: vscode.WorkspaceFolder | undefined, rel: string, roots: number): string {
	if (!folder) return rel;
	if (!rel) return folder.name;
	// Each root can have a subfolder of the same name.
	return roots > 1 ? path.join(folder.name, rel) : rel;
}

/**
 * The sessions to list: started in or under the open workspace folders or the same folders in
 * their repositories' other git worktrees (every session with scope "all" or when no folder is
 * open), empty ones only with showEmpty, newest first by sortBy.
 */
export function workspaceSessions(index: SessionIndex): SessionInfo[] {
	const config = vscode.workspace.getConfiguration("omp");
	const all = config.get<string>("sessions.scope", "workspace") === "all";
	const folders = all ? [] : (vscode.workspace.workspaceFolders?.flatMap((f) => worktreeFolders(f.uri.fsPath)) ?? []);
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
	private readonly liveInfo = new WeakMap<vscode.Terminal, SessionInfo>();

	constructor(
		private readonly index: SessionIndex,
		private readonly tracker: TerminalTracker,
		private readonly usage: UsageService,
		private readonly attention: SessionAttention,
		private readonly pins: SessionPins,
		/** `cwd`: set when started from a folder group's header. */
		private readonly onNew: (cwd?: string) => void,
	) {
		this.subs.push(
			usage.onDidChange(() => this.postUsage()),
			index.onDidChange(() => this.refreshSessions()),
			tracker.onDidChange(() => {
				for (const [file, live] of tracker.openSessions()) {
					const info = index.find(file);
					if (info) this.liveInfo.set(live.terminal, info);
				}
				this.refreshSessions();
			}),
			attention.onDidChange(() => this.refreshSessions()),
			pins.onDidChange(() => this.refreshSessions()),
			vscode.window.onDidChangeActiveTerminal(() => this.refreshSessions()),
			vscode.window.onDidCloseTerminal(() => this.refreshSessions()),
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
			} else if (m?.type === "new") this.onNew(typeof m.cwd === "string" ? m.cwd : undefined);
			else if (m?.type === "open" && typeof m.file === "string") this.openSession(m.file, m);
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
			showPace: showPace(),
		});
	}

	refreshSessions(force = false): void {
		if (!this.view || (!this.view.visible && !force)) {
			this.sessionsDirty = true;
			return;
		}
		this.sessionsDirty = false;
		// The first call waits for the initial scan, which yields to the extension host as it goes.
		void this.index.ensure().then(() => this.postSessions());
	}

	private postSessions(): void {
		if (!this.view) return;
		const config = vscode.workspace.getConfiguration("omp");
		const max = Math.max(1, config.get<number>("sessions.maxShown", 300));
		const groupBy = config.get<string>("sessions.groupBy", "date");
		const sortBy = config.get<string>("sessions.sortBy", "modified") === "created" ? "created" : "modified";
		const open = this.tracker.openSessions();
		const selected = vscode.window.activeTerminal;
		const folders = vscode.workspace.workspaceFolders ?? [];
		const items: SessionItem[] = [];
		const all = this.index.list();
		const byId = new Map(all.map((s) => [s.id, s]));
		const candidates = new Map<string, SessionInfo & { missing?: boolean }>(
			workspaceSessions(this.index).map((s) => [normPath(s.file), s]),
		);
		for (const [file, live] of open) {
			const indexed = this.index.find(file);
			if (indexed) this.liveInfo.set(live.terminal, indexed);
			const remembered = this.liveInfo.get(live.terminal);
			// The terminal remains focusable if its transcript temporarily disappears.
			candidates.set(file, indexed ?? (remembered && normPath(remembered.file) === file ? remembered : undefined)
				?? { file, id: "", title: live.terminal.name, cwd: "", empty: false, created: 0, modified: 0 });
		}
		for (const pin of this.pins.list()) {
			// Identity, not the old pathname, follows moved transcripts.
			const moved = byId.get(pin.id);
			if (moved) {
				candidates.set(normPath(moved.file), moved);
				continue;
			}
			const existing = candidates.get(normPath(pin.file));
			if (existing?.id === pin.id && open.has(normPath(pin.file))) continue;
			let saved: SessionInfo | null | undefined;
			try { saved = parseSession(pin.file, fs.statSync(pin.file).mtimeMs); } catch { /* Keep an unavailable bookmark removable. */ }
			if (saved?.id === pin.id) candidates.set(normPath(saved.file), saved);
			else candidates.set("missing:" + pin.id, { ...pin, empty: false, created: 0, modified: 0, missing: true });
		}
		let historyCount = 0;
		for (const [identity, s] of candidates) {
			const live = s.missing ? undefined : open.get(identity);
			const pinned = this.pins.has(s.id);
			if (!live && !pinned && historyCount++ >= max) continue;
			const folder = folders.find((f) => isWithin(s.cwd, f.uri.fsPath));
			const rel = folder ? path.relative(folder.uri.fsPath, s.cwd) : s.cwd;
			const state = live ? (live.launching ? "launching" : (live.state ?? "unknown")) : undefined;
			const item: SessionItem = {
				file: s.file, id: s.id, title: s.title, detail: folder && !rel ? folder.name : path.basename(s.cwd),
				time: s[sortBy], cwd: s.cwd, state, pinned, missing: !!s.missing,
				unreadCompletion: this.attention.isUnread(s.file), current: !!live && live.terminal === selected,
			};
			if (groupBy === "folder") item.folder = folderLabel(folder, rel, folders.length);
			items.push(item);
		}
		void this.view.webview.postMessage({
			type: "sessions", items, groupBy,
			recentCount: Math.max(0, Math.floor(config.get<number>("sessions.recentCount", 0))),
			sortOrder: config.get<string>("sessions.sortOrder", "time"),
			statusStyle: config.get<string>("sessions.statusStyle", "dot"),
			highlightCurrent: config.get<boolean>("sessions.highlightCurrent", true),
			density: config.get<string>("sessions.density", "compact"),
		});
	}

	/** Shared by row clicks and context commands, including stale bookmark targets. */
	openSession(file: string, target: { id?: unknown; sessionMissing?: unknown } = {}, location?: "editor" | "panel"): void {
		let info: SessionInfo | null | undefined;
		try { info = parseSession(file, fs.statSync(file).mtimeMs); } catch { /* An existing live terminal can still be revealed. */ }
		const live = this.tracker.openSessions().get(normPath(file));
		const remembered = live && this.liveInfo.get(live.terminal);
		const expectedId = typeof target.id === "string" ? target.id : undefined;
		const mismatch = expectedId && info && info.id !== expectedId;
		const unconfirmedPin = expectedId && !info && (!remembered || remembered.id !== expectedId || normPath(remembered.file) !== normPath(file));
		if (mismatch || unconfirmedPin || ((!info || target.sessionMissing) && !live)) {
			void vscode.window.showWarningMessage("This session file is unavailable or its identity has changed. You can remove its bookmark with Unpin Session.");
			return;
		}
		void this.tracker.open({ sessionFile: file, cwd: info?.cwd ?? remembered?.cwd, location })
			.catch((error: unknown) => void vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error)));
	}

	dispose(): void {
		clearInterval(this.usageTimer);
		for (const s of this.subs) s.dispose();
	}
}
