/**
 * Extension settings-section contracts shared by the extension host (which
 * registers sections) and the native /settings selector (which renders them).
 * Pure data shapes: the coding-agent package re-exports them for authors.
 */
// ============================================================================
// Settings Section Registration
// ============================================================================

export type ExtensionSettingValue = boolean | number | string;

/**
 * Layer supplying an extension setting's effective value. Mirrors the host settings
 * precedence order; the extension never chooses this.
 */
export type ExtensionSettingProvenance = "runtime" | "overlay" | "project" | "global" | "default";

interface ExtensionSettingFieldBase<Key extends string = string> {
	/** Stable YAML key stored below `extensionSettings.<section-id>`. */
	key: Key;
	label: string;
	description: string;
}

export interface ExtensionBooleanSettingField<Key extends string = string> extends ExtensionSettingFieldBase<Key> {
	type: "boolean";
	default: boolean;
}

export interface ExtensionIntegerSettingField<Key extends string = string> extends ExtensionSettingFieldBase<Key> {
	type: "integer";
	default: number;
	min?: number;
	max?: number;
}

export interface ExtensionNumberSettingField<Key extends string = string> extends ExtensionSettingFieldBase<Key> {
	type: "number";
	default: number;
	min?: number;
	max?: number;
}

export interface ExtensionEnumSettingField<
	Key extends string = string,
	Values extends readonly string[] = readonly string[],
> extends ExtensionSettingFieldBase<Key> {
	type: "enum";
	default: Values[number];
	values: Values;
}

export interface ExtensionTextSettingField<Key extends string = string> extends ExtensionSettingFieldBase<Key> {
	type: "text";
	default: string;
	minLength?: number;
	maxLength?: number;
	/** JavaScript regular-expression source matched against the complete value. */
	pattern?: string;
}

export type ExtensionSettingField =
	| ExtensionBooleanSettingField
	| ExtensionIntegerSettingField
	| ExtensionNumberSettingField
	| ExtensionEnumSettingField
	| ExtensionTextSettingField;

export type ExtensionSettingFieldValue<Field extends ExtensionSettingField> = Field extends ExtensionBooleanSettingField
	? boolean
	: Field extends ExtensionIntegerSettingField | ExtensionNumberSettingField
		? number
		: Field extends ExtensionEnumSettingField<string, infer Values>
			? Values[number]
			: string;

export type ExtensionSettingsSnapshot<Fields extends readonly ExtensionSettingField[]> = Readonly<{
	[Field in Fields[number] as Field["key"]]: ExtensionSettingFieldValue<Field>;
}>;

/** Content-free, non-persistent live information rendered beneath an extension settings section. */
export interface ExtensionSettingsStatusRow {
	label: string;
	value: string;
	description?: string;
}

export interface ExtensionSettingsSectionDefinition<
	Fields extends readonly ExtensionSettingField[] = readonly ExtensionSettingField[],
> {
	/** Stable lowercase id used in the reserved YAML namespace. */
	id: string;
	/** Human-readable heading in `/settings`. */
	label: string;
	description?: string;
	fields: Fields;
	/**
	 * Optional live status. Rows are read-only and never written to configuration.
	 * Keep values compact and content-free; do not return credentials, prompts, paths, or commands.
	 */
	getStatus?: () => readonly ExtensionSettingsStatusRow[];
}

/** Internal loaded registration consumed by the native `/settings` selector. */
export interface RegisteredExtensionSettingsSection {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly fields: readonly ExtensionSettingField[];
	readonly snapshot: Readonly<Record<string, ExtensionSettingValue>>;
	readonly extensionPath: string;
	readValues(): Readonly<Record<string, ExtensionSettingValue>>;
	setValue(key: string, value: unknown): void;
	/** Layer currently supplying `key`; `"default"` when nothing is configured. */
	provenanceOf(key: string): ExtensionSettingProvenance;
	/** Clear the project-layer value of `key` so the next launch falls back. */
	resetToDefault(key: string): void;
	getStatus(): readonly ExtensionSettingsStatusRow[];
	isRestartRequired(key?: string): boolean;
}
