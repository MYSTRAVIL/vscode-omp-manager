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
