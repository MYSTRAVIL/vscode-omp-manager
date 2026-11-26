import { execFile } from "node:child_process";
import { ompExecutable } from "./config";

/**
 * Whether `omp session lease --json` output lists any of `ids` as held. Throws on output
 * that is not a lease report.
 */
export function anyHeld(stdout: string, ids: readonly string[]): boolean {
	const held: unknown = JSON.parse(stdout).held;
	if (!Array.isArray(held)) throw new Error("no held list");
	return ids.some((id) => held.includes(id));
}

/**
 * Whether a running omp anywhere owns any of sessions `ids`, asked without taking ownership
 * (`omp session lease`, omp 18.14.1+). False when omp cannot answer, as older ones cannot.
 */
export function leaseHeld(ids: readonly string[]): Promise<boolean> {
	if (!ids.length) return Promise.resolve(false);
	return new Promise((resolve) => {
		execFile(ompExecutable(), ["session", "lease", "--json", "--", ...ids], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
			try {
				if (err) throw err;
				resolve(anyHeld(stdout, ids));
			} catch {
				resolve(false);
			}
		});
	});
}
