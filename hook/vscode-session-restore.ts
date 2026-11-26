// Oh My Pi extension: report which session each VS Code terminal runs, and what it is doing.
//
// The OMP Session Manager VS Code extension (vscode-omp-manager) bundles this file with
// @mystravil/omp-session-core into `out/hook/vscode-session-restore.js` and passes the
// bundle to every omp it launches with `-e`. Installed as a global omp extension, the
// bundle also reports for omp started by hand in a VS Code shell terminal; loading it
// twice writes the same record twice, which is harmless.
//
// omp-session-core follows the session (start, /new, /resume, /fork, /clear, branches, and
// omp moving it to a new file) and what it does (busy, idle, waiting on an `ask` answer, a
// tool approval or a plan review). This file writes each state the core publishes to
// `<agentDir>/vscode-terminals/<key>.json`. The key is OMP_VSCODE_TERMINAL when the VS Code
// extension launched omp. Otherwise it is `pid-<pid>`, and the extension adopts the shell
// terminal whose pid matches our parent pid.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type OmpExtensionApi,
	type SessionStateV1,
	type TerminalIdentity,
	startSessionCore,
} from "@mystravil/omp-session-core";

const MAP_DIRNAME = "vscode-terminals";
const EXIT_TAIL_BYTES = 64 * 1024;

/** idle: waiting for a prompt. working: the agent loop runs. waiting: blocked on the user's answer, a tool approval or a plan review. */
export type SessionState = "idle" | "working" | "waiting";

/** Where a session's record goes, and what it records about the terminal. */
interface Target {
	file: string;
	sessionFile: string;
	terminal: TerminalIdentity;
}

// The core gives `terminal` only to a session with a UI in a TTY that is not a subagent:
// the only kind that runs in a VS Code terminal. A session omp does not save has no file
// to restore.
function targetOf(state: SessionStateV1 | undefined): Target | null {
	const terminal = state?.terminal;
	const sessionFile = state?.sessionFile;
	if (!terminal || !sessionFile) return null;
	const key = terminal.vscodeTerminal || `pid-${terminal.pid}`;
	// The key becomes a file name; refuse anything that could leave the directory.
	if (!/^[\w-]+$/.test(key)) return null;
	// sessionFile = <agentDir>/sessions/<bucket>/<file>.jsonl -> climb three levels.
	const agentDir = path.dirname(path.dirname(path.dirname(sessionFile)));
	return { file: path.join(agentDir, MAP_DIRNAME, `${key}.json`), sessionFile, terminal };
}

function stateOf(state: SessionStateV1): SessionState {
	if (state.waitingOn) return "waiting";
	return state.status === "busy" ? "working" : "idle";
}

function write(state: SessionStateV1): void {
	const target = targetOf(state);
	if (!target) return;
	const { file, terminal } = target;
	const record = {
		terminalId: terminal.vscodeTerminal,
		pid: terminal.pid,
		ppid: terminal.ppid,
		sessionFile: target.sessionFile,
		sessionId: state.sessionId,
		cwd: state.cwd,
		state: stateOf(state),
		updatedAt: state.at,
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

function forget(state: SessionStateV1 | undefined): void {
	const target = targetOf(state);
	if (!target || !exitedDeliberately(target.sessionFile)) return;
	fs.rmSync(target.file, { force: true });
}

// A throw in an omp handler is logged against the session. Reporting is best effort,
// so it never throws.
function safely(fn: () => void): void {
	try {
		fn();
	} catch {
		// The next state rewrites the record.
	}
}

export default function (pi: OmpExtensionApi): void {
	// First, so the core's state is current inside this file's own handler.
	const core = startSessionCore(pi);
	core.onState((state) => safely(() => write(state)));
	pi.on("session_shutdown", () => safely(() => forget(core.state())));
}
