import { afterAll, afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { registerExtensionSettingsSection } from "../src/extensibility/extensions/settings-section";

const SECTION_ID = "project-observer";
const SECTION_FIELDS = [
	{
		key: "maxCycles",
		label: "Maximum observer cycles",
		description: "Default cycle budget for a normal Project Observer start.",
		type: "integer",
		min: 1,
		max: 100,
		default: 24,
	},
	{
		key: "requiredRiskThreshold",
		label: "Required review risk threshold",
		description: "Risk at or above this level requires Advisor.",
		type: "enum",
		values: ["low", "medium", "high"],
		default: "high",
	},
] as const;

describe("extension settings provenance", () => {
	const temps: TempDir[] = [];

	afterAll(async () => {
		for (const temp of temps) await temp.remove();
		AgentStorage.close();
	});
	afterEach(async () => {
		AgentStorage.close();
	});

	/** Fresh project and agent directories per test: settings layers are process-wide state. */
	async function scaffold(): Promise<{ projectDir: string; agentDir: string }> {
		const temp = TempDir.createSync("@pi-extension-settings-provenance-");
		temps.push(temp);
		const projectDir = path.join(temp.path(), "project");
		const agentDir = path.join(temp.path(), "agent");
		await fs.mkdir(projectDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		setAgentDir(agentDir);
		return { projectDir, agentDir };
	}

	async function writeGlobal(agentDir: string, values: Record<string, Record<string, unknown>>): Promise<void> {
		await Bun.write(path.join(agentDir, "settings.json"), JSON.stringify({ extensionSettings: values }));
	}

	async function writeProject(projectDir: string, values: Record<string, Record<string, unknown>>): Promise<void> {
		const dir = path.join(projectDir, ".omp");
		await fs.mkdir(dir, { recursive: true });
		const body = Object.entries(values)
			.map(([section, entries]) => {
				const lines = Object.entries(entries).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`);
				return `  ${section}:\n${lines.join("\n")}`;
			})
			.join("\n");
		await Bun.write(path.join(dir, "config.yml"), `extensionSettings:\n${body}\n`);
	}

	async function load(projectDir: string, agentDir: string, overrides?: Record<string, unknown>): Promise<Settings> {
		return Settings.loadIsolated({ cwd: projectDir, agentDir, overrides });
	}

	it("reports which layer supplies each extension setting value", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeGlobal(agentDir, { [SECTION_ID]: { maxCycles: 12 } });
		await writeProject(projectDir, { [SECTION_ID]: { requiredRiskThreshold: "medium" } });
		const settings = await load(projectDir, agentDir);

		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "maxCycles")).toBe("global");
		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "requiredRiskThreshold")).toBe("project");
		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "missing")).toBe("default");
	});

	it("reports a runtime override above every persisted layer", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeProject(projectDir, { [SECTION_ID]: { maxCycles: 40 } });
		const settings = await load(projectDir, agentDir, {
			[`extensionSettings.${SECTION_ID}.maxCycles`]: 7,
		});

		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "maxCycles")).toBe("runtime");
	});

	it("refuses a project write that would shadow a higher-authority layer", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeGlobal(agentDir, { [SECTION_ID]: { maxCycles: 12 } });
		const settings = await load(projectDir, agentDir, { [`extensionSettings.${SECTION_ID}.maxCycles`]: 7 });

		expect(() => settings.setProjectExtensionSetting(SECTION_ID, "maxCycles", 30)).toThrow(/runtime/i);
	});

	it("allows a project write when no higher layer supplies the value", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeGlobal(agentDir, { [SECTION_ID]: { requiredRiskThreshold: "low" } });
		const settings = await load(projectDir, agentDir);

		expect(() => settings.setProjectExtensionSetting(SECTION_ID, "maxCycles", 30)).not.toThrow();
		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "maxCycles")).toBe("project");
	});

	it("resets an extension setting back to its declared default", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeProject(projectDir, { [SECTION_ID]: { maxCycles: 40 } });
		const settings = await load(projectDir, agentDir);
		expect(settings.getExtensionSettingsSection(SECTION_ID)).toEqual({ maxCycles: 40 });

		settings.resetExtensionSetting(SECTION_ID, "maxCycles");

		expect(settings.getExtensionSettingsSection(SECTION_ID)).toBeUndefined();
		expect(settings.getExtensionSettingsProvenance(SECTION_ID, "maxCycles")).toBe("default");
	});

	it("refuses to reset a key pinned by a runtime override", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeProject(projectDir, { [SECTION_ID]: { maxCycles: 40 } });
		const settings = await load(projectDir, agentDir, { [`extensionSettings.${SECTION_ID}.maxCycles`]: 7 });

		expect(() => settings.resetExtensionSetting(SECTION_ID, "maxCycles")).toThrow(/runtime/i);
	});

	it("exposes provenance and reset through the registered section", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeProject(projectDir, { [SECTION_ID]: { maxCycles: 40 } });
		const settings = await load(projectDir, agentDir);
		const section = registerExtensionSettingsSection(
			{ id: SECTION_ID, label: "Project Observer", fields: SECTION_FIELDS },
			settings,
			"/ext",
		);

		expect(section.provenanceOf("maxCycles")).toBe("project");
		expect(section.provenanceOf("requiredRiskThreshold")).toBe("default");

		section.resetToDefault("maxCycles");
		// The registration snapshot stays detached from the project layer, so a reset is a
		// pending change for the next launch rather than a live edit.
		expect(section.snapshot.maxCycles).toBe(40);
		expect(section.isRestartRequired("maxCycles")).toBe(true);
		expect(settings.getExtensionSettingsSection(SECTION_ID)).toBeUndefined();
	});

	it("surfaces session-pinned fields as a host-owned status row", async () => {
		const { projectDir, agentDir } = await scaffold();
		await writeProject(projectDir, { [SECTION_ID]: { maxCycles: 40 } });
		const settings = await load(projectDir, agentDir, { [`extensionSettings.${SECTION_ID}.maxCycles`]: 7 });
		const section = registerExtensionSettingsSection(
			{ id: SECTION_ID, label: "Project Observer", fields: SECTION_FIELDS },
			settings,
			"/ext",
		);

		expect(section.getStatus()).toEqual([
			{ label: "Session-pinned", value: "maxCycles", description: expect.any(String) },
		]);
	});
});
