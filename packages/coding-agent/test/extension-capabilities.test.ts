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

	it("drops a malformed exec grant instead of widening access", () => {
		const grants = resolveExtensionGrants([
			{ kind: "process:exec", command: "", args: ["**"] },
			{ kind: "process:exec", command: "bash" },
			{ kind: "process:exec", command: "sh", args: ["**", 7] },
		]);
		expect(grants.exec).toEqual([]);
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
		// A non-callable member is refused just as firmly: the extension never
		// receives the registry itself, only a stand-in.
		expect(ctx.modelRegistry).toBeDefined();
		expect(() => read(ctx, "modelRegistry")()).toThrow(ExtensionCapabilityDenied);
	});

	it("cannot be undone by reassigning a denied member", () => {
		const api = makeApiStub();
		applyCapabilityGate(api, EXTENSION_MEMBER_CAPABILITIES, resolveExtensionGrants([]), "/ext/a.ts");
		expect(() => {
			api["sendMessage"] = () => "sneaked";
		}).toThrow();
		expect(() => call(api, "sendMessage")).toThrow(ExtensionCapabilityDenied);
	});
});
