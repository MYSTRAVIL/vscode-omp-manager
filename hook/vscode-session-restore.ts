// Oh My Pi extension: report which session each VS Code terminal runs, and what it is doing.
//
// The OMP Session Manager VS Code extension (vscode-omp-manager) ships this file and
// passes it to every omp it launches with `-e`. A copy also lives in llm-dotfiles
// (omp/extensions/) so omp started by hand in a VS Code shell terminal reports too.
// Keep the two identical; loading both writes the same record twice, which is harmless.
//
// It writes `<agentDir>/vscode-terminals/<key>.json` on session start, on every session
// switch (/new, /resume, /fork), and when the agent starts working, stops, or asks a
// question. The key is OMP_VSCODE_TERMINAL when the VS Code extension launched omp.
// Otherwise it is `pid-<pid>`, and the extension adopts the shell terminal whose pid
// matches our parent pid.

import * as fs from "node:fs";
import * as path from "node:path";

const MAP_DIRNAME = "vscode-terminals";
const TERMINAL_ENV = "OMP_VSCODE_TERMINAL";
const EXIT_TAIL_BYTES = 64 * 1024;
// The tool that blocks on the user's answer.
const ASK_TOOL = "ask";

/** idle: waiting for a prompt. working: the agent loop runs. waiting: blocked on an `ask` answer. */
export type SessionState = "idle" | "working" | "waiting";

interface HookApiLike {
	on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
}

interface SessionRef {
	cwd: string;
	sessionFile: string;
	sessionId: string;
}

function isFn(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

// Only interactive sessions run in a terminal worth tracking; subagents have no UI.
function sessionRef(ctx: unknown): SessionRef | null {
	if (!ctx || typeof ctx !== "object") return null;
	if (!("hasUI" in ctx) || ctx.hasUI !== true) return null;
	if (!("cwd" in ctx) || typeof ctx.cwd !== "string") return null;
	if (!("sessionManager" in ctx)) return null;
	const sm = ctx.sessionManager;
	if (!sm || typeof sm !== "object") return null;
	if (!("getSessionFile" in sm) || !("getSessionId" in sm)) return null;
	if (!isFn(sm.getSessionFile) || !isFn(sm.getSessionId)) return null;
	const sessionFile = sm.getSessionFile();
	const sessionId = sm.getSessionId();
	if (typeof sessionFile !== "string" || !sessionFile || typeof sessionId !== "string") return null;
	return { cwd: ctx.cwd, sessionFile, sessionId };
}

function mapFile(sessionFile: string): string | null {
	const key = process.env[TERMINAL_ENV] || `pid-${process.pid}`;
	// The key becomes a file name; refuse anything that could leave the directory.
	if (!/^[\w-]+$/.test(key)) return null;
	// sessionFile = <agentDir>/sessions/<bucket>/<file>.jsonl -> climb three levels.
	const agentDir = path.dirname(path.dirname(path.dirname(sessionFile)));
	return path.join(agentDir, MAP_DIRNAME, `${key}.json`);
}

function report(ctx: unknown, state: SessionState): void {
	const ref = sessionRef(ctx);
	const file = ref && mapFile(ref.sessionFile);
	if (!ref || !file) return;
	const record = {
		terminalId: process.env[TERMINAL_ENV] || undefined,
		pid: process.pid,
		ppid: process.ppid,
		sessionFile: ref.sessionFile,
		sessionId: ref.sessionId,
		cwd: ref.cwd,
		state,
		updatedAt: Date.now(),
	};
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const json = JSON.stringify(record, null, 2);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, json);
	try {
		replace(tmp, file, json);
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

// Windows refuses to replace a file another process has open (the VS Code watcher reading
// it, antivirus), which fails the rename with EPERM. Retry briefly, then write in place:
// a reader can catch that write half done, but the watcher fires again once it completes.
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 10;
function replace(tmp: string, file: string, json: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") throw err;
			if (attempt === RENAME_ATTEMPTS) break;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_MS);
		}
	}
	fs.writeFileSync(file, json);
}

// A full VS Code shutdown records a caught SIGHUP; a crash records a fatal exit.
// Those keep the record so VS Code does not treat the session as closed by hand.
function exitedDeliberately(sessionFile: string): boolean {
	let fd: number | undefined;
	try {
		fd = fs.openSync(sessionFile, "r");
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, EXIT_TAIL_BYTES);
		const bytes = Buffer.allocUnsafe(length);
		const bytesRead = fs.readSync(fd, bytes, 0, length, size - length);
		const lines = bytes.subarray(0, bytesRead).toString("utf8").split("\n");
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line.includes('"session_exit"')) continue;
			try {
				const data = JSON.parse(line)?.data;
				return !(data?.kind === "fatal" || (data?.kind === "signal" && data?.reason === "sighup"));
			} catch {
				// The initial partial line is irrelevant.
			}
		}
	} catch {
		// Unreadable session: keep the record; VS Code prunes records of dead processes.
		return false;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	return false;
}

function forget(ctx: unknown): void {
	const ref = sessionRef(ctx);
	const file = ref && mapFile(ref.sessionFile);
	if (!ref || !file || !exitedDeliberately(ref.sessionFile)) return;
	fs.rmSync(file, { force: true });
}

function isAsk(event: unknown): boolean {
	return !!event && typeof event === "object" && "toolName" in event && event.toolName === ASK_TOOL;
}

// A throwing `tool_call` handler blocks the tool, and a throw anywhere else is logged
// against the session. Reporting is best effort, so it never throws.
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// The next event rewrites the record.
	}
}

export default function (pi: HookApiLike): void {
	pi.on("session_start", (_event, ctx) => safely(() => report(ctx, "idle")));
	pi.on("session_switch", (_event, ctx) => safely(() => report(ctx, "idle")));
	pi.on("agent_start", (_event, ctx) => safely(() => report(ctx, "working")));
	pi.on("agent_end", (_event, ctx) => safely(() => report(ctx, "idle")));
	pi.on("tool_call", (event, ctx) => {
		if (isAsk(event)) safely(() => report(ctx, "waiting"));
	});
	pi.on("tool_result", (event, ctx) => {
		if (isAsk(event)) safely(() => report(ctx, "working"));
	});
	pi.on("session_shutdown", (_event, ctx) => safely(() => forget(ctx)));
}
