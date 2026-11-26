import assert = require("node:assert/strict");
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { marksWindow, matchesFolder, parseRequest, sweep, takeRequest } from "../src/launchRequests";

const ID = "5b0c9e1e-7f0a-4d3c-9a43-0d2f6c1b8e77";
const NOW = 1_794_700_000_000;
const HOUR = 60 * 60 * 1000;
const APP = path.join(os.tmpdir(), "omp-launch-test", "app");

function request(fields: Record<string, unknown> = {}) {
	return {
		v: 1,
		id: ID,
		requester: "omp-remote",
		cwd: APP,
		args: ["--model", "anthropic/claude-sonnet-5", "--approval-mode", "yolo"],
		env: { OMP_REMOTE_SPAWN_ID: "k3j", OMP_REMOTE_MODE: "collab" },
		newWindow: false,
		createdAt: NOW,
		expiresAt: NOW + 1500,
		...fields,
	};
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launch-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function write(name: string, value: unknown): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
	return file;
}

test("a valid v1 request parses; a wrong version, id, or field type does not", () => {
	const { v, requester, ...fields } = request();
	assert.deepEqual(parseRequest(JSON.stringify(request()), ID), fields);
	assert.equal(parseRequest("{not json", ID), undefined);
	assert.equal(parseRequest(JSON.stringify(request({ v: 2 })), ID), undefined);
	assert.equal(parseRequest(JSON.stringify(request()), "0d2f6c1b-other-id"), undefined, "id must equal the file name");
	assert.equal(parseRequest(JSON.stringify(request({ id: "..\\..\\x" })), "..\\..\\x"), undefined, "id pattern");
	assert.equal(parseRequest(JSON.stringify(request({ id: "short" })), "short"), undefined, "id length");
	assert.equal(parseRequest(JSON.stringify(request({ cwd: "app" })), ID), undefined, "relative cwd");
	assert.equal(parseRequest(JSON.stringify(request({ args: ["--model", 5] })), ID), undefined);
	assert.equal(parseRequest(JSON.stringify(request({ env: { OMP_REMOTE_MODE: 1 } })), ID), undefined);
	assert.equal(parseRequest(JSON.stringify(request({ newWindow: undefined })), ID), undefined);
	assert.equal(parseRequest(JSON.stringify(request({ expiresAt: "soon" })), ID), undefined);
});

test("only the exact folder matches a request's cwd", () => {
	assert.equal(matchesFolder(APP, [path.join(APP, "src"), APP]), true);
	assert.equal(matchesFolder(APP + path.sep, [APP]), true, "trailing separator on the request");
	assert.equal(matchesFolder(APP, [APP + path.sep]), true, "trailing separator on the folder");
	assert.equal(matchesFolder(APP, [path.dirname(APP)]), false, "parent folder");
	assert.equal(matchesFolder(APP, [path.join(APP, "src")]), false, "child folder");
	assert.equal(matchesFolder(APP, [`${APP}2`]), false, "sibling with the same prefix");
	// Windows paths are case-insensitive; elsewhere case matters.
	assert.equal(matchesFolder(APP.toUpperCase(), [APP]), process.platform === "win32");
});

test("a request for an open folder is claimed once, and an existing claim is left alone", () => {
	write(`${ID}.json`, request());
	const taken = takeRequest(dir, `${ID}.json`, [APP], NOW);
	assert.equal(taken?.id, ID);
	const claim = JSON.parse(fs.readFileSync(path.join(dir, `${ID}.claim`), "utf8"));
	assert.equal(claim.by, "omp-manager");
	assert.equal(takeRequest(dir, `${ID}.json`, [APP], NOW), undefined, "already claimed");

	const other = "7f0a4d3c-9a43-0d2f-6c1b-8e775b0c9e1e";
	write(`${other}.json`, request({ id: other }));
	const theirs = write(`${other}.claim`, { by: "omp-remote", pid: 1, at: NOW });
	assert.equal(takeRequest(dir, `${other}.json`, [APP], NOW), undefined);
	assert.deepEqual(JSON.parse(fs.readFileSync(theirs, "utf8")), { by: "omp-remote", pid: 1, at: NOW });
});

test("expired requests and requests for other folders are not claimed", () => {
	write(`${ID}.json`, request());
	assert.equal(takeRequest(dir, `${ID}.json`, [path.join(APP, "src"), path.dirname(APP)], NOW), undefined);
	assert.equal(takeRequest(dir, `${ID}.json`, [APP], NOW + 1500), undefined, "at expiresAt");
	assert.equal(fs.existsSync(path.join(dir, `${ID}.claim`)), false);
});

test("of several processes racing for one request, exactly one claims it", async () => {
	write(`${ID}.json`, request({ expiresAt: Date.now() + 60_000 }));
	const setup = path.join(__dirname, "setup.js");
	const mod = path.join(__dirname, "..", "src", "launchRequests.js");
	const startAt = Date.now() + 1500;
	// Each process spins until the same moment, then tries to take the request.
	const script = `const { takeRequest } = require(${JSON.stringify(mod)});
while (Date.now() < ${startAt});
process.stdout.write(takeRequest(${JSON.stringify(dir)}, ${JSON.stringify(`${ID}.json`)}, [${JSON.stringify(APP)}]) ? "won" : "lost");`;
	const run = promisify(execFile);
	const results = await Promise.all(Array.from({ length: 6 }, () => run(process.execPath, ["--require", setup, "-e", script])));
	assert.deepEqual(results.map((r) => r.stdout).sort(), ["lost", "lost", "lost", "lost", "lost", "won"]);
});

test("only a window that activated after a new-window request was made is marked", () => {
	const newWindow = parseRequest(JSON.stringify(request({ newWindow: true })), ID);
	const existing = parseRequest(JSON.stringify(request()), ID);
	assert.ok(newWindow && existing);
	assert.equal(marksWindow(newWindow, NOW), true, "activated at createdAt");
	assert.equal(marksWindow(newWindow, NOW + 4000), true);
	assert.equal(marksWindow(newWindow, NOW - 1), false, "already open");
	assert.equal(marksWindow(existing, NOW + 4000), false, "newWindow false");
});

test("sweep deletes requests expired over an hour ago with their claims, and keeps live ones", () => {
	const now = Date.now();
	const old = (file: string) => fs.utimesSync(file, (now - 2 * HOUR) / 1000, (now - 2 * HOUR) / 1000);
	write("stale-request-0001.json", request({ id: "stale-request-0001", expiresAt: now - HOUR - 1 }));
	write("stale-request-0001.claim", {});
	write("recent-request-01.json", request({ id: "recent-request-01", expiresAt: now - 1000 }));
	write("recent-request-01.claim", {});
	write("live-request-0001.json", request({ id: "live-request-0001", expiresAt: now + 1000 }));
	old(write("orphan-claim-0001.claim", {}));
	write("fresh-orphan-001.claim", {});
	old(write("broken-request-01.json", "{"));
	old(write("x.json.123.tmp", "{}"));
	sweep(dir, now);
	assert.deepEqual(fs.readdirSync(dir).sort(), [
		"fresh-orphan-001.claim",
		"live-request-0001.json",
		"recent-request-01.claim",
		"recent-request-01.json",
	]);
});
