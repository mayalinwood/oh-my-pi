/**
 * Extension loader - loads TypeScript extension modules using native Bun import.
 */
import type * as fs1 from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	ImageContent,
	Model,
	ServiceTier,
	ServiceTierByFamily,
	ServiceTierFamily,
	TextContent,
	TSchema,
} from "@oh-my-pi/pi-ai";
import { isBuiltinComposerStyle, type KeyId } from "@oh-my-pi/pi-tui";
import { hasFsCode, isEacces, isEnoent, logger } from "@oh-my-pi/pi-utils";
import type { AdvisorStatus, EnsureAdvisorRequest, EnsureAdvisorResult } from "../../advisor/control";
import { type ExtensionModule, extensionModuleCapability } from "../../capability/extension-module";
import { type Hook, hookCapability } from "../../capability/hook";
import { isServiceTierFamily, isServiceTierForFamily } from "../../config/service-tier";
import { findScopedSettings, Settings } from "../../config/settings";
import { loadCapability } from "../../discovery";
import { getExtensionNameFromPath } from "../../discovery/helpers";
import type { ExecOptions } from "../../exec/exec";
import { execCommand } from "../../exec/exec";
// Runtime self-reference: dereference this namespace only inside loader functions to keep the index.ts cycle safe.
import * as PiCodingAgent from "../../index";
import type { SendUserMessageOptions } from "../../session/agent-session";
import type { CustomMessagePayload } from "../../session/messages";
import type { FileDeleteFallbackHandler, FileWriteFallbackHandler } from "../../tools/file-write-fallback";
import { isFilesystemSourcePath } from "../../tools/path-utils";
import { EventBus } from "../../utils/event-bus";
import * as TypeBox from "../legacy-typebox";
import { resolveExtensionDirectory } from "./directory-resolution";
import { installLegacyPiSpecifierShim, loadLegacyPiModule } from "../plugins/legacy-pi-compat";
import { getAllPluginExtensionPaths } from "../plugins/loader";

import { resolvePath, withHostGuard } from "../utils";
import type { ComposerShapeDefinition } from "@oh-my-pi/pi-tui/overlays/composer-shape-registry";
import { registerExtensionSettingsSection } from "./settings-section";
import type {
	AssistantThinkingRenderer,
	Extension,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionSettingField,
	ExtensionSettingsSectionDefinition,
	ExtensionSettingsSnapshot,
	ExtensionRuntime as IExtensionRuntime,
	LoadExtensionsResult,
	MessageRenderer,
	PreparedExtension,
	ProviderConfig,
	RegisteredCommand,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "./types";
import {
	applyCapabilityGate,
	EXTENSION_MEMBER_CAPABILITIES,
	fullExtensionGrants,
	resolveExtensionGrants,
	type ResolvedExtensionGrants,
} from "./capabilities";

import { assertManifestMirrorsCapabilities, readExtensionManifest, type ExtensionManifest } from "./manifest";
installLegacyPiSpecifierShim();
type LoadedExtensionModule =
	| ExtensionFactory
	| {
			default?: ExtensionFactory;
			capabilities?: unknown;
			manifest?: unknown;
	  };
type HandlerFn = (...args: unknown[]) => Promise<unknown>;
type SettingsSectionOwner = { readonly token: symbol; readonly extensionPath: string };

/**
 * Read the capability declaration a module exports alongside its factory.
 *
 * Zed carries this in `extension.toml`; an OMP extension is a single module,
 * so the declaration rides on the module itself. Anything that is not an
 * array is treated as no declaration at all, which denies everything.
 */
function getExtensionCapabilities(module: LoadedExtensionModule): unknown {
	if (typeof module === "function") return undefined;
	return module.capabilities;
}

/**
 * Read the review manifest a module exports alongside its factory.
 *
 * Nothing is executed to obtain it, so a reviewer can read what an extension
 * claims without running it. A module that exports none simply has no review
 * identity, which is not an error.
 */
function getExtensionManifest(module: LoadedExtensionModule): unknown {
	if (typeof module === "function") return undefined;
	return module.manifest;
}

function getExtensionFactory(module: LoadedExtensionModule): ExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

/**
 * Upstream-shaped provenance for an extension-registered tool. Consumers that
 * read `sourceInfo` off `getAllRegisteredTools()` (e.g. pi-fabric) receive an
 * absolute on-disk path: the tool's own `sourcePath` when it is filesystem-
 * absolute, otherwise the extension's resolved entry (`fallbackPath`). A tool
 * with no absolute origin at all falls back to the synthetic `<extension:name>`.
 */
export function extensionToolSourceInfo(
	definition: Pick<ToolDefinition, "name" | "sourcePath">,
	fallbackPath: string,
): SourceInfo {
	const sourcePath = definition.sourcePath;
	const path =
		sourcePath && isFilesystemSourcePath(sourcePath)
			? sourcePath
			: isFilesystemSourcePath(fallbackPath)
				? fallbackPath
				: `<extension:${definition.name}>`;
	return { path, source: "extension", scope: "temporary", origin: "top-level" };
}

export class ExtensionRuntimeNotInitializedError extends Error {
	constructor() {
		super("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	}
}

/**
 * Extension runtime with throwing stubs for action methods.
 * These are replaced with real implementations during initialization.
 */
export class ExtensionRuntime implements IExtensionRuntime {
	flagValues = new Map<string, boolean | string>();
	settingsSectionOwners = new Map<string, SettingsSectionOwner>();
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; sourceId: string }> = [];

	registerProvider(name: string, config: ProviderConfig, sourceId: string): void {
		this.pendingProviderRegistrations.push({ name, config, sourceId });
	}

	unregisterProvider(name: string): void {
		const remaining = this.pendingProviderRegistrations.filter(registration => registration.name !== name);
		this.pendingProviderRegistrations.splice(0, this.pendingProviderRegistrations.length, ...remaining);
	}

	sendMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	sendUserMessage(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	appendEntry(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setLabel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getActiveTools(): string[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAllTools(): ToolInfo[] {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setActiveTools(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getCommands(): never {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getAdvisorStatus(): AdvisorStatus {
		throw new ExtensionRuntimeNotInitializedError();
	}

	ensureAdvisor(_request: EnsureAdvisorRequest): EnsureAdvisorResult {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setModel(): Promise<boolean> {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getThinkingLevel(): ThinkingLevel {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setThinkingLevel(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getServiceTiers(): ServiceTierByFamily {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setServiceTier(): void {
		throw new ExtensionRuntimeNotInitializedError();
	}

	getSessionName(): string | undefined {
		throw new ExtensionRuntimeNotInitializedError();
	}

	setSessionName(): Promise<void> {
		throw new ExtensionRuntimeNotInitializedError();
	}
}

/**
 * ExtensionAPI implementation for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
class ConcreteExtensionAPI implements ExtensionAPI, IExtensionRuntime {
	readonly logger = logger;
	readonly typebox = TypeBox;
	readonly arktype = type;
	readonly zod = zod;
	readonly flagValues = new Map<string, boolean | string>();
	readonly pendingProviderRegistrations: Array<{
		name: string;
		config: ProviderConfig;
		sourceId: string;
	}> = [];
	readonly #settingsOwnerToken = Symbol("extension-settings-owner");

	constructor(
		public readonly pi: typeof PiCodingAgent,
		private readonly extension: Extension,
		private readonly runtime: IExtensionRuntime,
		private readonly cwd: string,
		public readonly events: EventBus,
		private readonly settingsInstance: Settings,
		grants: ResolvedExtensionGrants = resolveExtensionGrants(undefined),
	) {
		// Extensions destructure `pi.on` or forward API methods as callbacks, so every
		// prototype method must keep its receiver when detached. Walk the prototype
		// rather than listing methods: a new method is bound without touching this.
		const prototype = ConcreteExtensionAPI.prototype;
		for (const name of Object.getOwnPropertyNames(prototype)) {
			if (name === "constructor") continue;
			const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
			if (typeof descriptor?.value !== "function") continue;
			Object.defineProperty(this, name, { value: descriptor.value.bind(this), writable: true, configurable: true });
		}

		// Everything the extension did not declare is refused, including the
		// `exec` spawn path — a member missing from the declaration is not
		// reachable, and `process:exec` is re-checked per invocation so a
		// grant for one command cannot authorise another.
		const hostExec = (command: string, args: string[], rest: unknown[]) =>
			execCommand(command, args, (rest[0] as ExecOptions | undefined)?.cwd ?? this.cwd, rest[0] as ExecOptions);
		applyCapabilityGate(this, EXTENSION_MEMBER_CAPABILITIES, grants, extension.path, {
			grants,
			dispatch: hostExec,
		});
	}

	get settingsSectionOwners(): Map<string, SettingsSectionOwner> {
		if (!this.runtime.settingsSectionOwners) this.runtime.settingsSectionOwners = new Map();
		return this.runtime.settingsSectionOwners;
	}

	on<F extends HandlerFn>(event: string, handler: F): void {
		const list = this.extension.handlers.get(event) ?? [];
		list.push(handler);
		this.extension.handlers.set(event, list);
	}

	registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void {
		const registered = {
			definition: tool,
			extensionPath: this.extension.path,
			sourceInfo: extensionToolSourceInfo(tool, this.extension.resolvedPath),
		};
		this.extension.tools.set(tool.name, registered);
		for (const listener of this.extension.toolRegistrationListeners ?? []) listener(tool.name);
	}

	registerFileWriteFallback(handler: FileWriteFallbackHandler): void {
		this.extension.fileWriteFallbackHandlers.push(handler);
	}

	registerFileDeleteFallback(handler: FileDeleteFallbackHandler): void {
		this.extension.fileDeleteFallbackHandlers.push(handler);
	}

	registerSettingsSection<const Fields extends readonly ExtensionSettingField[]>(
		section: ExtensionSettingsSectionDefinition<Fields>,
	): ExtensionSettingsSnapshot<Fields> {
		if (!this.extension.settingsSections) this.extension.settingsSections = new Map();
		const sections = this.extension.settingsSections;
		const requestedId = section.id;
		if (sections.has(requestedId)) {
			throw new TypeError(
				`Extension settings section "${requestedId}" is already registered by ${this.extension.path}`,
			);
		}
		const owner = this.settingsSectionOwners.get(requestedId);
		if (owner && owner.token !== this.#settingsOwnerToken) {
			throw new TypeError(
				`Extension settings section "${requestedId}" is already registered by ${owner.extensionPath}`,
			);
		}
		const registered = registerExtensionSettingsSection(section, this.settingsInstance, this.extension.path);
		this.settingsSectionOwners.set(registered.id, {
			token: this.#settingsOwnerToken,
			extensionPath: this.extension.path,
		});
		sections.set(registered.id, registered);
		return registered.snapshot as ExtensionSettingsSnapshot<Fields>;
	}

	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: RegisteredCommand["getArgumentCompletions"];
			handler: RegisteredCommand["handler"];
		},
	): void {
		this.extension.commands.set(name, { name, ...options });
	}

	setLabel(label: string): void {
		this.extension.label = label;
	}

	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void {
		this.extension.shortcuts.set(shortcut, { shortcut, extensionPath: this.extension.path, ...options });
	}

	registerFlag(
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	): void {
		this.extension.flags.set(name, { name, extensionPath: this.extension.path, ...options });
		if (options.default !== undefined) {
			this.runtime.flagValues.set(name, options.default);
		}
	}

	registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
		this.extension.messageRenderers.set(customType, renderer as MessageRenderer);
	}

	registerAssistantThinkingRenderer(renderer: AssistantThinkingRenderer): void {
		this.extension.assistantThinkingRenderers.push(renderer);
	}

	registerComposerShape(definition: ComposerShapeDefinition): void {
		const id = definition.style.id;
		if (id.length === 0 || id !== id.trim()) {
			throw new TypeError("Composer shape id must be a non-empty trimmed string");
		}
		if (definition.label.trim().length === 0) {
			throw new TypeError(`Composer shape "${id}" must have a label`);
		}
		if (isBuiltinComposerStyle(id)) {
			throw new Error(`Cannot replace built-in composer shape "${id}"`);
		}
		this.extension.composerShapes.set(id, definition);
	}

	getFlag(name: string): boolean | string | undefined {
		if (!this.extension.flags.has(name)) return undefined;
		return this.runtime.flagValues.get(name);
	}

	sendMessage<T = unknown>(
		message: CustomMessagePayload<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void {
		this.runtime.sendMessage(message, options);
	}

	sendUserMessage(content: string | (TextContent | ImageContent)[], options?: SendUserMessageOptions): void {
		this.runtime.sendUserMessage(content, options);
	}

	appendEntry(customType: string, data?: unknown): void {
		this.runtime.appendEntry(customType, data);
	}

	exec(command: string, args: string[], options?: ExecOptions) {
		return execCommand(command, args, options?.cwd ?? this.cwd, options);
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	getAllTools(): ToolInfo[] {
		return this.runtime.getAllTools();
	}

	setActiveTools(toolNames: string[]): Promise<void> {
		return this.runtime.setActiveTools(toolNames);
	}

	getCommands() {
		return this.runtime.getCommands();
	}

	getAdvisorStatus(): AdvisorStatus {
		return this.runtime.getAdvisorStatus();
	}

	ensureAdvisor(request: EnsureAdvisorRequest): EnsureAdvisorResult {
		return this.runtime.ensureAdvisor(request);
	}

	setModel(model: Model): Promise<boolean> {
		return this.runtime.setModel(model);
	}

	getThinkingLevel(): ThinkingLevel | undefined {
		return this.runtime.getThinkingLevel();
	}

	setThinkingLevel(level: ThinkingLevel, persist?: boolean): void {
		this.runtime.setThinkingLevel(level, persist);
	}

	getServiceTiers(): Readonly<ServiceTierByFamily> {
		return { ...this.runtime.getServiceTiers() };
	}

	setServiceTier(family: ServiceTierFamily, tier: ServiceTier | undefined): void {
		if (!isServiceTierFamily(family) || (tier !== undefined && !isServiceTierForFamily(family, tier))) {
			throw new TypeError(`Invalid service tier "${String(tier)}" for family "${String(family)}"`);
		}
		this.runtime.setServiceTier(family, tier);
	}

	getSessionName(): string | undefined {
		return this.runtime.getSessionName();
	}

	setSessionName(name: string): Promise<void> {
		return this.runtime.setSessionName(name);
	}

	registerProvider(name: string, config: ProviderConfig): void {
		this.extension.registersProviders = true;
		this.runtime.registerProvider(name, config, this.extension.path);
	}

	unregisterProvider(name: string): void {
		this.runtime.unregisterProvider(name, this.extension.path);
	}
}
function createExtension(
	extensionPath: string,
	resolvedPath: string,
	grants: ResolvedExtensionGrants,
	manifest?: ExtensionManifest,
): Extension {
	return {
		path: extensionPath,
		resolvedPath,
		grants,
		...(manifest === undefined ? {} : { manifest }),
		handlers: new Map(),
		tools: new Map(),
		toolRegistrationListeners: new Set(),
		assistantThinkingRenderers: [],
		fileWriteFallbackHandlers: [],
		fileDeleteFallbackHandlers: [],
		messageRenderers: new Map(),
		composerShapes: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		settingsSections: new Map(),
	};
}

/**
 * Runs an extension factory with registration rollback on failure. Restores
 * provider queues and reserved settings namespace ownership because a factory
 * can fail after changing either shared registry.
 */
async function runExtensionFactory(
	factory: ExtensionFactory,
	api: ExtensionAPI,
	runtime: IExtensionRuntime,
): Promise<void> {
	const providerRegistrationCheckpoint = [...runtime.pendingProviderRegistrations];
	if (!runtime.settingsSectionOwners) runtime.settingsSectionOwners = new Map();
	const settingsOwners = runtime.settingsSectionOwners;
	const settingsOwnerCheckpoint = new Map(settingsOwners);

	try {
		await factory(api);
	} catch (error) {
		runtime.pendingProviderRegistrations.splice(
			0,
			runtime.pendingProviderRegistrations.length,
			...providerRegistrationCheckpoint,
		);
		settingsOwners.clear();
		for (const [sectionId, owner] of settingsOwnerCheckpoint) {
			settingsOwners.set(sectionId, owner);
		}
		throw error;
	}
}

async function importExtensionModule(extensionPath: string, cwd: string): Promise<PreparedExtension> {
	const resolvedPath = resolvePath(extensionPath, cwd);
	try {
		const module = (await withHostGuard(() => loadLegacyPiModule(resolvedPath))) as LoadedExtensionModule;
		const factory = getExtensionFactory(module);

		if (typeof factory !== "function") {
			return {
				path: extensionPath,
				factory: null,
				resolvedPath,
				error: `Extension does not export a valid factory function: ${extensionPath}`,
			};
		}

		return {
			path: extensionPath,
			factory,
			resolvedPath,
			error: null,
			capabilities: getExtensionCapabilities(module),
			manifest: getExtensionManifest(module),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { path: extensionPath, factory: null, resolvedPath, error: `Failed to load extension: ${message}` };
	}
}

async function resolveSettingsInstance(cwd: string, settingsInstance?: Settings): Promise<Settings> {
	if (settingsInstance) return settingsInstance;
	// A live instance for this cwd already is the best scope there is. Loading a
	// fresh one would register a newer same-cwd instance, which a legacy
	// `SettingsManager.create(cwd)` then prefers over the session's own.
	return findScopedSettings(cwd) ?? Settings.loadIsolated({ cwd });
}

async function bindExtension(
	extensionPath: string,
	imported: PreparedExtension,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	settingsInstance: Settings,
): Promise<{ extension: Extension | null; error: string | null }> {
	const factory = imported.factory;
	if (imported.error !== null || factory === null) {
		return { extension: null, error: imported.error };
	}
	try {
		const grants = imported.trusted === true ? fullExtensionGrants() : resolveExtensionGrants(imported.capabilities);
		// A manifest is validated here rather than at import so a malformed one
		// is reported as a load error naming the file, not a throw from the
		// import. The mirror check keeps the review document from lying about
		// reach, which is the only reason it is worth carrying at all.
		const manifest = readExtensionManifest(imported.manifest, extensionPath);
		if (manifest !== undefined) assertManifestMirrorsCapabilities(manifest, imported.capabilities, extensionPath);
		const extension = createExtension(extensionPath, imported.resolvedPath, grants, manifest);
		if (grants.unknown.length > 0) {
			return {
				extension: null,
				error: `Extension declares capabilities this runtime does not implement: ${grants.unknown.join(", ")}: ${extensionPath}`,
			};
		}
		if (grants.malformed.length > 0) {
			return {
				extension: null,
				error: `Extension declares capabilities it cannot use: ${grants.malformed.join("; ")}: ${extensionPath}`,
			};
		}
		const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus, settingsInstance, grants);
		await withHostGuard(() => runExtensionFactory(factory, api, runtime));

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * Create an Extension from an inline factory function.
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: IExtensionRuntime,
	name = "<inline>",
	settingsInstance?: Settings,
): Promise<Extension> {
	const scopedSettings = await resolveSettingsInstance(cwd, settingsInstance);
	// An inline factory is host-constructed, not a loaded extension: the caller
	// already holds everything it passes on, so it is trusted by construction.
	const trusted = fullExtensionGrants();
	const extension = createExtension(name, name, trusted);
	const api = new ConcreteExtensionAPI(PiCodingAgent, extension, runtime, cwd, eventBus, scopedSettings, trusted);
	await runExtensionFactory(factory, api, runtime);
	return extension;
}

/**
 * Load extensions from paths.
 *
 * Module import (the dominant cold-start cost — file I/O plus module
 * evaluation) runs concurrently across extensions; factory binding then runs
 * sequentially in the original path order, so shared runtime defaults and
 * collision diagnostics stay deterministic.
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: IExtensionRuntime,
	settingsInstance?: Settings,
): Promise<LoadExtensionsResult> {
	const preparedExtensions = await Promise.all(paths.map(extPath => importExtensionModule(extPath, cwd)));
	return bindPreparedExtensions(preparedExtensions, cwd, eventBus, runtime, settingsInstance);
}

/**
 * Bind previously imported extension factories. A fresh session runtime is
 * created unless `runtime` is given: deferred startup extensions bind into the
 * live session's runtime so they share its flag values and wired actions.
 */
export async function bindPreparedExtensions(
	preparedExtensions: readonly PreparedExtension[],
	cwd: string,
	eventBus?: EventBus,
	runtime: IExtensionRuntime = new ExtensionRuntime(),
	settingsInstance?: Settings,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const resolvedEventBus = eventBus ?? new EventBus();
	const scopedSettings = await resolveSettingsInstance(cwd, settingsInstance);

	for (const prepared of preparedExtensions) {
		const { extension, error } = await bindExtension(
			prepared.path,
			prepared,
			cwd,
			resolvedEventBus,
			runtime,
			scopedSettings,
		);

		if (error) {
			errors.push({ path: prepared.path, error });
			continue;
		}

		if (extension) {
			// A manifest name is the extension's review identity, so two
			// extensions claiming one name would make that identity
			// ambiguous. Refuse the later claimant rather than letting load
			// order decide which one a reviewer thought they were reading.
			const claimed = extension.manifest;
			if (claimed !== undefined && extensions.some(other => other.manifest?.name === claimed.name)) {
				errors.push({
					path: prepared.path,
					error: `Extension declares the manifest name "${claimed.name}", already claimed by another loaded extension`,
				});
				continue;
			}
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime,
		preparedExtensions: [...preparedExtensions],
	};
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

const CONFIGURED_EXTENSION_DIRECTORY_OPTIONS = {
	indexNames: ["index.ts", "index.js"],
	isScanFile: isExtensionFile,
	throwUnexpectedStatErrors: true,
	onReadError: (filePath: string, error: unknown) => {
		logger.warn("Failed to resolve extension directory", { path: filePath, error: String(error) });
	},
};

async function discoverHooksInPackageRoot(root: string): Promise<string[]> {
	const hooks: string[] = [];
	for (const hookType of ["pre", "post"]) {
		const hookDir = path.join(root, "hooks", hookType);
		let entries: fs1.Dirent[];
		try {
			entries = await fs.readdir(hookDir, { withFileTypes: true });
		} catch (err) {
			if (isEnoent(err) || isEacces(err) || hasFsCode(err, "ENOTDIR") || hasFsCode(err, "EPERM")) continue;
			throw err;
		}
		for (const entry of entries) {
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				hooks.push(path.join(hookDir, entry.name));
			}
		}
	}
	return hooks;
}

/**
 * Discover absolute paths of extensions to load, without importing or
 * binding factories. Hot path on session startup — the scan walks native
 * `.omp`/`.pi` extension capabilities, JS/TS hook factories, the
 * installed-plugin tree, and any configured paths.
 *
 * The root session imports these paths once and forwards prepared factories to
 * subagents. Each child rebinds fresh Extension instances to its OWN
 * ExtensionAPI (cwd, eventBus, runtime) without re-evaluating the module graph.
 */
export interface DiscoverExtensionPathOptions {
	/** Include ambient native extensions, hooks, and installed plugins. */
	ambient?: boolean;
	/** Include ambient hook factories. Disable for read-only catalog commands. */
	includeAmbientHooks?: boolean;
}

export async function discoverExtensionPaths(
	configuredPaths: string[],
	cwd: string,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
): Promise<string[]> {
	const allPaths: string[] = [];
	const seen = new Set<string>();
	const disabled = new Set(disabledExtensionIds ?? []);
	const loadOptions = disabledExtensionIds ? { cwd, disabledExtensions: disabledExtensionIds } : { cwd };

	const isDisabledName = (name: string): boolean => disabled.has(`extension-module:${name}`);

	// Key on the real file so a symlink and its target load once, e.g. an
	// extensions/ symlink plus the same file passed with --extension. Missing
	// paths keep their lexical key so the loader still reports them.
	const addPath = async (extPath: string): Promise<void> => {
		const resolved = path.resolve(extPath);
		const key = await fs.realpath(resolved).catch(() => resolved);
		if (!seen.has(key)) {
			seen.add(key);
			allPaths.push(extPath);
		}
	};

	const addPaths = async (paths: string[]): Promise<void> => {
		for (const extPath of paths) {
			if (isDisabledName(getExtensionNameFromPath(extPath))) continue;
			await addPath(extPath);
		}
	};

	const ambient = options.ambient !== false;
	if (ambient) {
		// 1. Discover extension modules via capability API (native .omp/.pi only).
		// Scope the load to the native provider — the extension-module capability
		// also has claude/codex/gemini/opencode providers, and their items were
		// discarded here anyway (see #4198). The provider filter skips the walk
		// entirely instead of running four foreign directory scans and dropping
		// the results.
		const discovered = await loadCapability<ExtensionModule>(extensionModuleCapability.id, {
			...loadOptions,
			providers: ["native"],
		});
		for (const ext of discovered.items) {
			await addPath(ext.path);
		}
	}

	// 2. Discover JS/TS hook factories and bind them through the extension
	// runner, which owns the current runtime event bus. Non-ambient discovery
	// scans only this invocation's configured package roots; it must not consult
	// settings, installed packages, or process-global CLI injection state.
	if (ambient) {
		if (options.includeAmbientHooks !== false) {
			const hooks = await loadCapability<Hook>(hookCapability.id, loadOptions);
			for (const hookPath of hooks.items
				.map(hook => hook.path)
				.filter(hookPath => isExtensionFile(path.basename(hookPath)))) {
				await addPath(hookPath);
			}
		}
	} else {
		for (const configuredPath of configuredPaths) {
			await addPaths(await discoverHooksInPackageRoot(resolvePath(configuredPath, cwd)));
		}
	}

	// 3. Discover extension entry points from installed plugins.
	if (ambient) {
		await addPaths(await getAllPluginExtensionPaths(cwd));
	}

	// 4. Explicitly configured paths
	for (const configuredPath of configuredPaths) {
		const resolved = resolvePath(configuredPath, cwd);

		let stat: fs1.Stats | null = null;
		try {
			stat = await fs.stat(resolved);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		if (stat?.isDirectory()) {
			await addPaths(resolveExtensionDirectory(resolved, CONFIGURED_EXTENSION_DIRECTORY_OPTIONS).files);
			continue;
		}

		await addPath(resolved);
	}

	return allPaths;
}

/**
 * Discover and load extensions from standard locations. Composed of
 * {@link discoverExtensionPaths} (FS scan) + {@link loadExtensions}
 * (per-session binding).
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	eventBus?: EventBus,
	disabledExtensionIds?: string[],
	options: DiscoverExtensionPathOptions = {},
	settingsInstance?: Settings,
): Promise<LoadExtensionsResult> {
	const paths = await discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, options);
	return loadExtensions(paths, cwd, eventBus, undefined, settingsInstance);
}
