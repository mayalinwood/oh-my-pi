import { describe, expect, it } from "bun:test";
import {
	applyCapabilityGate,
	CONTEXT_MEMBER_CAPABILITIES,
	ExtensionCapabilityDenied,
	EXTENSION_MEMBER_CAPABILITIES,
	grantsAllowExec,
	resolveExtensionGrants,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/capabilities";

describe("resolveExtensionGrants", () => {
	it("denies everything when the declaration is absent", () => {
		for (const declared of [undefined, null, "process:exec", 42, {}]) {
			const grants = resolveExtensionGrants(declared);
			expect(grants.kinds.size).toBe(0);
			expect(grants.exec).toEqual([]);
		}
	});

	it("keeps a well-formed process:exec grant with its command and patterns", () => {
		const grants = resolveExtensionGrants([{ kind: "process:exec", command: "git", args: ["rev-parse"] }]);
		expect(grants.kinds.has("process:exec")).toBe(true);
		expect(grants.exec).toEqual([{ command: "git", args: ["rev-parse"] }]);
	});

	it("drops a malformed exec grant instead of widening access, and says why", () => {
		const grants = resolveExtensionGrants([
			{ kind: "process:exec", command: "", args: ["**"] },
			{ kind: "process:exec", command: "bash" },
			{ kind: "process:exec", command: "sh", args: ["**", 7] },
		]);
		expect(grants.exec).toEqual([]);
		// Without the reason, the extension meets a refusal telling it to declare
		// a capability it already declared, and no edit can follow that advice.
		expect(grants.malformed).toEqual([
			'entry #0: "process:exec" needs a non-empty "command" string',
			'entry #1: "process:exec" needs "args" to be an array of strings',
			'entry #2: "process:exec" needs "args" to be an array of strings',
		]);
		expect(grants.kinds.has("process:exec")).toBe(false);
	});

	it("names the position of a declaration entry that is not one", () => {
		const grants = resolveExtensionGrants(["events:read", { name: "tools:register" }, { kind: 7 }]);
		expect(grants.malformed).toEqual([
			"entry #0 is not a capability object",
			'entry #1 has no string "kind"',
			'entry #2 has no string "kind"',
		]);
		expect(grants.kinds.size).toBe(0);
	});

	it("holds a well-formed declaration free of reasons", () => {
		const grants = resolveExtensionGrants([
			{ kind: "events:subscribe" },
			{ kind: "process:exec", command: "git", args: ["rev-parse"] },
		]);
		expect(grants.malformed).toEqual([]);
		expect(grants.unknown).toEqual([]);
	});

	it("reports a capability kind the runtime does not know", () => {
		const grants = resolveExtensionGrants([{ kind: "host:sudo" }, { kind: "session:read" }]);
		expect(grants.unknown).toEqual(["host:sudo"]);
		expect(grants.kinds.has("session:read")).toBe(true);
	});
});

describe("grantsAllowExec", () => {
	const grants = resolveExtensionGrants([
		{ kind: "process:exec", command: "git", args: ["rev-parse", "--show-toplevel"] },
		{ kind: "process:exec", command: "python3", args: ["**"] },
	]);

	it("permits an invocation the grant covers exactly", () => {
		expect(grantsAllowExec(grants, "git", ["rev-parse", "--show-toplevel"])).toBe(true);
	});

	it("refuses the same command with arguments the grant does not list", () => {
		expect(grantsAllowExec(grants, "git", ["push", "origin", "main"])).toBe(false);
		expect(grantsAllowExec(grants, "git", ["rev-parse", "--show-toplevel", "extra"])).toBe(false);
		expect(grantsAllowExec(grants, "git", ["rev-parse"])).toBe(false);
	});

	it("does not let a grant for one command authorise another", () => {
		expect(grantsAllowExec(grants, "bash", ["-c", "curl evil.example"])).toBe(false);
		expect(grantsAllowExec(grants, "sh", ["-c", "rm -rf /"])).toBe(false);
	});

	it("lets a trailing ** absorb the remainder of python3 arguments", () => {
		expect(grantsAllowExec(grants, "python3", ["/repo/scripts/m.py", "observe", "--mr", "7"])).toBe(true);
		expect(grantsAllowExec(grants, "python3", [])).toBe(true);
	});

	it("keeps * inside one segment while ** spans them", () => {
		const scoped = resolveExtensionGrants([{ kind: "process:exec", command: "ls", args: ["-l", "*"] }]);
		expect(grantsAllowExec(scoped, "ls", ["-l", "file.txt"])).toBe(true);
		expect(grantsAllowExec(scoped, "ls", ["-l", "dir/file.txt"])).toBe(false);
	});
});

describe("applyCapabilityGate", () => {
	function makeApiStub(): Record<string, unknown> {
		return {
			exec: (command: string) => `ran ${command}`,
			sendMessage: () => "sent",
			getSessionName: () => "session-1",
			logger: { info: () => {} },
		};
	}

	const call = (target: Record<string, unknown>, member: string, ...args: unknown[]) =>
		(target[member] as (...a: unknown[]) => unknown)(...args);
	const read = (target: Record<string, unknown>, member: string) => target[member] as () => unknown;
	it("leaves an extension with no declaration able to do nothing privileged", () => {
		const api = makeApiStub();
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants(undefined), "/ext/a.ts");
		for (const member of ["exec", "sendMessage", "getSessionName"]) {
			expect(() => call(api, member, "x")).toThrow(ExtensionCapabilityDenied);
		}
	});

	it("names the missing capability and the declaring extension in the refusal", () => {
		const api = makeApiStub();
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		try {
			call(api, "sendMessage");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionCapabilityDenied);
			expect((error as ExtensionCapabilityDenied).capability).toBe("session:message");
			expect((error as Error).message).toContain("/ext/a.ts");
			expect((error as Error).message).toContain("session:message");
		}
	});

	it("leaves unprivileged members untouched", () => {
		const api = makeApiStub();
		const before = api.logger;
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		expect(api.logger).toBe(before);
	});

	it("lets a declared capability through untouched", () => {
		const api = makeApiStub();
		applyCapabilityGate(
			api,
			EXTENSION_MEMBER_CAPABILITIES,
			resolveExtensionGrants([{ kind: "session:read" }]),
			"/ext/a.ts",
		);
		expect(call(api, "getSessionName")).toBe("session-1");
		expect(() => call(api, "sendMessage")).toThrow(ExtensionCapabilityDenied);
	});

	it("checks a granted exec per invocation instead of once at load time", () => {
		const api = makeApiStub();
		const grants = resolveExtensionGrants([{ kind: "process:exec", command: "git", args: ["rev-parse"] }]);
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, grants, "/ext/a.ts", {
			grants,
			dispatch: (command, args) => `ran ${command} ${args.join(" ")}`,
		});
		expect(call(api, "exec", "git", ["rev-parse"])).toBe("ran git rev-parse");
		expect(() => call(api, "exec", "bash", ["-c", "curl evil.example"])).toThrow(ExtensionCapabilityDenied);
		expect(() => call(api, "exec", "git", ["push"])).toThrow(ExtensionCapabilityDenied);
	});

	it("refuses exec outright when no process grant was declared", () => {
		const api = makeApiStub();
		applyCapabilityGate(
			api,
			EXTENSION_MEMBER_CAPABILITIES,
			resolveExtensionGrants([{ kind: "session:read" }]),
			"/ext/a.ts",
			{ grants: resolveExtensionGrants([{ kind: "session:read" }]), dispatch: () => "should not run" },
		);
		expect(() => call(api, "exec", "git", ["rev-parse"])).toThrow(ExtensionCapabilityDenied);
	});

	it("gates the handler context as a separate object", () => {
		const ctx: Record<string, unknown> = {
			invokeTool: () => "tool ran",
			modelRegistry: { secrets: true },
			cwd: "/repo",
		};
		applyCapabilityGate(
			ctx,
			CONTEXT_MEMBER_CAPABILITIES,
			resolveExtensionGrants([{ kind: "session:read" }]),
			"/ext/a.ts",
		);
		expect(ctx.cwd).toBe("/repo");
		expect(() => read(ctx, "invokeTool")()).toThrow(ExtensionCapabilityDenied);
		// A member that is not callable is refused just as firmly: the extension
		// never receives the registry itself, only a stand-in, and reaching for
		// the stand-in is what raises the refusal.
		expect(ctx.modelRegistry).toBeDefined();
		expect(() => (ctx.modelRegistry as Record<string, unknown>).secrets).toThrow(ExtensionCapabilityDenied);
	});

	it("names the member, the property and the kind when a stand-in is reached for", () => {
		const ctx: Record<string, unknown> = { modelRegistry: { models: ["m"] } };
		applyCapabilityGate(ctx, CONTEXT_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		try {
			(ctx.modelRegistry as Record<string, unknown>).models;
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionCapabilityDenied);
			expect((error as ExtensionCapabilityDenied).capability).toBe("model:registry");
			expect((error as Error).message).toContain("/ext/a.ts");
			expect((error as Error).message).toContain("modelRegistry.models");
			expect((error as Error).message).toContain("model:registry");
		}
	});

	it("answers undefined for the keys an await, a coercion or inspection reaches for", async () => {
		const ctx: Record<string, unknown> = { modelRegistry: { models: ["m"] } };
		applyCapabilityGate(ctx, CONTEXT_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		const stand = ctx.modelRegistry as Record<string | symbol, unknown>;
		expect(stand.then).toBeUndefined();
		expect(stand.toJSON).toBeUndefined();
		expect(stand[Symbol.toStringTag]).toBeUndefined();
		expect(await Promise.resolve(stand)).toBe(stand);
	});

	it("refuses writing to, calling and constructing a member it does not hold", () => {
		const ctx: Record<string, unknown> = { modelRegistry: { models: ["m"] } };
		applyCapabilityGate(ctx, CONTEXT_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		const stand = ctx.modelRegistry as Record<string, unknown>;
		expect(() => {
			stand.models = ["sneaked"];
		}).toThrow(ExtensionCapabilityDenied);
		expect(() => (stand as unknown as () => unknown)()).toThrow(ExtensionCapabilityDenied);
		expect(() => new (stand as unknown as new () => unknown)()).toThrow(ExtensionCapabilityDenied);
	});

	it("cannot be undone by reassigning a denied member", () => {
		const api = makeApiStub();
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		expect(() => {
			api["sendMessage"] = () => "sneaked";
		}).toThrow();
		expect(() => call(api, "sendMessage")).toThrow(ExtensionCapabilityDenied);
	});

	it("cannot be undone by reassigning a denied stand-in either", () => {
		const ctx: Record<string, unknown> = { modelRegistry: { models: ["m"] } };
		applyCapabilityGate(ctx, CONTEXT_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		expect(() => {
			ctx["modelRegistry"] = { models: ["sneaked"] };
		}).toThrow();
		expect(() => (ctx.modelRegistry as Record<string, unknown>).models).toThrow(ExtensionCapabilityDenied);
	});
});

describe("the event bus member", () => {
	const makeBus = () => ({ on: () => "subscribed", emit: () => "emitted" });
	type BusView = { on: () => string; emit: () => string };

	it("keeps the whole bus for an extension that declared it publishes", () => {
		const bus = makeBus();
		const api: Record<string, unknown> = { events: bus };
		applyCapabilityGate(
			api,
			EXTENSION_MEMBER_CAPABILITIES,
			resolveExtensionGrants([{ kind: "events:emit" }]),
			"/ext/a.ts",
		);
		expect(api.events).toBe(bus);
		const view = api.events as BusView;
		expect(view.on()).toBe("subscribed");
		expect(view.emit()).toBe("emitted");
	});

	it("narrows the bus to `on` for an extension that declared only subscription", () => {
		const bus = makeBus();
		const api: Record<string, unknown> = { events: bus };
		applyCapabilityGate(
			api,
			EXTENSION_MEMBER_CAPABILITIES,
			resolveExtensionGrants([{ kind: "events:subscribe" }]),
			"/ext/a.ts",
		);
		expect((api.events as BusView).on()).toBe("subscribed");
		try {
			(api.events as BusView).emit();
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionCapabilityDenied);
			expect((error as Error).message).toContain("events.emit");
			expect((error as Error).message).toContain("events:emit");
		}
	});

	it("refuses the bus entirely when neither capability was declared", () => {
		const api: Record<string, unknown> = { events: makeBus() };
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		try {
			(api.events as BusView).on();
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ExtensionCapabilityDenied);
			expect((error as Error).message).toContain("events.on");
			expect((error as Error).message).toContain("events:emit");
		}
	});
});
