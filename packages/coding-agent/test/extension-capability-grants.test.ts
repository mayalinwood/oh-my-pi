import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

declare global {
	/** Written by the fixture extensions loaded from disk; read by the assertions. */
	var __capResults: Map<string, Promise<unknown>> | undefined;
	/** Set by the fixture's bus listener, read after the host emits on the bus. */
	var __capListenerFired: boolean | undefined;
}

/**
 * Capability grants as the loader actually applies them to an extension read
 * from disk. The unit tests cover the grant algebra; these pin the wiring —
 * specifically that the untrusted entry point is deny-by-default and that a
 * `process:exec` grant is honoured per invocation.
 */
describe("extension capability grants (loaded from disk)", () => {
	let tmp: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ext-caps-"));
		globalThis.__capResults = new Map();

		// No declaration at all: the extension may not even register a tool.
		await write(
			"undeclared.ts",
			[
				"export default function (api) {",
				"  api.registerTool({",
				"    name: 'undeclared_tool',",
				"    description: 'must not load',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"}",
			].join("\n"),
		);

		// Declares only tool registration, then reaches for powers it never
		// declared. Registration must succeed; the rest must be refused.
		await write(
			"registered-only.ts",
			[
				"export const capabilities = [{ kind: 'tools:register' }];",
				"export default function (api) {",
				"  api.registerTool({",
				"    name: 'registered_tool',",
				"    description: 'registration is declared',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() {",
				"      return { content: [{ type: 'text', text: 'ok' }] };",
				"    },",
				"  });",
				"  const results = globalThis.__capResults;",
				"  results.set('undeclared-send', (async () => {",
				"    try { api.sendMessage('nope'); return 'allowed'; }",
				"    catch (error) { return error.name; }",
				"  })());",
				"  results.set('undeclared-exec', (async () => {",
				"    try { await api.exec('bash', ['-c', 'echo hi']); return 'allowed'; }",
				"    catch (error) { return error.name; }",
				"  })());",
				"}",
			].join("\n"),
		);

		// Holds a narrow exec grant: one invocation works, its neighbours do not.
		await write(
			"exec-granted.ts",
			[
				"export const capabilities = [",
				"  { kind: 'process:exec', command: 'git', args: ['--version'] },",
				"];",
				"export default function (api) {",
				"  const results = globalThis.__capResults;",
				"  results.set('granted-exec', (async () => {",
				"    const run = await api.exec('git', ['--version']);",
				"    return { code: run.code, stdout: run.stdout.trim() };",
				"  })());",
				"  results.set('denied-exec', (async () => {",
				"    try { await api.exec('git', ['push', 'origin', 'main']); return 'allowed'; }",
				"    catch (error) { return error.name; }",
				"  })());",
				"  results.set('other-command', (async () => {",
				"    try { await api.exec('bash', ['-c', 'echo hi']); return 'allowed'; }",
				"    catch (error) { return error.name; }",
				"  })());",
				"}",
			].join("\n"),
		);

		// Declares something the runtime does not implement.
		await write(
			"unknown-capability.ts",
			[
				"export const capabilities = [{ kind: 'host:escalate' }];",
				"export default function (api) {",
				"  api.registerTool({",
				"    name: 'never',",
				"    description: 'must not load',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"}",
			].join("\n"),
		);

		// Declares a process:exec grant it cannot use. The refusal it would meet
		// asks for the declaration it already wrote, so the load has to name the
		// shape instead of leaving the author to add power that is not the defect.
		await write(
			"malformed-capability.ts",
			[
				"export const capabilities = [{ kind: 'process:exec', command: 'git', args: 'rev-parse' }];",
				"export default function (api) {",
				"  api.registerTool({ name: 'never', description: 'must not load',",
				"    parameters: api.typebox.Type.Object({}),",
				"    async execute() { return { content: [{ type: 'text', text: '' }] }; },",
				"  });",
				"}",
			].join("\n"),
		);
		// Subscribes to the bus without declaring it: the load must name the
		// member and the kind, not leave the extension to read
		// `api.events.on is not a function` with no clue what was missing.
		await write(
			"bus-undeclared.ts",
			[
				"export const capabilities = [{ kind: 'tools:register' }];",
				"export default function (api) {",
				"  api.events.on('acp-session-live', () => {});",
				"}",
			].join("\n"),
		);

		// Declares subscription only: the listener must reach the real bus and
		// fire, while publishing stays behind `events:emit`.
		await write(
			"bus-subscribe-only.ts",
			[
				"export const capabilities = [{ kind: 'events:subscribe' }];",
				"export default function (api) {",
				"  const results = globalThis.__capResults;",
				"  const off = api.events.on('cap:probe', () => { globalThis.__capListenerFired = true; });",
				"  results.set('bus-unsubscribe', typeof off);",
				"  results.set('bus-emit', (async () => {",
				"    try { api.events.emit('cap:probe', {}); return 'allowed'; }",
				"    catch (error) { return error.name; }",
				"  })());",
				"}",
			].join("\n"),
		);
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
		delete globalThis.__capResults;
		delete globalThis.__capListenerFired;
	});

	async function write(name: string, source: string): Promise<void> {
		await fs.writeFile(path.join(tmp, name), source);
	}

	function load(name: string) {
		return loadExtensions([path.join(tmp, name)], tmp, new EventBus());
	}

	async function outcome(key: string): Promise<unknown> {
		const results = globalThis.__capResults;
		if (!results) throw new Error("capability results map was never installed");
		const pending = results.get(key);
		if (!pending) throw new Error(`extension did not report "${key}"`);
		return await pending;
	}

	it("refuses an extension that declared nothing, naming the missing grant", async () => {
		const result = await load("undeclared.ts");
		expect(result.extensions).toHaveLength(0);
		expect(result.errors[0]?.error).toContain("tools:register");
		expect(result.errors[0]?.error).toContain("undeclared.ts");
	});

	it("loads an extension that declared what it uses, and refuses the rest", async () => {
		const result = await load("registered-only.ts");
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.tools.has("registered_tool")).toBe(true);

		expect(await outcome("undeclared-send")).toBe("ExtensionCapabilityDenied");
		expect(await outcome("undeclared-exec")).toBe("ExtensionCapabilityDenied");
	});

	it("honours a narrow exec grant per invocation rather than once at load", async () => {
		const result = await load("exec-granted.ts");
		expect(result.errors).toEqual([]);

		expect(await outcome("granted-exec")).toMatchObject({ code: 0 });
		expect(await outcome("denied-exec")).toBe("ExtensionCapabilityDenied");
		expect(await outcome("other-command")).toBe("ExtensionCapabilityDenied");
	});

	it("fails closed on a capability the runtime does not implement", async () => {
		const result = await load("unknown-capability.ts");
		expect(result.extensions).toHaveLength(0);
		expect(result.errors[0]?.error).toContain("host:escalate");
	});

	it("fails the load naming the shape of a capability it cannot use", async () => {
		const result = await load("malformed-capability.ts");
		expect(result.extensions).toHaveLength(0);
		expect(result.errors[0]?.error).toContain("entry #0");
		expect(result.errors[0]?.error).toContain("to be an array of strings");
		expect(result.errors[0]?.error).not.toContain("Declare it in the extension");
	});

	it("fails the load with the bus member and kind when the bus was not declared", async () => {
		const result = await load("bus-undeclared.ts");
		expect(result.extensions).toHaveLength(0);
		expect(result.errors[0]?.error).toContain("events.on");
		expect(result.errors[0]?.error).toContain("events:emit");
		expect(result.errors[0]?.error).not.toContain("is not a function");
	});

	it("lets a declared subscriber receive events while refusing it the bus to publish on", async () => {
		const bus = new EventBus();
		const result = await loadExtensions([path.join(tmp, "bus-subscribe-only.ts")], tmp, bus);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(await outcome("bus-unsubscribe")).toBe("function");
		expect(await outcome("bus-emit")).toBe("ExtensionCapabilityDenied");
		bus.emit("cap:probe", {});
		expect(globalThis.__capListenerFired).toBe(true);
	});
});
