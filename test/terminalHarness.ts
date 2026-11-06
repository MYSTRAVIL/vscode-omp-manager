import * as vscode from "vscode";
import { EventEmitter, stub } from "./setup";
import { TERMINAL_ENV } from "../src/tracker";

class TerminalInput {}

/** Native events can arrive tab-first or process-first; tests drive each half explicitly. */
export function terminalHarness(saved: string[] = []) {
	const active = new EventEmitter<vscode.Terminal | undefined>();
	const tabs = new EventEmitter<{ closed: vscode.Tab[] }>();
	const groups = new EventEmitter<void>();
	const focus = new EventEmitter<void>();
	const close = new EventEmitter<vscode.Terminal>();
	const opened = new EventEmitter<vscode.Terminal>();
	const writes = new Map<string, unknown>();
	const settings: Record<string, unknown> = {};
	const group = { isActive: true, activeTab: undefined as vscode.Tab | undefined };
	const window = {
		state: { focused: true }, activeTerminal: undefined as vscode.Terminal | undefined,
		terminals: [] as vscode.Terminal[],
		tabGroups: { activeTabGroup: group, onDidChangeTabs: tabs.event, onDidChangeTabGroups: groups.event },
		onDidChangeActiveTerminal: active.event, onDidChangeWindowState: focus.event,
		onDidCloseTerminal: close.event, onDidOpenTerminal: opened.event,
		createOutputChannel: () => ({ info() {}, warn() {}, dispose() {}, show() {} }),
		createTerminal: (options: vscode.TerminalOptions) => terminal(options.env?.[TERMINAL_ENV] ?? "created"),
	};
	Object.assign(stub, {
		window, TabInputTerminal: TerminalInput,
		ThemeIcon: class {}, ThemeColor: class {},
		TerminalLocation: { Panel: 1 }, ViewColumn: { Active: -1 }, TerminalExitReason: { Shutdown: 4 },
		commands: { executeCommand: async () => undefined },
	});
	stub.workspace.getConfiguration = () => ({
		get: <V>(key: string, fallback?: V) => key in settings ? settings[key] as V : fallback,
	});
	const ctx = {
		workspaceState: {
			get: (key: string) => key === "omp.unreadCompletions" ? saved : undefined,
			update: async (key: string, value: unknown) => { writes.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	function terminal(key: string, pid?: number): vscode.Terminal {
		const value = {
			creationOptions: { env: { [TERMINAL_ENV]: key } }, processId: Promise.resolve(pid),
			show: () => { window.activeTerminal = value as unknown as vscode.Terminal; active.fire(window.activeTerminal); },
		} as unknown as vscode.Terminal;
		window.terminals.push(value);
		return value;
	}
	function tab(isTerminal = true): vscode.Tab {
		return { isActive: true, input: isTerminal ? new TerminalInput() : {} } as unknown as vscode.Tab;
	}
	function select(value: vscode.Tab): void {
		group.activeTab = value;
		tabs.fire({ closed: [] });
	}
	function activate(value: vscode.Terminal): void {
		window.activeTerminal = value;
		active.fire(value);
	}
	return { ctx, window, settings, writes, terminal, tab, select, activate, tabs, groups, focus, close };
}
