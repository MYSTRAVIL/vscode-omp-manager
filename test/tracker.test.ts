import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import * as vscode from "vscode";
import { anyHeld, leaseHeld } from "../src/lease";
import type { SessionIndex, SessionInfo } from "../src/sessions";
import { type LaunchOptions, TerminalTracker } from "../src/tracker";

const OLD = "C:\\s\\old.jsonl";
const NEW = "C:\\s\\new.jsonl";
const session = (file: string, id: string) => ({ file, id }) as SessionInfo;
// `old.jsonl` went on in `new.jsonl`, which `--resume old.jsonl` opens on omp 18.13.2+.
const index = {
	find: (file: string) => (file === OLD ? session(OLD, "old-id") : file === NEW ? session(NEW, "new-id") : undefined),
	continuations: (file: string) => (file === OLD ? [session(NEW, "new-id")] : []),
} as unknown as SessionIndex;

const prompts: unknown[][] = [];
let answer: string | undefined;
Object.assign(vscode.window, {
	showWarningMessage: async (...args: unknown[]) => {
		prompts.push(args);
		return answer;
	},
});
afterEach(() => {
	prompts.length = 0;
	answer = undefined;
});

/** A tracker whose lease check is `isLeased` and whose launches are recorded instead of run. */
function tracker(isLeased: (ids: readonly string[]) => Promise<boolean>) {
	const asked: (readonly string[])[] = [];
	const launched: LaunchOptions[] = [];
	const t = new TerminalTracker({} as vscode.ExtensionContext, "hook.ts", index, (ids) => {
		asked.push(ids);
		return isLeased(ids);
	});
	Object.assign(t, { launch: (opts: LaunchOptions) => launched.push(opts) });
	return { t, asked, launched };
}

test("resuming a session another omp holds asks first, and Cancel launches nothing", async () => {
	const { t, asked, launched } = tracker(async () => true);
	await t.open({ sessionFile: OLD, cwd: "C:\\work" });
	assert.deepEqual(asked, [["old-id", "new-id"]], "asks about the file and the copies it went on in");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0][0], "This session is open in another omp process.");
	const options = prompts[0][1];
	assert.ok(options && typeof options === "object" && "modal" in options && options.modal === true, "modal");
	assert.deepEqual(prompts[0].slice(2), ["Open a fork"], "Cancel is the modal's own close button");
	assert.deepEqual(launched, []);
});

test("Open a fork resumes a held session as before", async () => {
	const { t, launched } = tracker(async () => true);
	answer = "Open a fork";
	await t.open({ sessionFile: NEW, cwd: "C:\\work", location: "panel" });
	assert.deepEqual(launched, [{ sessionFile: NEW, cwd: "C:\\work", location: "panel" }]);
});

test("a session no other omp holds, or whose lease check failed, resumes without a prompt", async () => {
	const { t, launched } = tracker(async () => false);
	await t.open({ sessionFile: OLD });
	assert.equal(prompts.length, 0);
	assert.deepEqual(launched, [{ sessionFile: OLD }]);
});

test("a session missing from the index and a new session launch without a lease check", async () => {
	const { t, asked, launched } = tracker(async () => true);
	await t.open({ sessionFile: "C:\\s\\unlisted.jsonl" });
	await t.open({ cwd: "C:\\work" });
	assert.deepEqual(asked, []);
	assert.equal(prompts.length, 0);
	assert.equal(launched.length, 2);
});

test("a second click during the lease check launches once", async () => {
	// lib is ES2022, which has no Promise.withResolvers.
	let release!: (held: boolean) => void;
	const lease = new Promise<boolean>((resolve) => (release = resolve));
	const { t, launched } = tracker(() => lease);
	const first = t.open({ sessionFile: OLD });
	await t.open({ sessionFile: OLD });
	release(false);
	await first;
	assert.equal(launched.length, 1);
});

test("anyHeld reads omp 18.16.0 lease output and rejects anything else", () => {
	const out = '{"held":["01a1a08a-9539-7185-8d1d-27be486a41d9"],"unknown":[]}\n';
	assert.equal(anyHeld(out, ["other", "01a1a08a-9539-7185-8d1d-27be486a41d9"]), true);
	assert.equal(anyHeld(out, ["other"]), false);
	assert.equal(anyHeld('{"held":[],"unknown":[]}', ["other"]), false);
	assert.throws(() => anyHeld("error: Unknown action lease", ["x"]), "an omp without the lease action");
	assert.throws(() => anyHeld("{}", ["x"]));
});

test("leaseHeld answers false when omp cannot run", async () => {
	const pathVar = process.env.PATH;
	process.env.PATH = "";
	try {
		assert.equal(await leaseHeld(["x"]), false);
	} finally {
		process.env.PATH = pathVar;
	}
});

test("terminalOf finds an open omp terminal by the session id or the omp pid its hook reported", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-tracker-"));
	try {
		const ctx = { workspaceState: { get: () => [], update: async () => {} } } as unknown as vscode.ExtensionContext;
		const t = new TerminalTracker(ctx, "hook.ts", index);
		const inner = t as unknown as { track(terminal: vscode.Terminal, key: string, cwd: string): unknown; applyMapFile(file: string): void };
		const [a, b, unreported] = ["a", "b", "unreported"].map((name) => ({ name }) as vscode.Terminal);
		for (const [key, terminal] of [["key-a", a], ["key-b", b], ["key-u", unreported]] as const) inner.track(terminal, key, "C:\\work");
		// What the hook writes. A record whose pid is not alive counts as stale, so a is this process.
		const report = (key: string, fields: Record<string, unknown>) => {
			const file = path.join(dir, `${key}.json`);
			fs.writeFileSync(file, JSON.stringify({ sessionFile: OLD, cwd: "C:\\work", state: "idle", ...fields }));
			inner.applyMapFile(file);
		};
		report("key-a", { pid: process.pid, sessionId: "id-a" });
		report("key-b", { sessionId: "id-b" });

		assert.equal(t.terminalOf("id-a", 1), a, "by session id");
		assert.equal(t.terminalOf("other", process.pid), a, "by omp pid");
		assert.equal(t.terminalOf("id-b", 1), b, "a record without a pid still names its session");
		assert.equal(t.terminalOf("other", 1), undefined, "neither");

		// The session in a terminal changes: /new, /resume, a fork. The record keeps its key and gets a new file.
		report("key-a", { pid: process.pid, sessionId: "id-a2", sessionFile: NEW });
		assert.equal(t.terminalOf("id-a", 1), undefined, "the old session is gone from it");
		assert.equal(t.terminalOf("id-a2", 1), a);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
