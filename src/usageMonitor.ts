import * as vscode from "vscode";
import { formatCountdown, refreshMinutes, type UsageLimit, type UsageService, visibleProviders, warnPercent } from "./usage";

/**
 * Usage outside the sidebar: a status bar item for the most-used limit, and a warning
 * when a limit reaches `omp.usage.warnPercent`. Refreshes in the background while
 * either is on; the sidebar keeps its own timer while visible.
 */
export class UsageMonitor implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem("omp.usage", vscode.StatusBarAlignment.Right);
	private readonly disposables: vscode.Disposable[] = [];
	// Provider id + label -> reset time of the window already warned about.
	private readonly warned = new Map<string, number | undefined>();
	private refreshTimer: NodeJS.Timeout | undefined;
	// The countdown in the item goes stale between refreshes.
	private tickTimer: NodeJS.Timeout | undefined;

	constructor(private readonly usage: UsageService) {
		this.item.name = "OMP Usage";
		this.item.command = "omp.main.focus";
		this.disposables.push(
			this.item,
			usage.onDidChange(() => this.update()),
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("omp.usage")) this.reconfigure();
			}),
		);
		this.reconfigure();
	}

	private reconfigure(): void {
		clearInterval(this.refreshTimer);
		clearInterval(this.tickTimer);
		this.refreshTimer = this.tickTimer = undefined;
		const config = vscode.workspace.getConfiguration("omp.usage");
		const statusBar = config.get<boolean>("statusBar", false);
		if (statusBar || config.get<boolean>("notifyOnWarn", true)) {
			if (!this.usage.current) void this.usage.refresh();
			this.refreshTimer = setInterval(() => void this.usage.refresh(), refreshMinutes() * 60_000);
		}
		if (statusBar) this.tickTimer = setInterval(() => this.render(), 60_000);
		this.update();
	}

	private update(): void {
		this.render();
		this.warn();
	}

	private render(): void {
		const snapshot = this.usage.current;
		if (!vscode.workspace.getConfiguration("omp.usage").get<boolean>("statusBar", false)) {
			this.item.hide();
			return;
		}
		if (!snapshot) {
			this.item.text = "$(pulse) usage…";
			this.item.tooltip = "Fetching omp usage";
			this.item.backgroundColor = undefined;
			this.item.show();
			return;
		}
		const providers = visibleProviders(snapshot.providers);
		let worst: { name: string; limit: UsageLimit } | undefined;
		const lines: string[] = [];
		for (const p of providers) {
			for (const l of p.limits) {
				if (!worst || l.usedPercent > worst.limit.usedPercent) worst = { name: p.name, limit: l };
				lines.push(`${p.name} ${l.label}: ${l.usedPercent}%${l.resetsAt ? `, resets ${resetTime(l.resetsAt)}` : ""}`);
			}
		}
		if (snapshot.error) lines.push(`Last refresh failed: ${snapshot.error}`);
		if (!worst) {
			this.item.hide();
			return;
		}
		const { name, limit } = worst;
		this.item.text = `$(pulse) ${name} ${limit.usedPercent}%${limit.resetsAt ? ` · ${formatCountdown(limit.resetsAt - Date.now())}` : ""}`;
		this.item.tooltip = lines.join("\n");
		this.item.backgroundColor =
			limit.usedPercent >= 100 || limit.status === "exhausted"
				? new vscode.ThemeColor("statusBarItem.errorBackground")
				: limit.usedPercent >= warnPercent()
					? new vscode.ThemeColor("statusBarItem.warningBackground")
					: undefined;
		this.item.show();
	}

	/** Once per limit per reset window. omp's reset time can drift between fetches, so a new window starts only once the warned one has passed. */
	private warn(): void {
		const snapshot = this.usage.current;
		if (!snapshot || !vscode.workspace.getConfiguration("omp.usage").get<boolean>("notifyOnWarn", true)) return;
		const threshold = warnPercent();
		for (const p of visibleProviders(snapshot.providers)) {
			for (const l of p.limits) {
				const key = `${p.id}\n${l.label}`;
				if (l.usedPercent < threshold) continue;
				if (this.warned.has(key)) {
					const until = this.warned.get(key);
					if (until === undefined || Date.now() < until) continue;
				}
				this.warned.set(key, l.resetsAt);
				const reset = l.resetsAt ? ` (resets ${resetTime(l.resetsAt)})` : "";
				void vscode.window.showWarningMessage(`${p.name} ${l.label} limit at ${l.usedPercent}%${reset}`);
			}
		}
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
		clearInterval(this.tickTimer);
		for (const d of this.disposables) d.dispose();
	}
}

/** Local reset time, with the weekday once it is not today. Matches the sidebar. */
function resetTime(ms: number): string {
	const d = new Date(ms);
	const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}
