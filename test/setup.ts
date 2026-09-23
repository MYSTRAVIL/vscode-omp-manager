// Loaded with `node --require` before the tests: stands in for the `vscode` module,
// which only exists inside the extension host. Covers what the tested modules touch.
import Module = require("node:module");

class EventEmitter<T> {
	private listeners: Array<(e: T) => void> = [];
	readonly event = (listener: (e: T) => void) => {
		this.listeners.push(listener);
		return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
	};
	fire(e: T): void {
		for (const l of this.listeners) l(e);
	}
	dispose(): void {
		this.listeners = [];
	}
}

const stub = {
	EventEmitter,
	workspace: { getConfiguration: () => ({ get: <V>(_key: string, fallback?: V) => fallback }) },
};

const loader = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
const load = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
	return request === "vscode" ? stub : load.call(this, request, ...rest);
};
