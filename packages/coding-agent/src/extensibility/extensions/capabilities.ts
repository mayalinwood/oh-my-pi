/**
 * Declarative capability grants for extension modules.
 *
 * An extension declares up front what host powers it needs; the loader hands
 * it nothing else. The shape follows Zed's `extension.toml` `capabilities`
 * list: the field defaults to empty, an absent or empty declaration denies
 * everything, and a `process:exec` grant is matched per invocation against the
 * command and argument patterns the extension declared — the host performs the
 * check, so an extension cannot grant itself anything.
 *
 * Two host objects are gated, not one. The activation object carries the
 * registration and action members; the `ExtensionContext` handed to event,
 * command and tool handlers carries a separate privileged surface of its own.
 * Gating only the first would leave the same hole one object over.
 */

export type ExtensionCapabilityKind =
	| "process:exec"
	| "events:subscribe"
	| "events:emit"
	| "tools:register"
	| "tools:invoke"
	| "fs:write"
	| "fs:delete"
	| "settings:register"
	| "flags:read"
	| "ui:command"
	| "ui:label"
	| "ui:shortcut"
	| "ui:flag"
	| "ui:message-renderer"
	| "ui:thinking-renderer"
	| "ui:composer-shape"
	| "session:message"
	| "session:append"
	| "session:read"
	| "session:write"
	| "session:compact"
	| "session:abort"
	| "session:shutdown"
	| "session:turn"
	| "session:context"
	| "advisor:read"
	| "advisor:lease"
	| "model:read"
	| "model:write"
	| "model:registry"
	| "provider:register"
	| "host:sdk";

/** A capability an extension can declare. `process:exec` is parameterised. */
export type ExtensionCapability =
	| { kind: "process:exec"; command: string; args: string[] }
	| { kind: Exclude<ExtensionCapabilityKind, "process:exec"> };

/**
 * Which declared capability each activation-object member requires.
 *
 * This table is the whole policy surface for that object: a member absent
 * from it is not privileged and is always present. Keeping it explicit rather
 * than inferring from naming means a new host member is inert until someone
 * decides what it costs.
 */
export const EXTENSION_MEMBER_CAPABILITIES: Readonly<Record<string, ExtensionCapabilityKind>> = {
	on: "events:subscribe",
	events: "events:emit",
	registerTool: "tools:register",
	registerFileWriteFallback: "fs:write",
	registerFileDeleteFallback: "fs:delete",
	registerSettingsSection: "settings:register",
	getFlag: "flags:read",
	flagValues: "ui:flag",
	pendingProviderRegistrations: "provider:register",
	registerCommand: "ui:command",
	setLabel: "ui:label",
	registerShortcut: "ui:shortcut",
	registerFlag: "ui:flag",
	registerMessageRenderer: "ui:message-renderer",
	registerAssistantThinkingRenderer: "ui:thinking-renderer",
	registerComposerShape: "ui:composer-shape",
	sendMessage: "session:message",
	sendUserMessage: "session:message",
	appendEntry: "session:append",
	exec: "process:exec",
	getActiveTools: "session:read",
	getAllTools: "session:read",
	getCommands: "session:read",
	getSessionName: "session:read",
	setActiveTools: "session:write",
	setSessionName: "session:write",
	getAdvisorStatus: "advisor:read",
	ensureAdvisor: "advisor:lease",
	getThinkingLevel: "model:read",
	getServiceTiers: "model:read",
	setModel: "model:write",
	setThinkingLevel: "model:write",
	setServiceTier: "model:write",
	registerProvider: "provider:register",
	unregisterProvider: "provider:register",
	pi: "host:sdk",
};

/** Which declared capability each `ExtensionContext` member requires. */
export const CONTEXT_MEMBER_CAPABILITIES: Readonly<Record<string, ExtensionCapabilityKind>> = {
	compact: "session:compact",
	abort: "session:abort",
	shutdown: "session:shutdown",
	runEphemeralTurn: "session:turn",
	addAdditionalContext: "session:context",
	invokeTool: "tools:invoke",
	sessionManager: "session:read",
	getSystemPrompt: "session:read",
	modelRegistry: "model:registry",
	model: "model:read",
	models: "model:read",
	newSession: "session:write",
	branch: "session:write",
	navigateTree: "session:write",
	switchSession: "session:write",
	reload: "session:write",
};

const ALL_CAPABILITY_KINDS = new Set<string>([
	...Object.values(EXTENSION_MEMBER_CAPABILITIES),
	...Object.values(CONTEXT_MEMBER_CAPABILITIES),
]);

/** Raised when an extension reaches for host power it did not declare. */
export class ExtensionCapabilityDenied extends Error {
	readonly capability: ExtensionCapabilityKind;

	constructor(extensionPath: string, member: string, capability: ExtensionCapabilityKind) {
		super(
			`Extension "${extensionPath}" used "${member}", which requires the "${capability}" capability. ` +
				`Declare it in the extension's capabilities to use it.`,
		);
		this.name = "ExtensionCapabilityDenied";
		this.capability = capability;
	}
}

/** The grants resolved for one extension, after validation. */
export interface ResolvedExtensionGrants {
	/** Unparameterised capability kinds this extension holds. */
	kinds: ReadonlySet<ExtensionCapabilityKind>;
	/** `process:exec` grants, each a command plus argument patterns. */
	exec: ReadonlyArray<{ command: string; args: readonly string[] }>;
	/** Capability names the declaration used that this runtime does not know. */
	unknown: readonly string[];
}

/**
 * Match one argument against a declared pattern.
 *
 * `*` matches within a path segment, `**` spans segments, following Zed's
 * glob dialect for `process:exec` argument patterns.
 */
function matchesPattern(pattern: string, value: string): boolean {
	if (pattern === "**") return true;
	if (!pattern.includes("*")) return pattern === value;

	const escaped = pattern
		.split("**")
		.map(part =>
			part
				.split("*")
				.map(segment => segment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
				.join("[^/]*"),
		)
		.join(".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function matchesArgs(patterns: readonly string[], args: readonly string[]): boolean {
	// Declared patterns must cover the invocation in order. A trailing `**`
	// absorbs the remainder, which is how an extension says "this command, any
	// arguments" without thereby saying "any command".
	let index = 0;
	for (const pattern of patterns) {
		if (pattern === "**" && index === patterns.length - 1) return true;
		if (index >= args.length) return false;
		if (!matchesPattern(pattern, args[index]!)) return false;
		index += 1;
	}
	return index === args.length;
}

/**
 * Resolve a declared capability list into enforceable grants.
 *
 * Malformed entries are dropped rather than trusted: an unparseable grant must
 * never widen access, and an unknown kind is reported so the declaration fails
 * loudly in review rather than quietly doing nothing.
 */
export function resolveExtensionGrants(declared: unknown): ResolvedExtensionGrants {
	const kinds = new Set<ExtensionCapabilityKind>();
	const exec: Array<{ command: string; args: readonly string[] }> = [];
	const unknown: string[] = [];

	if (!Array.isArray(declared)) return { kinds, exec, unknown };

	for (const entry of declared) {
		if (typeof entry !== "object" || entry === null) continue;
		const { kind } = entry as { kind?: unknown };
		if (typeof kind !== "string" || !ALL_CAPABILITY_KINDS.has(kind)) {
			if (typeof kind === "string") unknown.push(kind);
			continue;
		}
		if (kind === "process:exec") {
			const { command, args } = entry as { command?: unknown; args?: unknown };
			if (typeof command !== "string" || command.length === 0) continue;
			if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) continue;
			kinds.add(kind);
			exec.push({ command, args: args as string[] });
			continue;
		}
		kinds.add(kind as ExtensionCapabilityKind);
	}

	return { kinds, exec, unknown };
}

/**
 * Grants for code the host constructed itself.
 *
 * An inline factory is not an untrusted extension: the caller already holds
 * the powers it hands out, so gating it would refuse work the caller is
 * entitled to do. Only extensions loaded from a path are gated.
 */
export function fullExtensionGrants(): ResolvedExtensionGrants {
	return { kinds: new Set(ALL_CAPABILITY_KINDS) as Set<ExtensionCapabilityKind>, exec: [], unknown: [] };
}

/** Whether a resolved grant set permits one specific process invocation. */
export function grantsAllowExec(grants: ResolvedExtensionGrants, command: string, args: readonly string[]): boolean {
	return grants.exec.some(grant => grant.command === command && matchesArgs(grant.args, args));
}

/**
 *
 * `process:exec` is the one capability whose grant is parameterised, so a
 * holder keeps the real member and the host checks each invocation instead.
 */
function makeDeniedMember(
	extensionPath: string,
	member: string,
	capability: ExtensionCapabilityKind,
	execCheck?: ExecGrantCheck,
): unknown {
	if (capability === "process:exec" && execCheck) {
		const deny = () => {
			throw new ExtensionCapabilityDenied(extensionPath, member, capability);
		};
		return (command: string, args: string[] = [], ...rest: unknown[]) => {
			if (grantsAllowExec(execCheck.grants, command, args)) {
				return execCheck.dispatch(command, args, rest);
			}
			return deny();
		};
	}
	return () => {
		throw new ExtensionCapabilityDenied(extensionPath, member, capability);
	};
}

/** The invocation check handed to {@link makeDeniedMember} for `process:exec`. */
export interface ExecGrantCheck {
	grants: ResolvedExtensionGrants;
	dispatch: (command: string, args: string[], rest: unknown[]) => unknown;
}

/**
 * Replace every member of `target` whose capability was not granted with a
 * stub that refuses and names the missing grant.
 *
 * Refusing rather than deleting keeps the object's shape stable, so a denied
 * call surfaces as a legible error at the call site instead of an
 * `undefined is not a function` several frames away. Members absent from the
 * table are not privileged and are left untouched.
 */
export function applyCapabilityGate(
	target: object,
	table: Readonly<Record<string, ExtensionCapabilityKind>>,
	grants: ResolvedExtensionGrants,
	extensionPath: string,
	execCheck?: ExecGrantCheck,
): void {
	for (const [member, capability] of Object.entries(table)) {
		if (!(member in target)) continue;
		// A held `process:exec` is still wrapped: its grant names a command
		// and argument patterns, so the decision belongs to the individual
		// invocation rather than to load time. An unheld one is refused
		// outright, dispatcher or not — a missing grant must never leave a
		// process spawn reachable.
		const parameterised = capability === "process:exec";
		const granted = grants.kinds.has(capability);
		if (parameterised ? granted && !execCheck : granted) continue;
		Object.defineProperty(target, member, {
			value: makeDeniedMember(extensionPath, member, capability, execCheck),
			writable: false,
			configurable: true,
		});
	}
}
