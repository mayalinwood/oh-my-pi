import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { formatKeyHint } from "@oh-my-pi/pi-tui/key-hint-format";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspDocument } from "@oh-my-pi/pi-tui/native/apply";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { getProjectAgentDir, removeWithRetries } from "@oh-my-pi/pi-utils";
import { SETTING_TABS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type { RegisteredExtensionSettingsSection } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

import { cfgDevAutoqa } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { cfgContextFilesExtra } from "@oh-my-pi/pi-coding-agent/session/context-settings";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry(120);
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function stubStdoutGeometry(cols: number, rows = 40): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);

		clickOption(comp, "Developer");
		expect(cfgDevAutoqa.get(settings)).toBe(true);
	});
});

function openExtraContextFiles(): SettingsSelectorComponent {
	const component = createSelector();
	component.handleNativeEvent({ type: "action", key: "", act: "page", value: "context", mods: [] });
	component.handleNativeEvent({ type: "activate", key: "", item: "contextFiles.extra" });
	return component;
}

async function submitText(component: SettingsSelectorComponent, value: string): Promise<void> {
	component.handleInput("\x01");
	component.handleInput("\x0b");
	for (const character of value) component.handleInput(character);
	component.handleInput("\r");
	await Promise.resolve();
}

function nativeErrorText(node: TspNode): string {
	const text = node.k === "text" ? (node.p?.spans ?? []).filter(span => span.s === "error").map(span => span.t) : [];
	for (const child of node.c ?? []) text.push(nativeErrorText(child));
	return text.join("\n");
}

describe("extra context filenames editor", () => {
	it("saves multiple filenames as an array and lets users disable extras", async () => {
		const component = openExtraContextFiles();
		await submitText(component, '["AGENTS.local.md","TEAM.md"]');
		expect(cfgContextFilesExtra.get(settings)).toEqual(["AGENTS.local.md", "TEAM.md"]);

		component.handleInput("\r");
		await submitText(component, "[]");
		expect(cfgContextFilesExtra.get(settings)).toEqual([]);
	});

	it.each([
		["[", /Invalid array JSON/],
		['{"file":"TEAM.md"}', /Invalid array JSON/],
		['["../TEAM.md"]', /file names, not paths/],
	])("keeps the saved filenames when input %s is rejected", async (input, error) => {
		cfgContextFilesExtra.set(settings, ["TEAM.md"]);
		const component = openExtraContextFiles();
		await submitText(component, input);
		expect(cfgContextFilesExtra.get(settings)).toEqual(["TEAM.md"]);
		expect(Bun.stripANSI(component.render(120).join("\n"))).toMatch(error);
		const document = new TspDocument("settings");
		const reconciler = new Reconciler("settings");
		const ops = reconciler.reconcile(
			{ main: [], dock: [], layer: [component] },
			{ cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true },
		);
		expect(document.applyFrame({ sf: "settings", s: 1, ops })).toEqual([]);
		expect(nativeErrorText(document.snapshot())).toMatch(error);
	});

	it("is not offered when the project config sets the list, so it cannot be copied to global", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ctx-"));
		try {
			const cwd = path.join(root, "repo");
			const agentDir = path.join(root, "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(path.join(getProjectAgentDir(cwd), "config.yml"), "contextFiles:\n  extra:\n    - TEAM.md\n");
			resetSettingsForTest();
			await Settings.init({ cwd, agentDir });

			const component = openExtraContextFiles();
			component.handleInput("\r");
			await settings.flush();

			expect(Bun.stripANSI(component.render(120).join("\n"))).not.toContain("Extra Context Files");
			const globalConfig = Bun.file(path.join(agentDir, "config.yml"));
			expect((await globalConfig.exists()) ? await globalConfig.text() : "").not.toContain("TEAM.md");
		} finally {
			resetSettingsForTest();
			AgentStorage.close();
			await removeWithRetries(root);
		}
	});
});

describe("registered extension settings", () => {
	it("renders and safely edits registered extension settings and live status", () => {
		const values = { maxCycles: 24, costCutoffUsd: 1, reviewer: "automatic" };
		const setCalls: Array<{ key: string; value: unknown }> = [];
		const section: RegisteredExtensionSettingsSection = {
			id: "project-observer",
			label: "Project Observer / Advisor",
			description: "Bounded policy with provider hard limits kept external.",
			extensionPath: "/extension.ts",
			fields: [
				{
					key: "maxCycles",
					label: "Maximum cycles",
					description: "Bounded cycle budget.",
					type: "integer",
					min: 1,
					max: 100,
					default: 24,
				},
				{
					key: "costCutoffUsd",
					label: "Cost cutoff",
					description: "Finite admission cutoff.",
					type: "number",
					min: 0,
					max: 1,
					default: 1,
				},
				{
					key: "reviewer",
					label: "Reviewer",
					description: "Exact stable name.",
					type: "text",
					minLength: 1,
					maxLength: 64,
					pattern: "automatic|[A-Za-z0-9][A-Za-z0-9._-]{0,63}",
					default: "automatic",
				},
			],
			snapshot: { maxCycles: 12, costCutoffUsd: 1, reviewer: "automatic" },
			readValues: () => ({ ...values }),
			setValue: (key, value) => {
				if (key === "maxCycles") {
					if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
						throw new RangeError("Maximum cycles must be an integer from 1 through 100");
					}
					values.maxCycles = value;
				} else if (key === "costCutoffUsd") {
					if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
						throw new RangeError("Cost cutoff must be a finite number from 0 through 1");
					}
					values.costCutoffUsd = value;
				} else if (key === "reviewer") {
					if (typeof value !== "string" || !/^(?:automatic|[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(value)) {
						throw new TypeError("Reviewer must fully match its configured pattern");
					}
					values.reviewer = value;
				} else {
					throw new TypeError(`Unknown setting ${key}`);
				}
				setCalls.push({ key, value });
			},
			provenanceOf: key => (key === "reviewer" ? "global" : "project"),
			resetToDefault: key => {
				delete values[key as keyof typeof values];
			},
			getStatus: () => [{ label: "Advisor status", value: "running", description: "Current identity." }],
			isRestartRequired: () =>
				values.maxCycles !== 12 || values.costCutoffUsd !== 1 || values.reviewer !== "automatic",
		};
		const comp = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
				extensionSettingsSections: [section],
			},
			{ onChange: () => {}, onCancel: () => {} },
		);

		for (let index = 0; index < SETTING_TABS.length; index++) comp.handleInput("\x1b[C");
		const rendered = Bun.stripANSI(comp.render(120).join("\n"));
		expect(rendered).toContain("Extensions");
		expect(rendered).toContain("Project Observer / Advisor");
		expect(rendered).toContain("Bounded policy with provider hard limits kept external.");
		expect(rendered).toContain("Maximum cycles");
		expect(rendered).toContain("Restart required");
		expect(rendered).toContain("Advisor status (read-only)");
		expect(rendered).toContain("running");

		const narrow = Bun.stripANSI(comp.render(24).join("\n"));
		expect(narrow).toContain("Ext");
		expect(narrow).toContain("Plug");

		geometryStub?.restore();
		geometryStub = stubStdoutGeometry(120, 8);
		const short = Bun.stripANSI(comp.render(120).join("\n"));
		expect(short.split("\n")).toHaveLength(8);
		expect(short).toContain("Restart required");
		// The footer renders the active key-hint preset (a glyph under unicode), so
		// derive the expectation from the same formatter instead of a literal name.
		expect(short).toContain(`${formatKeyHint("escape")} to close`);
		geometryStub.restore();
		geometryStub = stubStdoutGeometry(120);

		comp.handleInput("\n");
		let submenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(submenu).toContain("integer from 1 through 100, inclusive");
		expect(submenu).not.toContain("Clear field to unset");
		comp.handleInput("\x15");
		for (const character of "101") comp.handleInput(character);
		comp.handleInput("\n");
		submenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(submenu).toContain("integer from 1 through 100");
		expect(values.maxCycles).toBe(24);

		comp.handleInput("\x15");
		for (const character of "12") comp.handleInput(character);
		comp.handleInput("\n");
		expect(values.maxCycles).toBe(12);
		expect(setCalls).toEqual([{ key: "maxCycles", value: 12 }]);

		for (const character of "maximum cycles") comp.handleInput(character);
		expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("12");
		comp.handleInput("\n");
		comp.handleInput("\x15");
		for (const character of "13") comp.handleInput(character);
		comp.handleInput("\n");
		expect(values.maxCycles).toBe(13);
		expect(Bun.stripANSI(comp.render(120).join("\n"))).toContain("13");

		comp.handleInput("\x1b");
		comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		let numberMenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(numberMenu).toContain("finite number from 0 through 1, inclusive");
		comp.handleInput("\x15");
		comp.handleInput("2");
		comp.handleInput("\n");
		numberMenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(numberMenu).toContain("finite number from 0 through 1");
		expect(values.costCutoffUsd).toBe(1);
		comp.handleInput("\x15");
		for (const character of ".5") comp.handleInput(character);
		comp.handleInput("\n");
		expect(values.costCutoffUsd).toBe(0.5);

		comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		let textMenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(textMenu).toContain("1 through 64 characters");
		expect(textMenu).toContain("must fully match");
		comp.handleInput("\x15");
		for (const character of "Security reviewer") comp.handleInput(character);
		comp.handleInput("\n");
		textMenu = Bun.stripANSI(comp.render(120).join("\n"));
		expect(textMenu).toContain("must fully match");
		expect(values.reviewer).toBe("automatic");
		comp.handleInput("\x15");
		for (const character of "Security") comp.handleInput(character);
		comp.handleInput("\n");
		expect(values.reviewer).toBe("Security");

		comp.handleInput("\x1b[B");
		const readOnly = Bun.stripANSI(comp.render(120).join("\n"));
		expect(readOnly).toContain("Read-only live status");
		const callCount = setCalls.length;
		comp.handleInput("\n");
		expect(setCalls).toHaveLength(callCount);
	});
});
