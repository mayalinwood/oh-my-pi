import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bindPreparedExtensions, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	assertManifestMirrorsCapabilities,
	ExtensionManifestInvalid,
	readExtensionManifest,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/manifest";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("readExtensionManifest", () => {
	it("treats an absent manifest as no review identity rather than an error", () => {
		expect(readExtensionManifest(undefined, "/x.ts")).toBeUndefined();
	});

	it("keeps a well-formed manifest", () => {
		const manifest = readExtensionManifest({ name: "acme.thing", version: "1.2.3", description: "d" }, "/x.ts");
		expect(manifest).toEqual({ name: "acme.thing", version: "1.2.3", description: "d" });
	});

	it("refuses a manifest a reviewer could misread", () => {
		const cases: Array<[unknown, RegExp]> = [
			["not-an-object", /expected an object/],
			[{ version: "1" }, /"name" must match/],
			[{ name: "Bad Name", version: "1" }, /"name" must match/],
			[{ name: "ok", version: "" }, /"version" must be a non-empty string/],
			[{ name: "ok", version: 1 }, /"version" must be a non-empty string/],
			[{ name: "ok", version: "1", description: 7 }, /"description" must be a string/],
			[{ name: "ok", version: "1", permissions: ["fs:write"] }, /unknown key\(s\) permissions/],
		];
		for (const [raw, message] of cases) {
			expect(() => readExtensionManifest(raw, "/x.ts")).toThrow(ExtensionManifestInvalid);
			expect(() => readExtensionManifest(raw, "/x.ts")).toThrow(message);
		}
	});
});

describe("assertManifestMirrorsCapabilities", () => {
	const capabilities = [{ kind: "events:subscribe" }, { kind: "ui:command" }];

	it("accepts a mirror that reaches the same powers in another order", () => {
		const manifest = readExtensionManifest(
			{ name: "a", version: "1", capabilities: capabilities.slice().reverse() },
			"/a.ts",
		);
		expect(() => assertManifestMirrorsCapabilities(manifest!, capabilities, "/a.ts")).not.toThrow();
	});

	it("rejects a mirror that under-reports the module's own reach", () => {
		const manifest = readExtensionManifest(
			{ name: "a", version: "1", capabilities: [{ kind: "events:subscribe" }] },
			"/a.ts",
		);
		expect(() => assertManifestMirrorsCapabilities(manifest!, capabilities, "/a.ts")).toThrow(
			/but the module declares/,
		);
	});

	it("rejects a mirror that over-reports what the module holds", () => {
		const manifest = readExtensionManifest(
			{ name: "a", version: "1", capabilities: [...capabilities, { kind: "fs:write" }] },
			"/a.ts",
		);
		expect(() => assertManifestMirrorsCapabilities(manifest!, capabilities, "/a.ts")).toThrow(/manifest mirrors/);
	});

	it("narrows an exec mirror to the command and args it names", () => {
		const declared = [{ kind: "process:exec", command: "git", args: ["rev-parse"] }];
		const widened = readExtensionManifest(
			{ name: "a", version: "1", capabilities: [{ kind: "process:exec", command: "git", args: ["**"] }] },
			"/a.ts",
		);
		expect(() => assertManifestMirrorsCapabilities(widened!, declared, "/a.ts")).toThrow(/manifest mirrors/);
	});

	it("leaves the authority to the gate when there is no mirror", () => {
		const manifest = readExtensionManifest({ name: "a", version: "1" }, "/a.ts");
		expect(() => assertManifestMirrorsCapabilities(manifest!, capabilities, "/a.ts")).not.toThrow();
	});
});

/**
 * The manifest as the loader actually carries it from disk. The unit tests
 * cover validation; these pin the wiring — that a declared manifest reaches the
 * `Extension` record, survives a rebind, and that a manifest which lies about
 * reach or claims a taken name fails the load rather than loading quietly.
 */
describe("extension manifest (loaded from disk)", () => {
	let tmp: string;

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ext-manifest-"));
	});

	afterAll(async () => {
		await removeWithRetries(tmp);
	});

	async function write(name: string, lines: string[]): Promise<string> {
		const target = path.join(tmp, name);
		await fs.writeFile(target, lines.join("\n"));
		return target;
	}

	async function load(...names: string[]) {
		return loadExtensions(
			names.map(name => path.join(tmp, name)),
			tmp,
			new EventBus(),
		);
	}

	it("carries a declared manifest onto the loaded extension", async () => {
		await write("good.ts", [
			`export const capabilities = [{ kind: "events:subscribe" }];`,
			`export const manifest = { name: "acme-good", version: "2.0.0", description: "reviewable" };`,
			"export default function (pi) { pi.on('agent_start', async () => {}); }",
		]);
		const result = await load("good.ts");
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].manifest).toEqual({
			name: "acme-good",
			version: "2.0.0",
			description: "reviewable",
		});
	});

	it("loads an extension that publishes no manifest, holding no review identity", async () => {
		await write("bare.ts", ["export default function () {}"]);
		const result = await load("bare.ts");
		expect(result.errors).toEqual([]);
		expect(result.extensions[0].manifest).toBeUndefined();
	});

	it("refuses a manifest whose mirror under-reports the real capabilities", async () => {
		await write("liar.ts", [
			`export const capabilities = [{ kind: "events:subscribe" }, { kind: "tools:register" }];`,
			`export const manifest = { name: "acme-liar", version: "1", capabilities: [{ kind: "events:subscribe" }] };`,
			"export default function (pi) { pi.registerTool({ name: 't', label: 't', description: 'd', parameters: pi.typebox.object({}), execute: async () => ({ content: [] }) }); }",
		]);
		const result = await load("liar.ts");
		expect(result.extensions).toEqual([]);
		expect(result.errors[0].error).toContain(
			"manifest mirrors events:subscribe but the module declares events:subscribe, tools:register",
		);
	});

	it("fails a malformed manifest closed instead of loading it partially", async () => {
		await write("malformed.ts", [
			`export const manifest = { name: "Bad Name", version: "1" };`,
			"export default function () {}",
		]);
		const result = await load("malformed.ts");
		expect(result.extensions).toEqual([]);
		expect(result.errors[0].error).toContain('"name" must match');
	});

	it("refuses the second extension to claim a manifest name already taken", async () => {
		await write("first.ts", [
			`export const manifest = { name: "acme-shared", version: "1" };`,
			"export default function () {}",
		]);
		await write("second.ts", [
			`export const manifest = { name: "acme-shared", version: "2" };`,
			"export default function () {}",
		]);
		const result = await load("first.ts", "second.ts");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].manifest?.version).toBe("1");
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("already claimed by another loaded extension");
	});

	it("carries the manifest through a prepared rebind into a second load", async () => {
		await write("rebound.ts", [
			`export const manifest = { name: "acme-rebound", version: "1.0.0" };`,
			"export default function () {}",
		]);
		const first = await load("rebound.ts");
		const prepared = first.preparedExtensions!;
		expect(prepared[0].manifest).toEqual({ name: "acme-rebound", version: "1.0.0" });
		const second = await bindPreparedExtensions(prepared, tmp, new EventBus());
		expect(second.errors).toEqual([]);
		expect(second.extensions[0].manifest).toEqual({ name: "acme-rebound", version: "1.0.0" });
	});
});
