import assert = require("node:assert/strict");
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SessionPins } from "../src/pins";

const record = (id: string) => ({ id, file: path.resolve(`${id.replace(/[^a-z]/gi, "_")}.jsonl`), title: id, cwd: path.resolve("project") });

test("independent windows preserve each other's pins across refresh without replacing the whole set", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pins-"));
	const a = new SessionPins(dir), b = new SessionPins(dir);
	try {
		// Both windows started with an empty snapshot; b must not overwrite a's record.
		a.pin(record("a"));
		b.pin(record("b"));
		a.refresh();
		assert.deepEqual(a.list().map((p) => p.id).sort(), ["a", "b"]);
		a.unpin("a");
		assert.equal(a.has("a"), false, "the issuing window updates synchronously");
		b.refresh();
		assert.deepEqual(b.list().map((p) => p.id), ["b"]);
	} finally {
		a.dispose(); b.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("pins survive restart, moved paths keep the same ID, branches do not inherit pins", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pins-"));
	let pins = new SessionPins(dir);
	try {
		const original = record("session");
		pins.pin(original);
		pins.dispose();
		pins = new SessionPins(dir);
		assert.equal(pins.has("session"), true);
		assert.equal(pins.has("branch"), false);
		const moved = { ...original, file: path.resolve("moved/session.jsonl") };
		pins.pin(moved);
		assert.deepEqual(pins.list(), [{ version: 1, ...moved }]);
		pins.unpin("session");
		pins.dispose();
		pins = new SessionPins(dir);
		assert.deepEqual(pins.list(), []);
	} finally {
		pins.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("record names derive from IDs rather than paths; mismatched identities are not accepted", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-pins-"));
	const pins = new SessionPins(dir);
	try {
		const original = record("../../special/id");
		pins.pin(original);
		const name = `${crypto.createHash("sha256").update(original.id).digest("hex")}.json`;
		assert.deepEqual(fs.readdirSync(dir), [name]);
		fs.writeFileSync(path.join(dir, name), JSON.stringify({ version: 1, ...original, id: "different" }));
		pins.refresh();
		assert.equal(pins.has(original.id), false);
		assert.equal(pins.has("different"), false);
	} finally {
		pins.dispose();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
