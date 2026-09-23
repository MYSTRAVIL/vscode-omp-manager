import assert = require("node:assert/strict");
import { test } from "node:test";
import { parseUsage } from "../src/usage";

test("reads used fraction, reset time, and status per limit, grouped by provider", () => {
	const providers = parseUsage(
		JSON.stringify({
			reports: [
				{
					provider: "anthropic",
					limits: [
						{ label: "Claude 5 Hour", window: { resetsAt: 1700000000000 }, amount: { usedFraction: 0.624 }, status: "ok" },
						{ window: { label: "Weekly" }, amount: { used: 30, limit: 40 } },
					],
				},
				{ provider: "some-new-provider", limits: [{ label: "Daily", amount: { usedFraction: 0.1 } }] },
			],
		}),
	);
	assert.deepEqual(providers, [
		{
			id: "anthropic",
			name: "Claude",
			limits: [
				// The provider name prefix is dropped under its own heading.
				{ label: "5 Hour", usedPercent: 62, resetsAt: 1700000000000, status: "ok" },
				{ label: "Weekly", usedPercent: 75, resetsAt: undefined, status: "ok" },
			],
		},
		{ id: "some-new-provider", name: "some-new-provider", limits: [{ label: "Daily", usedPercent: 10, resetsAt: undefined, status: "ok" }] },
	]);
});

test("clamps percentages to 0-100 and survives a zero limit", () => {
	const [p] = parseUsage(
		JSON.stringify({
			reports: [
				{
					provider: "openai-codex",
					limits: [
						{ label: "Over", amount: { usedFraction: 1.7 }, status: "exhausted" },
						{ label: "Under", amount: { usedFraction: -0.2 } },
						{ label: "Zero", amount: { used: 5, limit: 0 } },
					],
				},
			],
		}),
	);
	assert.deepEqual(
		p.limits.map((l) => [l.label, l.usedPercent, l.status]),
		[
			["Over", 100, "exhausted"],
			["Under", 0, "ok"],
			["Zero", 0, "ok"],
		],
	);
});

test("drops providers that report no limits", () => {
	assert.deepEqual(parseUsage(JSON.stringify({ reports: [{ provider: "anthropic", limits: [] }, { provider: "openai" }] })), []);
});

test("throws on output that is not JSON, so the caller can show the error", () => {
	assert.throws(() => parseUsage("error: not logged in"));
});
