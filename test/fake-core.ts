// Stands in for @mystravil/omp-session-core so the hook tests can publish exact states. The
// real core derives the terminal from omp's ctx, a TTY stdout and the environment, which a test
// runner lacks; its state rules are tested in its own repo. Import this before the hook.
import Module = require("node:module");
import type { OmpExtensionApi, SessionCore, SessionStateV1 } from "@mystravil/omp-session-core";

type Handler = (event: unknown, ctx: unknown) => unknown;

let current: SessionStateV1 | undefined;
const listeners = new Set<(state: SessionStateV1) => void>();
const handlers = new Map<string, Handler[]>();

const core: SessionCore = {
	version: "0.0.0-fake",
	isProvider: () => true,
	onState(listener) {
		listeners.add(listener);
		return () => void listeners.delete(listener);
	},
	onFocus: () => () => {},
	state: () => current,
	focus: () => undefined,
	idleMs: () => null,
};

function startSessionCore(_pi: OmpExtensionApi): SessionCore {
	return core;
}

/** The omp extension API the hook gets: it records each handler. */
export const pi: OmpExtensionApi = {
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	},
};

/** Publishes a session state, as the core's provider does on each change. */
export function publish(state: Omit<SessionStateV1, "v" | "at">): void {
	current = { v: 1, at: Date.now(), ...state };
	for (const listener of listeners) listener(current);
}

/** Sets the provider's state without notifying: another copy of the core published it before the hook subscribed. */
export function publishedEarlier(state: Omit<SessionStateV1, "v" | "at">): void {
	current = { v: 1, at: Date.now(), ...state };
}

/** Runs omp's handlers for `event`. */
export function emit(event: string, payload: unknown = {}): void {
	for (const handler of handlers.get(event) ?? []) handler(payload, {});
}

const loader = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
const load = loader._load;
loader._load = function (request: string, ...rest: unknown[]) {
	return request === "@mystravil/omp-session-core" ? { startSessionCore } : load.call(this, request, ...rest);
};
