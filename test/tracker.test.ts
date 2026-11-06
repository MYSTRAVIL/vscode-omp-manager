import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as vscode from "vscode";
import { TerminalTracker, type RevealSession, type StateChange } from "../src/tracker";
import { terminalHarness } from "./terminalHarness";

interface ReportBoundary {
	track(terminal: vscode.Terminal, key: string, cwd: string, sessionFile?: string): void;
	applyMapFile(file: string): void;
	restore(sessions: Array<{ sessionFile: string; cwd: string }>): Promise<void>;
	notePid(terminal: vscode.Terminal): Promise<void>;
}

function reports(key = "report") {
	const h = terminalHarness();
	const tracker = new TerminalTracker(h.ctx, "/hook");
	// Drive the filesystem ingestion boundary synchronously, avoiding FS watcher scheduling.
	const boundary = tracker as unknown as ReportBoundary;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tracker-"));
	h.settings.agentDir = dir;
	const terminal = h.terminal(key);
	boundary.track(terminal, key, "/project", "/a");
	const file = path.join(dir, `${key}.json`);
	const changes: StateChange[] = [];
	tracker.onDidChangeState((change) => changes.push(change));
	function report(value: unknown): void {
		fs.writeFileSync(file, JSON.stringify(value));
		boundary.applyMapFile(file);
	}
	function dispose(): void {
		tracker.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return { h, tracker, boundary, terminal, file, changes, report, dispose };
}

test("missing, malformed and legacy reports become unknown, never an idle completion", () => {
	const s = reports();
	try {
		for (const damage of ["missing", "malformed", "null", "legacy", "invalid-state"] as const) {
			s.report({ sessionFile: "/a", state: "working" });
			if (damage === "missing") fs.rmSync(s.file);
			else if (damage === "malformed") fs.writeFileSync(s.file, "{");
			else if (damage === "null") fs.writeFileSync(s.file, "null");
			else fs.writeFileSync(s.file, JSON.stringify({ sessionFile: "/a", ...(damage === "invalid-state" ? { state: "broken" } : {}) }));
			s.boundary.applyMapFile(s.file);
			assert.equal(s.tracker.openSessions().get("/a")?.state, "unknown", damage);
			assert.equal(s.changes.at(-1)?.previous, "working");
			assert.equal(s.changes.at(-1)?.state, "unknown");
			s.report({ sessionFile: "/a", state: "idle" });
			assert.equal(s.changes.at(-1)?.previous, "unknown");
		}
		assert.equal(s.changes.some((change) => change.previous === "working" && change.state === "idle"), false);
	} finally { s.dispose(); }
});

test("switching transcripts resets transition identity even if the terminal keeps working", () => {
	const s = reports();
	try {
		s.report({ sessionFile: "/a", state: "working" });
		s.report({ sessionFile: "/b", state: "idle" });
		assert.equal(s.changes.at(-1)?.sessionFile, "/b");
		assert.equal(s.changes.at(-1)?.previous, undefined);
		assert.equal(s.changes.at(-1)?.workedMs, undefined);
		assert.equal(s.tracker.openSessions().has("/a"), false);
		s.report({ sessionFile: "/a", state: "working" });
		s.report({ sessionFile: "/b", state: "working" });
		assert.equal(s.changes.at(-1)?.previous, undefined);
		s.report({ sessionFile: "/b", state: "idle" });
		assert.equal(s.changes.at(-1)?.previous, "working");
		assert.equal(typeof s.changes.at(-1)?.workedMs, "number");
	} finally { s.dispose(); }
});

test("cwd changes retain same-session transitions and duplicate reports do not emit twice", () => {
	const s = reports();
	try {
		s.report({ sessionFile: "/a", state: "working", cwd: "/one" });
		s.report({ sessionFile: "/a", state: "idle", cwd: "/two" });
		assert.equal(s.changes.at(-1)?.previous, "working");
		const count = s.changes.length;
		s.report({ sessionFile: "/a", state: "idle", cwd: "/two" });
		assert.equal(s.changes.length, count);
	} finally { s.dispose(); }
});

test("existing explicit opens acknowledge after show, preserveFocus never acknowledges", async () => {
	const s = reports();
	try {
		const old = s.h.terminal("old");
		s.h.activate(old);
		const reveals: RevealSession[] = [];
		s.tracker.onDidRevealSession((change) => {
			reveals.push(change);
			assert.equal(s.h.window.activeTerminal, s.terminal);
		});
		await s.tracker.open({ sessionFile: "/a" });
		assert.equal(reveals.length, 1);
		assert.equal(reveals[0].terminal, s.terminal);
		await s.tracker.open({ sessionFile: "/a", preserveFocus: true });
		assert.equal(reveals.length, 1);
	} finally { s.dispose(); }
});

test("automatic restoration tracks its terminal without explicit reveal", async () => {
	const s = reports();
	try {
		let revealed = 0;
		s.tracker.onDidRevealSession(() => { revealed++; });
		await s.boundary.restore([{ sessionFile: "/restored", cwd: "/project" }]);
		assert.ok(s.tracker.openSessions().get("/restored")?.terminal);
		assert.equal(revealed, 0);
		assert.equal(s.tracker.isRestoring, false);
	} finally { s.dispose(); }
});

test("new explicit resume publishes its tracked terminal after showing it", async () => {
	const s = reports();
	try {
		const old = s.h.terminal("old");
		s.h.activate(old);
		const reveals: RevealSession[] = [];
		s.tracker.onDidRevealSession((change) => {
			reveals.push(change);
			assert.equal(s.tracker.openSessions().get("/new")?.terminal, change.terminal);
			assert.equal(s.h.window.activeTerminal, change.terminal);
		});
		await s.tracker.open({ sessionFile: "/new", location: "editor" });
		assert.equal(reveals.length, 1);
		assert.equal(reveals[0].location, "editor");
	} finally { s.dispose(); }
});

test("revealExisting never launches or reveals a closed, moved or replaced target", async () => {
	const s = reports();
	try {
		let reveals = 0;
		s.tracker.onDidRevealSession(() => { reveals++; });
		const count = s.h.window.terminals.length;
		const replacement = s.h.terminal("replacement");
		assert.equal(await s.tracker.revealExisting("/a", replacement), false);
		s.report({ sessionFile: "/b", state: "idle" });
		assert.equal(await s.tracker.revealExisting("/a", s.terminal), false);
		Object.assign(s.terminal, { exitStatus: { reason: vscode.TerminalExitReason.Process, code: 0 } });
		assert.equal(await s.tracker.revealExisting("/b", s.terminal), false);
		assert.equal(reveals, 0);
		assert.equal(s.h.window.terminals.length, count + 1);
		assert.equal(s.h.window.activeTerminal, undefined);
	} finally { s.dispose(); }
});

test("revealExisting acknowledges a live exact target after showing and moving it", async () => {
	const s = reports();
	try {
		const old = s.h.terminal("old");
		s.h.activate(old);
		let moved = false;
		const commands = vscode.commands as unknown as { executeCommand: (command: string) => Promise<void> };
		commands.executeCommand = async (command) => {
			assert.equal(command, "workbench.action.terminal.moveToTerminalPanel");
			assert.equal(s.h.window.activeTerminal, s.terminal);
			moved = true;
		};
		let reveals = 0;
		s.tracker.onDidRevealSession((event) => {
			reveals++;
			assert.equal(event.terminal, s.terminal);
			assert.equal(s.h.window.activeTerminal, s.terminal);
			assert.equal(moved, true);
		});
		assert.equal(await s.tracker.revealExisting("/a", s.terminal, { location: "panel" }), true);
		assert.equal(reveals, 1);
		assert.equal(s.h.window.activeTerminal, s.terminal);
	} finally { s.dispose(); }
});

test("deleted adopted report stays unknown until proven exit, then publishes removal", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let alive = true;
	t.mock.method(process, "kill", () => {
		if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		return true;
	});
	const s = reports("pid-12345");
	try {
		s.report({ sessionFile: "/a", pid: 12345, state: "working" });
		fs.rmSync(s.file);
		s.boundary.applyMapFile(s.file);
		assert.equal(s.tracker.openSessions().get("/a")?.state, "unknown");
		t.mock.timers.tick(1000);
		assert.equal(s.tracker.openSessions().has("/a"), true);
		let removals = 0;
		s.tracker.onDidChange(() => { if (!s.tracker.openSessions().has("/a")) removals++; });
		alive = false;
		t.mock.timers.tick(1000);
		assert.equal(s.tracker.openSessions().has("/a"), false);
		assert.equal(removals, 1);
		assert.equal(s.changes.some((change) => change.state === "idle"), false);
		assert.deepEqual(s.h.writes.get("omp.openSessions"), []);
	} finally { s.dispose(); }
});

test("restored report cancels exit rechecks and uncertain PID errors retain unknown", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let probes = 0;
	t.mock.method(process, "kill", () => {
		probes++;
		throw Object.assign(new Error("uncertain"), { code: "EPERM" });
	});
	const s = reports("pid-12345");
	try {
		s.report({ sessionFile: "/a", pid: 12345, state: "working" });
		fs.rmSync(s.file);
		s.boundary.applyMapFile(s.file);
		t.mock.timers.tick(1000);
		assert.equal(s.tracker.openSessions().get("/a")?.state, "unknown");
		s.report({ sessionFile: "/a", pid: 12345, state: "working" });
		const afterRestore = probes;
		t.mock.timers.tick(5000);
		assert.equal(probes, afterRestore, "report recovery cancels pending probes");
		assert.equal(s.tracker.openSessions().get("/a")?.state, "working");
	} finally { s.dispose(); }
});

test("a surviving shell adopts a new report key only after its former agent is proven dead", async (t) => {
	let oldAlive = true;
	t.mock.method(process, "kill", (pid: number) => {
		if (pid === 12345 && !oldAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		return true;
	});
	const s = reports("pid-12345");
	try {
		Object.assign(s.terminal, { processId: Promise.resolve(999) });
		await s.boundary.notePid(s.terminal);
		s.report({ sessionFile: "/a", pid: 12345, ppid: 999, state: "working" });
		const next = path.join(path.dirname(s.file), "pid-54321.json");
		fs.writeFileSync(next, JSON.stringify({ sessionFile: "/b", pid: 54321, ppid: 999, state: "idle" }));
		s.boundary.applyMapFile(next);
		assert.equal(s.tracker.openSessions().has("/a"), true);
		assert.equal(s.tracker.openSessions().has("/b"), false);
		oldAlive = false;
		s.boundary.applyMapFile(next);
		assert.equal(s.tracker.openSessions().has("/a"), false);
		assert.equal(s.tracker.openSessions().get("/b")?.terminal, s.terminal);
		assert.equal(s.changes.at(-1)?.previous, undefined);
	} finally { s.dispose(); }
});

test("disposing a missing-report tracker cancels further PID probes", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let probes = 0;
	t.mock.method(process, "kill", () => { probes++; return true; });
	const s = reports("pid-12345");
	try {
		s.report({ sessionFile: "/a", pid: 12345, state: "working" });
		fs.rmSync(s.file);
		s.boundary.applyMapFile(s.file);
	} finally { s.dispose(); }
	const afterDisposal = probes;
	t.mock.timers.tick(5000);
	assert.equal(probes, afterDisposal);
});
