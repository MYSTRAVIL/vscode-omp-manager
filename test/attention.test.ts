import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import { SessionAttention } from "../src/attention";
import { type OpenSession, type RevealSession, type StateChange, TerminalTracker } from "../src/tracker";
import { EventEmitter } from "./setup";
import { terminalHarness } from "./terminalHarness";

function scenario(saved = ["/a", "/b"]) {
	const h = terminalHarness(saved);
	const a = h.terminal("a");
	const b = h.terminal("b");
	const state = new EventEmitter<StateChange>();
	const reveal = new EventEmitter<RevealSession>();
	const open = new Map<string, OpenSession>([["/a", { terminal: a, launching: false }], ["/b", { terminal: b, launching: false }]]);
	const source = { onDidChangeState: state.event, onDidRevealSession: reveal.event, openSessions: () => open };
	const attention = new SessionAttention(h.ctx, source as unknown as TerminalTracker);
	function complete(file: string, terminal: vscode.Terminal): void { state.fire({ sessionFile: file, terminal, previous: "working", state: "idle" }); }
	return { h, a, b, attention, state, reveal, open, complete };
}

for (const order of ["tab-first", "terminal-first"] as const) {
	test(`native ${order} switches, window focus and terminal closure retain unread completions`, () => {
		const s = scenario();
		try {
			s.h.select(s.h.tab());
			s.h.activate(s.a);
			if (order === "tab-first") { s.h.select(s.h.tab()); s.h.activate(s.b); }
			else { s.h.activate(s.b); s.h.select(s.h.tab()); }
			s.h.select(s.h.tab(false));
			s.h.groups.fire();
			s.h.window.state.focused = false;
			s.h.focus.fire();
			s.h.window.state.focused = true;
			s.h.focus.fire();
			s.h.close.fire(s.b);
			assert.equal(s.attention.isUnread("/a"), true);
			assert.equal(s.attention.isUnread("/b"), true);
			assert.equal(s.h.writes.size, 0);
		} finally { s.attention.dispose(); }
	});
}

test("completion in the active terminal stays unread until the next explicit acknowledgment", () => {
	const s = scenario([]);
	try {
		s.h.select(s.h.tab());
		s.h.activate(s.a);
		s.reveal.fire({ sessionFile: "/a", terminal: s.a });
		s.complete("/a", s.a);
		assert.equal(s.attention.isUnread("/a"), true);
		s.reveal.fire({ sessionFile: "/a", terminal: s.a });
		assert.equal(s.attention.isUnread("/a"), false);
		s.complete("/a", s.a);
		assert.equal(s.attention.isUnread("/a"), true, "a previous acknowledgment cannot acknowledge a later completion");
	} finally { s.attention.dispose(); }
});

test("explicit reveal acknowledges only its exact current live session", () => {
	const s = scenario();
	try {
		s.reveal.fire({ sessionFile: "/a", terminal: s.b });
		s.reveal.fire({ sessionFile: "/missing", terminal: s.a });
		assert.equal(s.attention.isUnread("/a"), true);
		s.reveal.fire({ sessionFile: "/b", terminal: s.b, location: "panel" });
		assert.equal(s.attention.isUnread("/b"), false);
		assert.equal(s.attention.isUnread("/a"), true);
	} finally { s.attention.dispose(); }
});

test("only working-to-idle adds unread; marking read leaves waiting state untouched", () => {
	const s = scenario([]);
	try {
		for (const state of ["waiting", "unknown", "working"] as const) {
			s.state.fire({ sessionFile: "/a", terminal: s.a, previous: "working", state });
		}
		s.state.fire({ sessionFile: "/a", terminal: s.a, state: "idle" });
		assert.equal(s.attention.isUnread("/a"), false);
		s.complete("/a", s.a);
		s.open.get("/a")!.state = "waiting";
		s.state.fire({ sessionFile: "/a", terminal: s.a, previous: "idle", state: "waiting" });
		s.attention.forget("/a");
		assert.equal(s.attention.isUnread("/a"), false);
		assert.equal(s.open.get("/a")!.state, "waiting");
		s.complete("/a", s.a);
		s.reveal.fire({ sessionFile: "/a", terminal: s.a });
		assert.equal(s.attention.isUnread("/a"), false);
		assert.equal(s.open.get("/a")!.state, "waiting");
	} finally { s.attention.dispose(); }
});

test("completion and acknowledgment persist independently of sidebar and attention lifetime", () => {
	const s = scenario([]);
	try {
		s.complete("/a", s.a);
		s.complete("/b", s.b);
		assert.deepEqual(s.h.writes.get("omp.unreadCompletions"), ["/a", "/b"]);
		s.reveal.fire({ sessionFile: "/a", terminal: s.a });
		assert.deepEqual(s.h.writes.get("omp.unreadCompletions"), ["/b"]);
		const restored = scenario(s.h.writes.get("omp.unreadCompletions") as string[]);
		try {
			assert.equal(restored.attention.isUnread("/a"), false);
			assert.equal(restored.attention.isUnread("/b"), true);
		} finally { restored.attention.dispose(); }
	} finally { s.attention.dispose(); }
});

interface TrackerBoundary {
	track(terminal: vscode.Terminal, key: string, cwd: string, sessionFile?: string): void;
	restore(sessions: Array<{ sessionFile: string; cwd: string }>): Promise<void>;
}

function liveScenario() {
	const h = terminalHarness(["/a", "/restored", "/new"]);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-attention-"));
	h.settings.agentDir = dir;
	const tracker = new TerminalTracker(h.ctx, "/hook");
	const boundary = tracker as unknown as TrackerBoundary;
	const a = h.terminal("a");
	boundary.track(a, "a", "", "/a");
	const attention = new SessionAttention(h.ctx, tracker);
	return { h, tracker, boundary, a, attention, dispose() { attention.dispose(); tracker.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("stale reveals, preserve-focus opens and automatic restore never acknowledge", async () => {
	const s = liveScenario();
	try {
		assert.equal(await s.tracker.revealExisting("/a", s.h.terminal("wrong")), false);
		await s.tracker.open({ sessionFile: "/a", preserveFocus: true });
		await s.tracker.open({ sessionFile: "/new", preserveFocus: true });
		await s.boundary.restore([{ sessionFile: "/restored", cwd: "" }]);
		s.h.activate(s.tracker.openSessions().get("/restored")!.terminal);
		s.h.select(s.h.tab());
		for (const file of ["/a", "/new", "/restored"]) assert.equal(s.attention.isUnread(file), true);
	} finally { s.dispose(); }
});

for (const location of ["editor", "panel"] as const) {
	test(`successful explicit ${location} opens acknowledge existing and newly tracked sessions`, async () => {
		const s = liveScenario();
		try {
			await s.tracker.open({ sessionFile: "/a", location });
			assert.equal(s.attention.isUnread("/a"), false);
			await s.tracker.open({ sessionFile: "/new", location });
			assert.equal(s.attention.isUnread("/new"), false);
		} finally { s.dispose(); }
	});
}

test("failed show or move does not acknowledge unread", async () => {
	const s = liveScenario();
	try {
		const show = s.a.show;
		Object.assign(s.a, { show: () => { throw new Error("show failed"); } });
		await assert.rejects(s.tracker.revealExisting("/a", s.a), /show failed/);
		assert.equal(s.attention.isUnread("/a"), true);
		Object.assign(s.a, { show });
		const commands = vscode.commands as unknown as { executeCommand: () => Promise<void> };
		commands.executeCommand = async () => { throw new Error("move failed"); };
		await assert.rejects(s.tracker.revealExisting("/a", s.a, { location: "panel" }), /move failed/);
		assert.equal(s.attention.isUnread("/a"), true);
	} finally { s.dispose(); }
});

test("a failed new-session show never acknowledges the tracked session", async () => {
	const s = liveScenario();
	try {
		const create = s.h.window.createTerminal;
		s.h.window.createTerminal = (options) => {
			const terminal = create(options);
			Object.assign(terminal, { show: () => { throw new Error("show failed"); } });
			return terminal;
		};
		await assert.rejects(s.tracker.open({ sessionFile: "/new", location: "editor" }), /show failed/);
		assert.ok(s.tracker.openSessions().get("/new"));
		assert.equal(s.attention.isUnread("/new"), true);
	} finally { s.dispose(); }
});
