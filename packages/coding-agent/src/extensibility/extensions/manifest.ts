import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Static manifest for an extension.
 *
 * Following the Codex model, an extension publishes what it claims to be so a
 * reviewer can read that claim without executing the module. Capabilities stay
 * the single authority for what an extension may reach; a manifest may mirror
 * them for one-document review, and the loader rejects the load when the mirror
 * disagrees, so a manifest can neither under-report nor over-report its reach.
 */

/** Raised when a module exports a manifest the runtime cannot honour. */
export class ExtensionManifestInvalid extends Error {
	constructor(extensionPath: string, detail: string) {
		super(`Extension "${extensionPath}" declares an invalid manifest: ${detail}`);
		this.name = "ExtensionManifestInvalid";
	}
}

/** What an extension publishes about itself for review and identification. */
export interface ExtensionManifest {
	/** Stable identity, unique among the loaded set. */
	readonly name: string;
	/** Opaque version string; the runtime does not interpret it. */
	readonly version: string;
	/** One-line human summary shown in review surfaces. */
	readonly description?: string;
	/**
	 * Optional mirror of the module's own `capabilities` export. Compared by
	 * reach rather than by text, so reordering is tolerated but under- or
	 * over-declaring is a load failure.
	 */
	readonly capabilities?: unknown;
}

/** Mirrors the npm identity dialect the settings tokens already assume. */
const MANIFEST_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const MANIFEST_KEYS: ReadonlySet<string> = new Set(["name", "version", "description", "capabilities"]);

/**
 * Validate a module's `manifest` export.
 *
 * Absent means the extension publishes no review identity, mirroring how an
 * absent capability declaration means no grants: both default closed.
 */
export function readExtensionManifest(raw: unknown, extensionPath: string): ExtensionManifest | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) throw new ExtensionManifestInvalid(extensionPath, "expected an object");

	const unknownKeys = Object.keys(raw).filter(key => !MANIFEST_KEYS.has(key));
	if (unknownKeys.length > 0) {
		throw new ExtensionManifestInvalid(
			extensionPath,
			`unknown key(s) ${unknownKeys.sort().join(", ")}; expected name, version, description, capabilities`,
		);
	}

	const { name, version, description } = raw;
	if (typeof name !== "string" || !MANIFEST_NAME.test(name)) {
		throw new ExtensionManifestInvalid(
			extensionPath,
			`"name" must match ${MANIFEST_NAME.source}; got ${JSON.stringify(name)}`,
		);
	}
	if (typeof version !== "string" || version.length === 0) {
		throw new ExtensionManifestInvalid(extensionPath, `"version" must be a non-empty string`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new ExtensionManifestInvalid(extensionPath, `"description" must be a string when present`);
	}

	return Object.freeze({
		name,
		version,
		...(description === undefined ? {} : { description }),
		...(raw.capabilities === undefined ? {} : { capabilities: raw.capabilities }),
	});
}

/**
 * Reduce a capability declaration to the reach it asserts, so a mirror can be
 * compared by what it allows rather than by how it is written. Kinds and exec
 * grants are sorted because the gate itself treats them as sets.
 */
function canonicalReach(declared: unknown): string[] | undefined {
	if (!Array.isArray(declared)) return undefined;
	const reach: string[] = [];
	for (const entry of declared) {
		if (!isRecord(entry) || typeof entry.kind !== "string") return undefined;
		if (entry.kind !== "process:exec") {
			reach.push(entry.kind);
			continue;
		}
		const command = typeof entry.command === "string" ? entry.command : "*";
		const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === "string") : [];
		reach.push(`process:exec ${command} ${args.join(" ")}`);
	}
	return reach.sort();
}

/**
 * Reject a manifest whose capability mirror disagrees with the module's own
 * declaration. Text differences and ordering are tolerated; a different reach
 * is not, because that is exactly the case a reviewer would be misled by.
 */
export function assertManifestMirrorsCapabilities(
	manifest: ExtensionManifest,
	declared: unknown,
	extensionPath: string,
): void {
	if (manifest.capabilities === undefined) return;
	const mirrored = canonicalReach(manifest.capabilities);
	const actual = canonicalReach(declared);
	// A declaration shape the gate will reject anyway needs no comparison here;
	// resolveExtensionGrants reports that failure with the better message.
	if (mirrored === undefined || actual === undefined) return;
	if (mirrored.join("|") !== actual.join("|")) {
		throw new ExtensionManifestInvalid(
			extensionPath,
			`manifest mirrors ${mirrored.join(", ") || "nothing"} but the module declares ${actual.join(", ") || "nothing"}`,
		);
	}
}
