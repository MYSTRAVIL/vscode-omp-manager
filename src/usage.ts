import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { ompExecutable } from "./config";

export interface UsageLimit {
	label: string;
	usedPercent: number;
	resetsAt?: number;
	status: string;
}

export interface UsageProvider {
	name: string;
	limits: UsageLimit[];
}

export interface UsageSnapshot {
	providers: UsageProvider[];
	fetchedAt: number;
	error?: string;
}

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Claude",
	"openai-codex": "Codex",
	openai: "OpenAI",
	"google-gemini-cli": "Gemini",
};

// Subset of `omp usage --json`. Account metadata (email, ids) is ignored on purpose.
interface RawReport {
	provider?: string;
	limits?: Array<{
		label?: string;
		window?: { label?: string; resetsAt?: number };
		amount?: { usedFraction?: number; used?: number; limit?: number };
		status?: string;
	}>;
}

export function parseUsage(stdout: string): UsageProvider[] {
	const raw: { reports?: RawReport[] } = JSON.parse(stdout);
	const providers: UsageProvider[] = [];
	for (const report of raw.reports ?? []) {
		const id = report.provider ?? "unknown";
		const name = PROVIDER_NAMES[id] ?? id;
		const limits: UsageLimit[] = [];
		for (const l of report.limits ?? []) {
			const a = l.amount ?? {};
			const fraction =
				typeof a.usedFraction === "number"
					? a.usedFraction
					: typeof a.used === "number" && a.limit
						? a.used / a.limit
						: 0;
			const label = l.label ?? l.window?.label ?? "Limit";
			limits.push({
				// "Claude 5 Hour" under a "Claude" heading reads as "5 Hour".
				label: label.startsWith(`${name} `) ? label.slice(name.length + 1) : label,
				usedPercent: Math.round(Math.min(Math.max(fraction, 0), 1) * 100),
				resetsAt: l.window?.resetsAt,
				status: l.status ?? "ok",
			});
		}
		if (limits.length) providers.push({ name, limits });
	}
	return providers;
}

export class UsageService implements vscode.Disposable {
	private snapshot: UsageSnapshot | undefined;
	private inflight: Promise<void> | undefined;
	private readonly changed = new vscode.EventEmitter<UsageSnapshot>();
	readonly onDidChange = this.changed.event;

	get current(): UsageSnapshot | undefined {
		return this.snapshot;
	}

	refresh(): Promise<void> {
		this.inflight ??= new Promise<void>((resolve) => {
			execFile(ompExecutable(), ["usage", "--json"], { timeout: 60_000, windowsHide: true }, (err, stdout) => {
				let next: UsageSnapshot;
				try {
					if (err) throw err;
					next = { providers: parseUsage(stdout), fetchedAt: Date.now() };
				} catch (e) {
					next = {
						providers: this.snapshot?.providers ?? [],
						fetchedAt: this.snapshot?.fetchedAt ?? 0,
						error: e instanceof Error ? e.message.split("\n")[0] : String(e),
					};
				}
				this.snapshot = next;
				this.inflight = undefined;
				this.changed.fire(next);
				resolve();
			});
		});
		return this.inflight;
	}

	dispose(): void {
		this.changed.dispose();
	}
}
