import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, test } from "node:test";
import hook from "../hook/vscode-session-restore";

type Handler = (event: unknown, ctx: unknown) => unknown;

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hook-"));
const sessionFile = path.join(agentDir, "sessions", "-work-proj", "s.jsonl");
const mapFile = path.join(agentDir, "vscode-terminals", "test-terminal.json");
after(() => fs.rmSync(agentDir, { recursive: true, force: true }));

process.env.OMP_VSCODE_TERMINAL = "test-terminal";
const handlers = new Map<string, Handler>();
hook({ on: (event, handler) => void handlers.set(event, handler) });

function ctx(hasUI = true) {
	return {
		hasUI,
		cwd: "C:\\work\\proj",
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "sid" },
	};
}

function emit(event: string, payload: unknown = {}, hasUI = true): void {
	const handler = handlers.get(event);
	assert.ok(handler, `hook handles ${event}`);
	handler(payload, ctx(hasUI));
}

function record(): Record<string, unknown> | undefined {
	return fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, "utf8")) : undefined;
}

beforeEach(() => {
	fs.rmSync(mapFile, { force: true });
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	fs.writeFileSync(sessionFile, "");
});

test("reports session, cwd, and pid under the terminal key", () => {
	emit("session_start");
	const rec = record();
	assert.equal(rec?.sessionFile, sessionFile);
	assert.equal(rec?.cwd, "C:\\work\\proj");
	assert.equal(rec?.pid, process.pid);
	assert.equal(rec?.terminalId, "test-terminal");
	assert.equal(rec?.state, "idle");
});

test("tracks the agent through working, asking, and idle", () => {
	emit("session_start");
	emit("agent_start");
	assert.equal(record()?.state, "working");
	// Other tools do not change the state.
	emit("tool_call", { toolName: "bash" });
	assert.equal(record()?.state, "working");
	emit("tool_call", { toolName: "ask" });
	assert.equal(record()?.state, "waiting");
	emit("tool_result", { toolName: "ask" });
	assert.equal(record()?.state, "working");
	emit("agent_end");
	assert.equal(record()?.state, "idle");
});

test("stays working through an agent_end that omp continues", () => {
	emit("session_start");
	emit("agent_start");
	emit("agent_end", { messages: [], willContinue: true });
	assert.equal(record()?.state, "working", "a scheduled continuation or queued steer");
	emit("agent_end", { messages: [], willContinue: true, awaitingAsyncWork: true });
	assert.equal(record()?.state, "working", "a wait on background jobs");
	emit("agent_end", { messages: [] });
	assert.equal(record()?.state, "idle");
});

test("waits on a plan review and follows how it closed", () => {
	let idle = true;
	const session = { hasUI: true, cwd: "C:\\work\\proj", sessionManager: ctx().sessionManager, isIdle: () => idle };
	const send = (event: string) => handlers.get(event)?.({}, session);
	send("session_start");
	send("plan_review_requested");
	assert.equal(record()?.state, "waiting");
	send("plan_review_resolved");
	assert.equal(record()?.state, "idle", "saved or dismissed");
	send("plan_review_requested");
	idle = false;
	send("plan_review_resolved");
	assert.equal(record()?.state, "working", "approved and already executing");
});

test("ignores sessions without a UI, such as subagents", () => {
	emit("session_start", {}, false);
	emit("agent_start", {}, false);
	assert.equal(record(), undefined);
});

test("removes the record on a deliberate exit and keeps it when VS Code closes", () => {
	emit("session_start");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType: "session_exit", data: { kind: "signal", reason: "sighup" } })}\n`);
	emit("session_shutdown");
	assert.ok(record(), "SIGHUP from a closing VS Code keeps the record for restore");

	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "custom", customType: "session_exit", data: { kind: "exit" } })}\n`);
	emit("session_shutdown");
	assert.equal(record(), undefined);
});

test("never throws into omp, even when the record cannot be written", () => {
	// A directory where the map file should go makes the rename fail.
	fs.mkdirSync(mapFile, { recursive: true });
	try {
		assert.doesNotThrow(() => emit("tool_call", { toolName: "ask" }));
	} finally {
		fs.rmSync(mapFile, { recursive: true, force: true });
	}
});

// A session manager that moves like omp's: the file and id change in place, then
// `onPersistenceNotice` subscribers hear about it, with earlier moves replayed on subscribe.
function movingSession() {
	let file = sessionFile;
	let id = "sid";
	const notices: { reason: string; from: string; to: string }[] = [];
	const subscribers = new Set<(notice: unknown) => void>();
	const sm = {
		getSessionFile: () => file,
		getSessionId: () => id,
		onPersistenceNotice(cb: (notice: unknown) => void) {
			for (const notice of notices) cb(notice);
			subscribers.add(cb);
			return () => void subscribers.delete(cb);
		},
	};
	const sessionCtx = { hasUI: true, cwd: "C:\\work\\proj", sessionManager: sm };
	return {
		subscribers,
		send(event: string, payload: unknown = {}) {
			const handler = handlers.get(event);
			assert.ok(handler, `hook handles ${event}`);
			handler(payload, sessionCtx);
		},
		move(to: string, newId: string) {
			const notice = { reason: "open-elsewhere", from: file, to };
			file = to;
			id = newId;
			notices.push(notice);
			for (const cb of subscribers) cb(notice);
		},
		branch(to: string, newId: string) {
			file = to;
			id = newId;
		},
	};
}

test("follows a session that omp moves to a new file without a session event", () => {
	const session = movingSession();
	const moved = path.join(path.dirname(sessionFile), "moved.jsonl");
	session.send("session_start");
	session.send("session_switch");
	session.send("agent_start");
	assert.equal(session.subscribers.size, 1, "one subscription per session manager");

	session.move(moved, "sid-2");
	const rec = record();
	assert.equal(rec?.sessionFile, moved);
	assert.equal(rec?.sessionId, "sid-2");
	assert.equal(rec?.state, "working", "the move keeps the current state");

	fs.writeFileSync(moved, `${JSON.stringify({ type: "custom", customType: "session_exit", data: { kind: "exit" } })}\n`);
	session.send("session_shutdown");
	assert.equal(record(), undefined, "shutdown reads the exit from the new file");
	assert.equal(session.subscribers.size, 0, "shutdown unsubscribes");
});

test("reports the new file after a branch", () => {
	const session = movingSession();
	const branched = path.join(path.dirname(sessionFile), "branched.jsonl");
	session.send("session_start");
	session.branch(branched, "sid-3");
	session.send("session_branch", { reason: "btw" });
	assert.equal(record()?.sessionFile, branched);
	assert.equal(record()?.state, "idle");
	session.send("session_shutdown");
});
