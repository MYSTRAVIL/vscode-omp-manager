import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import type { SessionStateV1 } from "@mystravil/omp-session-core";
import { emit, pi, publish, publishedEarlier } from "./fake-core";
import hook from "../hook/vscode-session-restore";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hook-"));
const sessionFile = path.join(agentDir, "sessions", "-work-proj", "s.jsonl");
const mapDir = path.join(agentDir, "vscode-terminals");
const mapFile = path.join(mapDir, "test-terminal.json");
after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

hook(pi);

const terminal = { pid: 4242, ppid: 4241, vscodeTerminal: "test-terminal" };

/** A main session in a VS Code terminal, as the core publishes it. */
function session(fields: Partial<Omit<SessionStateV1, "v" | "at">> = {}): Omit<SessionStateV1, "v" | "at"> {
	return { sessionId: "sid", sessionFile, cwd: "C:\\work\\proj", subagent: false, status: "idle", terminal, ...fields };
}

function record(file = mapFile): Record<string, unknown> | undefined {
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

function exitWith(file: string, data: unknown): void {
	fs.writeFileSync(file, `${JSON.stringify({ type: "custom", customType: "session_exit", data })}\n`);
}

beforeEach(() => {
	fs.rmSync(mapDir, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "");
});

test("reports session, cwd, and terminal under the terminal key", () => {
	publish(session());
	const rec = record();
	assert.equal(rec?.sessionFile, sessionFile);
	assert.equal(rec?.sessionId, "sid");
	assert.equal(rec?.cwd, "C:\\work\\proj");
	assert.equal(rec?.pid, 4242);
	assert.equal(rec?.ppid, 4241);
	assert.equal(rec?.terminalId, "test-terminal");
	assert.equal(rec?.state, "idle");
});

test("reports busy as working, and any wait on the user as waiting", () => {
	publish(session({ status: "busy" }));
	assert.equal(record()?.state, "working");
	publish(session({ status: "busy", waitingOn: "ask" }));
	assert.equal(record()?.state, "waiting");
	publish(session({ status: "busy", waitingOn: "approval" }));
	assert.equal(record()?.state, "waiting");
	// omp ends the turn before it opens a plan review.
	publish(session({ status: "idle", waitingOn: "plan-review" }));
	assert.equal(record()?.state, "waiting");
	publish(session({ status: "idle" }));
	assert.equal(record()?.state, "idle");
});

test("writes the first state at session start when another copy of the core published it before the hook subscribed", () => {
	publishedEarlier(session());
	assert.equal(record(), undefined);
	emit("session_start");
	assert.equal(record()?.state, "idle");
	assert.equal(record()?.sessionId, "sid");
});

test("keys omp started by hand in a shell terminal by its pid", () => {
	publish(session({ terminal: { pid: 4242, ppid: 4241 } }));
	const rec = record(path.join(mapDir, "pid-4242.json"));
	assert.equal(rec?.sessionId, "sid");
	assert.equal(rec?.terminalId, undefined);
});

test("ignores sessions without a terminal or a session file", () => {
	publish(session({ subagent: true, terminal: undefined }));
	publish(session({ sessionFile: undefined }));
	publish(session({ terminal: { ...terminal, vscodeTerminal: "../escape" } }));
	assert.equal(fs.existsSync(mapDir), false);
});

test("removes the record on a deliberate exit and keeps it when VS Code closes or omp crashes", () => {
	publish(session());
	exitWith(sessionFile, { kind: "signal", reason: "sighup" });
	emit("session_shutdown");
	assert.ok(record(), "SIGHUP from a closing VS Code keeps the record for restore");

	exitWith(sessionFile, { kind: "fatal" });
	emit("session_shutdown");
	assert.ok(record(), "a crash keeps the record for restore");

	exitWith(sessionFile, { kind: "exit" });
	emit("session_shutdown");
	assert.equal(record(), undefined);
});

test("reads the exit from the file the session moved to", () => {
	const moved = path.join(path.dirname(sessionFile), "moved.jsonl");
	publish(session());
	publish(session({ sessionId: "sid-2", sessionFile: moved, movedFrom: "sid", status: "busy" }));
	assert.equal(record()?.sessionFile, moved);
	exitWith(moved, { kind: "exit" });
	emit("session_shutdown");
	assert.equal(record(), undefined);
});

test("never throws into omp, even when the record cannot be written", () => {
	// A directory where the map file should go makes the rename fail.
	fs.mkdirSync(mapFile, { recursive: true });
	assert.doesNotThrow(() => publish(session({ status: "busy", waitingOn: "ask" })));
});
