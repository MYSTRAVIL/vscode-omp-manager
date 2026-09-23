import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { parseSession, SessionIndex } from "../src/sessions";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-sessions-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function sessionLines(opts: { title?: string; headerTitle?: string; prompt?: string; id?: string }): string {
	const lines = [
		JSON.stringify({ type: "title", v: 1, title: opts.title ?? "", pad: " ".repeat(40) }),
		JSON.stringify({
			type: "session",
			id: opts.id ?? `id-${++n}`,
			cwd: "C:\\work\\proj",
			timestamp: "2026-09-23T01:18:39.373Z",
			...(opts.headerTitle ? { title: opts.headerTitle } : {}),
		}),
	];
	if (opts.prompt !== undefined) {
		lines.push(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: opts.prompt }] } }));
	}
	return `${lines.join("\n")}\n`;
}

function writeFile(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function parse(content: string) {
	return parseSession(writeFile(path.join(tmp, "parse", `${++n}.jsonl`), content), 1000);
}

test("parseSession prefers the title line, then the header title, then the first prompt", () => {
	assert.equal(parse(sessionLines({ title: "Fix login", headerTitle: "Old", prompt: "hi" }))?.title, "Fix login");
	assert.equal(parse(sessionLines({ headerTitle: "From header", prompt: "hi" }))?.title, "From header");
	assert.equal(parse(sessionLines({ prompt: 'say "hi"\n  twice' }))?.title, 'say "hi" twice');
});

test("parseSession reads id, cwd, and creation time from the header", () => {
	const info = parse(sessionLines({ title: "t", id: "abc" }));
	assert.equal(info?.id, "abc");
	assert.equal(info?.cwd, "C:\\work\\proj");
	assert.equal(info?.created, Date.parse("2026-09-23T01:18:39.373Z"));
	assert.equal(info?.modified, 1000);
});

test("parseSession flags sessions with no prompt as empty and skips files that are not sessions", () => {
	const empty = parse(sessionLines({}));
	assert.equal(empty?.empty, true);
	assert.ok(empty?.title, "empty sessions still get a title to show");
	assert.equal(parse(sessionLines({ prompt: "hi" }))?.empty, false);
	assert.equal(parse('{"type":"something else"}\n'), null);
	assert.equal(parse(""), null);
});

test("parseSession finds a first prompt cut off by the head limit", () => {
	const long = "x".repeat(40 * 1024);
	assert.equal(parse(sessionLines({ prompt: `start ${long}` }))?.title.slice(0, 7), "start x");
});

function nextChange(index: SessionIndex): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no change event within 5s")), 5000);
		const sub = index.onDidChange(() => {
			clearTimeout(timer);
			sub.dispose();
			resolve();
		});
	});
}

test("SessionIndex follows adds, edits, and deletes, ignoring subagent transcripts", async () => {
	const root = path.join(tmp, "index");
	const bucket = path.join(root, "-work-proj");
	const a = writeFile(path.join(bucket, "a.jsonl"), sessionLines({ title: "A" }));
	const index = new SessionIndex({ root, debounceMs: 50 });
	try {
		await index.ensure();
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A"],
		);

		// A new session plus a subagent transcript in its sibling directory.
		let change = nextChange(index);
		writeFile(path.join(bucket, "a", "sub.jsonl"), sessionLines({ title: "Subagent" }));
		const b = writeFile(path.join(bucket, "b.jsonl"), sessionLines({ title: "B" }));
		fs.utimesSync(b, new Date(), new Date(Date.now() + 60_000));
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["B", "A"],
		);

		// omp rewrites the title line when the auto title lands.
		change = nextChange(index);
		fs.writeFileSync(a, sessionLines({ title: "A renamed" }));
		fs.utimesSync(a, new Date(), new Date(Date.now() + 120_000));
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A renamed", "B"],
		);

		change = nextChange(index);
		fs.rmSync(b);
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A renamed"],
		);
		assert.equal(index.find(b), undefined);
	} finally {
		index.dispose();
	}
});

test("SessionIndex.find parses a file it has not listed without adding it to the list", async () => {
	const root = path.join(tmp, "find");
	const listed = writeFile(path.join(root, "bucket", "listed.jsonl"), sessionLines({ title: "Listed" }));
	const index = new SessionIndex({ root, debounceMs: 50 });
	try {
		await index.ensure();
		assert.equal(index.list().length, 1);
		const outside = writeFile(path.join(tmp, "elsewhere", "x.jsonl"), sessionLines({ title: "Elsewhere" }));
		assert.equal(index.find(outside)?.title, "Elsewhere");
		assert.equal(index.find(listed)?.title, "Listed");
		assert.deepEqual(
			index.list().map((s) => s.title),
			["Listed"],
		);
	} finally {
		index.dispose();
	}
});
