import type { Settings } from "../../config/settings";
import type {
	ExtensionSettingField,
	ExtensionSettingsSectionDefinition,
	ExtensionSettingsStatusRow,
	ExtensionSettingProvenance,
	ExtensionSettingValue,
	RegisteredExtensionSettingsSection,
} from "./types";

const SECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const FIELD_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const FIELD_TYPES: Record<string, true> = {
	boolean: true,
	integer: true,
	number: true,
	enum: true,
	text: true,
};

function nonEmptyText(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${name} must contain non-whitespace text`);
	}
	return value;
}

function compactStatusText(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.trim().length === 0) ||
		value.length > maxLength ||
		CONTROL_CHARACTER_PATTERN.test(value)
	) {
		throw new TypeError(
			`${name} must be ${allowEmpty ? "" : "non-empty "}single-line text up to ${maxLength} characters`,
		);
	}
	return value;
}

function validateBound(value: unknown, name: string, integer: boolean): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
		throw new TypeError(`${name} must be a finite ${integer ? "integer" : "number"}`);
	}
	return value;
}
function compileFullTextPattern(source: string): RegExp {
	return new RegExp(`^(?:${source})$`, "u");
}

function matchesFullTextPattern(pattern: RegExp, value: string): boolean {
	const match = pattern.exec(value);
	return match !== null && match[0].length === value.length;
}

export function validateExtensionSettingValue(field: ExtensionSettingField, value: unknown): ExtensionSettingValue {
	const path = `extension setting "${field.key}"`;
	switch (field.type) {
		case "boolean":
			if (typeof value !== "boolean") throw new TypeError(`${path} must be a boolean`);
			return value;
		case "integer":
		case "number": {
			const integer = field.type === "integer";
			if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
				throw new TypeError(`${path} must be a finite ${integer ? "integer" : "number"}`);
			}
			if (field.min !== undefined && value < field.min)
				throw new RangeError(`${path} must be at least ${field.min}`);
			if (field.max !== undefined && value > field.max) throw new RangeError(`${path} must be at most ${field.max}`);
			return value;
		}
		case "enum":
			if (typeof value !== "string" || !field.values.includes(value)) {
				throw new TypeError(`${path} must be one of: ${field.values.join(", ")}`);
			}
			return value;
		case "text": {
			if (typeof value !== "string") throw new TypeError(`${path} must be text`);
			if (field.minLength !== undefined && value.length < field.minLength) {
				throw new RangeError(`${path} must contain at least ${field.minLength} characters`);
			}
			if (field.maxLength !== undefined && value.length > field.maxLength) {
				throw new RangeError(`${path} must contain at most ${field.maxLength} characters`);
			}
			if (field.pattern !== undefined && !matchesFullTextPattern(compileFullTextPattern(field.pattern), value)) {
				throw new TypeError(`${path} has an invalid format`);
			}
			return value;
		}
	}
}

function normalizeField(field: ExtensionSettingField): ExtensionSettingField {
	if (!field || typeof field !== "object" || !Object.hasOwn(FIELD_TYPES, field.type)) {
		throw new TypeError("Extension setting fields must use boolean, integer, number, enum, or text");
	}
	if (!FIELD_KEY_PATTERN.test(field.key)) {
		throw new TypeError(`Extension setting key "${field.key}" must match ${FIELD_KEY_PATTERN.source}`);
	}
	nonEmptyText(field.label, `Label for extension setting "${field.key}"`);
	if (typeof field.description !== "string") {
		throw new TypeError(`Description for extension setting "${field.key}" must be text`);
	}

	if (field.type === "integer" || field.type === "number") {
		const integer = field.type === "integer";
		const min = validateBound(field.min, `Minimum for extension setting "${field.key}"`, integer);
		const max = validateBound(field.max, `Maximum for extension setting "${field.key}"`, integer);
		if (min !== undefined && max !== undefined && min > max) {
			throw new RangeError(`Minimum for extension setting "${field.key}" cannot exceed its maximum`);
		}
	}
	if (field.type === "enum") {
		if (field.values.length === 0 || field.values.some(value => typeof value !== "string" || value.length === 0)) {
			throw new TypeError(`Enum extension setting "${field.key}" must declare non-empty text values`);
		}
		if (new Set(field.values).size !== field.values.length) {
			throw new TypeError(`Enum extension setting "${field.key}" cannot contain duplicate values`);
		}
	}
	if (field.type === "text") {
		const minLength = validateBound(field.minLength, `Minimum length for extension setting "${field.key}"`, true);
		const maxLength = validateBound(field.maxLength, `Maximum length for extension setting "${field.key}"`, true);
		if (minLength !== undefined && minLength < 0) throw new RangeError(`Minimum length cannot be negative`);
		if (maxLength !== undefined && maxLength < 0) throw new RangeError(`Maximum length cannot be negative`);
		if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
			throw new RangeError(`Minimum length for extension setting "${field.key}" cannot exceed its maximum`);
		}
		if (field.pattern !== undefined) {
			try {
				compileFullTextPattern(field.pattern);
			} catch {
				throw new TypeError(`Pattern for extension setting "${field.key}" is not a valid regular expression`);
			}
		}
	}

	validateExtensionSettingValue(field, field.default);
	return Object.freeze(
		field.type === "enum" ? { ...field, values: Object.freeze([...field.values]) } : { ...field },
	) as ExtensionSettingField;
}

function decodeValues(
	sectionId: string,
	fields: readonly ExtensionSettingField[],
	raw: unknown,
): Readonly<Record<string, ExtensionSettingValue>> {
	if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
		throw new TypeError(`extensionSettings.${sectionId} must be a mapping`);
	}
	const record = (raw ?? {}) as Record<string, unknown>;
	const knownKeys = new Set(fields.map(field => field.key));
	const unknownKeys = Object.keys(record).filter(key => !knownKeys.has(key));
	if (unknownKeys.length > 0) {
		throw new TypeError(`extensionSettings.${sectionId} contains unknown keys: ${unknownKeys.join(", ")}`);
	}

	const values: Record<string, ExtensionSettingValue> = {};
	for (const field of fields) {
		const rawValue = Object.hasOwn(record, field.key) ? record[field.key] : field.default;
		values[field.key] = validateExtensionSettingValue(field, rawValue);
	}
	return Object.freeze(values);
}

function readStatusRows(
	getStatus: (() => readonly ExtensionSettingsStatusRow[]) | undefined,
): readonly ExtensionSettingsStatusRow[] {
	if (!getStatus) return Object.freeze([]);
	const rows = getStatus();
	if (!Array.isArray(rows)) throw new TypeError("Extension settings status must be an array");
	if (rows.length > 32) throw new RangeError("Extension settings status cannot contain more than 32 rows");
	return Object.freeze(
		rows.map((row, index) => {
			if (!row || typeof row !== "object")
				throw new TypeError(`Extension settings status row ${index} must be an object`);
			const label = compactStatusText(row.label, `Extension settings status row ${index} label`, 80);
			const value = compactStatusText(row.value, `Extension settings status row ${index} value`, 160, true);
			const description =
				row.description === undefined
					? undefined
					: compactStatusText(row.description, `Extension settings status row ${index} description`, 240, true);
			return Object.freeze({ label, value, description });
		}),
	);
}

export function registerExtensionSettingsSection(
	definition: ExtensionSettingsSectionDefinition,
	settings: Settings,
	extensionPath: string,
): RegisteredExtensionSettingsSection {
	const id = definition.id;
	if (!SECTION_ID_PATTERN.test(id)) {
		throw new TypeError(`Extension settings section id "${id}" must match ${SECTION_ID_PATTERN.source}`);
	}
	const label = nonEmptyText(definition.label, `Extension settings section "${id}" label`);
	const description = definition.description;
	if (description !== undefined && typeof description !== "string") {
		throw new TypeError(`Extension settings section "${id}" description must be text`);
	}
	const statusProvider = definition.getStatus;
	if (statusProvider !== undefined && typeof statusProvider !== "function") {
		throw new TypeError(`Extension settings section "${id}" status provider must be a function`);
	}
	const declaredFields = definition.fields;
	if (!Array.isArray(declaredFields) || declaredFields.length === 0 || declaredFields.length > 64) {
		throw new TypeError(`Extension settings section "${id}" must declare between 1 and 64 fields`);
	}

	const fields = Object.freeze(declaredFields.map(normalizeField));
	const keys = new Set<string>();
	for (const field of fields) {
		if (keys.has(field.key)) throw new TypeError(`Duplicate extension setting key "${field.key}"`);
		keys.add(field.key);
	}
	const readValues = () => decodeValues(id, fields, settings.getExtensionSettingsSection(id));
	const snapshot = readValues();
	const requireField = (key: string): ExtensionSettingField => {
		const field = fields.find(candidate => candidate.key === key);
		if (!field) throw new TypeError(`Unknown extension setting "${id}.${key}"`);
		return field;
	};
	// A session-level decision outranks anything on disk, so those keys are not editable here.
	// Surface that as a host-owned, content-free status row instead of a silent failure.
	const PINNED_LAYERS: ReadonlySet<string> = new Set(["runtime", "overlay"]);
	const pinnedFields = (): readonly ExtensionSettingsStatusRow[] => {
		const pinned = fields.filter(field => PINNED_LAYERS.has(settings.getExtensionSettingsProvenance(id, field.key)));
		if (pinned.length === 0) return Object.freeze([]);
		const label = pinned.length === 1 ? pinned[0].key : `${pinned.length} settings`;
		return Object.freeze([
			Object.freeze({
				label: "Session-pinned",
				value: label,
				description: "Supplied by a runtime override or config overlay; not editable in project config.",
			}),
		]);
	};

	return Object.freeze({
		id,
		label,
		description,
		fields,
		snapshot,
		extensionPath,
		readValues,
		setValue(key: string, value: unknown): void {
			settings.setProjectExtensionSetting(id, key, validateExtensionSettingValue(requireField(key), value));
		},
		provenanceOf(key: string): ExtensionSettingProvenance {
			requireField(key);
			return settings.getExtensionSettingsProvenance(id, key);
		},
		resetToDefault(key: string): void {
			requireField(key);
			settings.resetExtensionSetting(id, key);
		},
		getStatus: () => Object.freeze([...readStatusRows(statusProvider), ...pinnedFields()]),
		isRestartRequired(key?: string): boolean {
			let current: Readonly<Record<string, ExtensionSettingValue>>;
			try {
				current = readValues();
			} catch {
				return true;
			}
			if (key !== undefined) return !Object.is(current[key], snapshot[key]);
			return fields.some(field => !Object.is(current[field.key], snapshot[field.key]));
		},
	});
}
