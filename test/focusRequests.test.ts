import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import * as vscode from "vscode";
import { type FocusRequest, FocusRequestHandler, launcherEnv, parseFocusRequest, takeFocusRequest, workspaceTarget } from "../src/focusRequests";
import type { TerminalTracker } from "../src/tracker";

const ID = "c1b8e775-b0c9-4e1e-8f0a-4d3c9a430d2f";
const NOW = 1_794_700_000_000;
const HOUR = 60 * 60 * 1000;
const SESSION = "01a1a08a-9539-7185-8d1d-27be486a41d9";
const PID = 12345;
const APP = path.join(os.tmpdir(), "omp-focus-test", "app");

function request(fields: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: ID,
		requester: "my-dashboard",
		sessionId: SESSION,
		pid: PID,
		createdAt: NOW,
		expiresAt: NOW + 2000,
		...fields,
	};
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-focus-"));
});

function write(name: string, value: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

const runsSession = (req: FocusRequest) => req.sessionId === SESSION;

test("a valid v1 focus request parses; a wrong version, id, or field type does not", () => {
	const { v, requester, ...fields } = request();
	assert.deepEqual(parseFocusRequest(JSON.stringify(request()), ID), fields);
	assert.equal(parseFocusRequest("{not json", ID), undefined);
	assert.equal(parseFocusRequest("null", ID), undefined);
	assert.equal(parseFocusRequest(JSON.stringify(request({ v: 2 })), ID), undefined);
	assert.equal(parseFocusRequest(JSON.stringify(request()), "0d2f6c1b-other-id"), undefined, "id must equal the file name");
	assert.equal(parseFocusRequest(JSON.stringify(request({ id: "..\\..\\x" })), "..\\..\\x"), undefined, "id pattern");
	assert.equal(parseFocusRequest(JSON.stringify(request({ id: "short" })), "short"), undefined, "id length");
	assert.equal(parseFocusRequest(JSON.stringify(request({ sessionId: undefined })), ID), undefined, "no session id");
	assert.equal(parseFocusRequest(JSON.stringify(request({ sessionId: "" })), ID), undefined, "empty session id");
	assert.equal(parseFocusRequest(JSON.stringify(request({ sessionId: 7 })), ID), undefined);
	assert.equal(parseFocusRequest(JSON.stringify(request({ pid: undefined })), ID), undefined, "no pid");
	assert.equal(parseFocusRequest(JSON.stringify(request({ pid: "12345" })), ID), undefined);
	assert.equal(parseFocusRequest(JSON.stringify(request({ pid: 0 })), ID), undefined, "pid 0");
	assert.equal(parseFocusRequest(JSON.stringify(request({ pid: -4 })), ID), undefined, "negative pid");
	assert.equal(parseFocusRequest(JSON.stringify(request({ pid: 1.5 })), ID), undefined, "fractional pid");
	assert.equal(parseFocusRequest(JSON.stringify(request({ createdAt: "now" })), ID), undefined);
	assert.equal(parseFocusRequest(JSON.stringify(request({ expiresAt: "soon" })), ID), undefined);
});

test("a request for a session this window runs is claimed once, and an existing claim is left alone", () => {
	write(`${ID}.json`, request());
	const taken = takeFocusRequest(dir, `${ID}.json`, runsSession, NOW);
	assert.equal(taken?.id, ID);
	const claim = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.claim`), "utf8"));
	assert.equal(claim.by, "omp-manager");
	assert.equal(takeFocusRequest(dir, `${ID}.json`, runsSession, NOW), undefined, "already claimed");

	const other = "7f0a4d3c-9a43-0d2f-6c1b-8e775b0c9e1e";
	write(`${other}.json`, request({ id: other }));
	const theirs = write(`${other}.claim`, { by: "another-window", pid: 1, at: NOW });
	assert.equal(takeFocusRequest(dir, `${other}.json`, runsSession, NOW), undefined);
	assert.deepEqual(JSON.parse(fs.readFileSync(theirs, "utf8")), { by: "another-window", pid: 1, at: NOW });
});

test("a window that runs neither the session nor the process leaves the request unclaimed", () => {
	write(`${ID}.json`, request());
	const asked: FocusRequest[] = [];
	assert.equal(takeFocusRequest(dir, `${ID}.json`, (req) => (asked.push(req), false), NOW), undefined);
	assert.equal(asked.length, 1, "the window was asked once");
	assert.deepEqual([asked[0].sessionId, asked[0].pid], [SESSION, PID], "with what to match on");
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), false, "no claim, so a window that runs it still can");
	assert.equal(takeFocusRequest(dir, `${ID}.json`, runsSession, NOW)?.id, ID);
});

test("expired, invalid, and non-request files are not claimed", () => {
	write(`${ID}.json`, request());
	assert.equal(takeFocusRequest(dir, `${ID}.json`, runsSession, NOW + 2000), undefined, "at expiresAt");
	assert.equal(takeFocusRequest(dir, `${ID}.json`, runsSession, NOW + 2001), undefined, "after expiresAt");
	write("bad-request-001.json", request({ id: "bad-request-001", pid: "x" }));
	assert.equal(takeFocusRequest(dir, "bad-request-001.json", () => true, NOW), undefined, "invalid");
	assert.equal(takeFocusRequest(dir, `${ID}.claim`, () => true, NOW), undefined, "a claim file");
	assert.equal(takeFocusRequest(dir, `${ID}.json.4242.tmp`, () => true, NOW), undefined, "a temp file");
	assert.equal(takeFocusRequest(dir, "gone-request-01.json", () => true, NOW), undefined, "a file that is gone");
	assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".claim")), []);
});

test("a workspace is raised by its saved workspace file, else by its first local folder", () => {
	const file = { scheme: "file", fsPath: path.join(APP, "app.code-workspace") };
	const untitled = { scheme: "untitled", fsPath: "/Untitled-1" };
	const folder = (fsPath: string, scheme = "file") => ({ uri: { scheme, fsPath } });
	assert.equal(workspaceTarget(file, [folder(APP), folder(`${APP}2`)]), file.fsPath, "a saved workspace is found by its file, not a folder");
	assert.equal(workspaceTarget(undefined, [folder("vfs", "vscode-vfs"), folder(APP), folder(`${APP}2`)]), APP, "the first file: folder");
	assert.equal(workspaceTarget(untitled, [folder(APP)]), undefined, "an untitled workspace has nothing a launcher can name");
	assert.equal(workspaceTarget(undefined, [folder("vfs", "vscode-vfs")]), undefined, "no local folder");
	assert.equal(workspaceTarget(undefined, []), undefined);
	assert.equal(workspaceTarget(undefined, undefined), undefined, "an empty window");
});

test("the launcher gets VS Code's own sanitized environment, not the extension host's", () => {
	const env = {
		ELECTRON_RUN_AS_NODE: "1",
		ELECTRON_NO_ASAR: "1",
		VSCODE_IPC_HOOK: "\\\\.\\pipe\\x-main-sock",
		VSCODE_PID: "4242",
		VSCODE_CWD: "C:\\",
		SNAP_NAME: "code",
		GDK_PIXBUF_MODULE_FILE: "x",
		VSCODE_PORTABLE: "D:\\portable",
		VSCODE_SHELL_LOGIN: "1",
		PATH: "C:\\bin",
		SystemRoot: "C:\\Windows",
	};
	assert.deepEqual(launcherEnv(env), { VSCODE_PORTABLE: "D:\\portable", VSCODE_SHELL_LOGIN: "1", PATH: "C:\\bin", SystemRoot: "C:\\Windows" });
	assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "the input is left alone");
});

// The handler, driven through start() with a fake tracker and a recording raise.
interface Window {
	focused: boolean;
	workspaceFile?: { scheme: string; fsPath: string };
	folders?: { uri: { scheme: string; fsPath: string } }[];
}

const shown: unknown[] = [];
const raised: string[] = [];
const logs: string[] = [];
let handler: FocusRequestHandler | undefined;
// Called by the fake terminal's show(), so a test can wait for the signal instead of a delay.
let onShow: (() => void) | undefined;

function open(win: Window, runs: Record<string, vscode.Terminal | undefined>, raise: (workspace: string) => Promise<void> = async (w) => void raised.push(w)) {
	Object.assign(vscode.window, { state: { focused: win.focused, active: win.focused } });
	Object.assign(vscode.workspace, { workspaceFile: win.workspaceFile, workspaceFolders: win.folders });
	const log = (level: string) => (message: string) => void logs.push(`${level}: ${message}`);
	const tracker = {
		log: { info: log("info"), warn: log("warn"), error: log("error") },
		terminalOf: (sessionId: string, pid: number) => runs[sessionId] ?? runs[`pid:${pid}`],
	} as unknown as Pick<TerminalTracker, "terminalOf" | "log">;
	handler = new FocusRequestHandler(tracker, dir, raise);
	handler.start();
}

const terminal = {
	show: (preserveFocus?: boolean) => {
		shown.push(preserveFocus);
		onShow?.();
	},
} as unknown as vscode.Terminal;
const inApp = (focused: boolean): Window => ({ focused, folders: [{ uri: { scheme: "file", fsPath: APP } }] });

// One hook, in this order: a watcher holds its directory open, and Windows will not delete it meanwhile.
afterEach(() => {
	handler?.dispose();
	handler = undefined;
	onShow = undefined;
	shown.length = raised.length = logs.length = 0;
	fs.rmSync(dir, { recursive: true, force: true });
});

test("the window that runs the session claims the request, shows its terminal with focus, and raises itself in the background", () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	open(inApp(false), { [SESSION]: terminal });
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${ID}.claim`), "utf8")).by, "omp-manager");
	assert.deepEqual(shown, [false], "terminal.show(false) takes focus");
	assert.deepEqual(raised, [APP]);
	assert.ok(logs.some((l) => l.includes(ID)), "the claim is logged");
});

test("a request names the terminal by omp pid when its session id is unknown to the window", () => {
	write(`${ID}.json`, request({ sessionId: "another-session", expiresAt: Date.now() + 60_000 }));
	open(inApp(true), { [`pid:${PID}`]: terminal });
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), true);
	assert.deepEqual(shown, [false]);
});

test("a focused window only shows the terminal", () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	open(inApp(true), { [SESSION]: terminal });
	assert.deepEqual(shown, [false]);
	assert.deepEqual(raised, []);
});

test("a window that does not run the session leaves the request for the one that does", () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	open(inApp(false), {});
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), false);
	assert.deepEqual(shown, []);
	assert.deepEqual(raised, []);
});

test("an expired request is ignored even when the window runs the session", () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() - 1 }));
	open(inApp(false), { [SESSION]: terminal });
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), false);
	assert.deepEqual(shown, []);
});

test("a window with no workspace on disk shows the terminal and says it cannot raise itself", () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	open({ focused: false }, { [SESSION]: terminal });
	assert.deepEqual(shown, [false]);
	assert.deepEqual(raised, []);
	assert.ok(logs.some((l) => l.startsWith("warn:") && l.includes("raise")), "the warning says why");
});

test("a saved workspace window raises itself by the workspace file", () => {
	const workspaceFile = { scheme: "file", fsPath: path.join(APP, "app.code-workspace") };
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	open({ ...inApp(false), workspaceFile }, { [SESSION]: terminal });
	assert.deepEqual(raised, [workspaceFile.fsPath]);
});

test("a raise that fails is logged, not thrown", async () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	const failed = Promise.reject(new Error("spawn EACCES"));
	open(inApp(false), { [SESSION]: terminal }, () => failed);
	// Runs after the handler's own rejection handler, which was attached first.
	await failed.catch(() => undefined);
	assert.ok(logs.some((l) => l.startsWith("warn:") && l.includes("spawn EACCES")), logs.join("\n"));
	assert.deepEqual(shown, [false], "the terminal was shown before the raise failed");
});

// Waits on the watcher's real event, so the test's own timeout is the only clock.
test("a request written after start is taken, and activation sweeps old leftovers", { timeout: 10_000 }, async () => {
	const old = (file: string) => fs.utimesSync(file, (Date.now() - 2 * HOUR) / 1000, (Date.now() - 2 * HOUR) / 1000);
	write("stale-request-0001.json", request({ id: "stale-request-0001", expiresAt: Date.now() - HOUR - 1 }));
	write("stale-request-0001.claim", {});
	old(write("orphan-claim-0001.claim", {}));
	open(inApp(true), { [SESSION]: terminal });
	assert.deepEqual(fs.readdirSync(dir), [], "the sweep removed what expired over an hour ago");
	// The requester writes through a temp file and a rename, so the watcher sees the final name.
	const tmp = write(`${ID}.json.${process.pid}.tmp`, request({ expiresAt: Date.now() + 60_000 }));
	const seen = new Promise<void>((resolve) => (onShow = resolve));
	fs.renameSync(tmp, path.join(dir, `${ID}.json`));
	await seen;
	assert.deepEqual(shown, [false]);
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), true);
});
