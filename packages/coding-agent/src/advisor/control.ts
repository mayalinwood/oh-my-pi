import type { AdvisorRuntimeStatus } from "./config";

/** Context handling requested while ensuring an Advisor lifecycle state. */
export type AdvisorResetMode = "none" | "context";

/**
 * A deterministic, session-local Advisor lifecycle request.
 *
 * `reason` and `idempotencyKey` must both contain non-whitespace text. When a
 * roster has more than one advisor, callers must name one advisor or explicitly
 * set `allowMultiple`.
 */
export interface EnsureAdvisorRequest {
	enabled: boolean;
	reason: string;
	idempotencyKey: string;
	advisor?: string;
	resetMode?: AdvisorResetMode;
	allowMultiple?: boolean;
}

/** Observable outcome of an Advisor lifecycle request. */
export type EnsureAdvisorOutcome = "enabled" | "disabled" | "unchanged" | "unavailable" | "rejected";

/** Result returned by {@link EnsureAdvisorRequest}. */
export interface EnsureAdvisorResult {
	outcome: EnsureAdvisorOutcome;
	/** Human-readable explanation, especially for unavailable/rejected outcomes. */
	reason: string;
	/** Current session lifecycle generation when this result is returned. */
	generation: number;
	/** True when this result came from a previously completed request with the same key. */
	idempotent: boolean;
	/** True only when an existing runtime's private context was rebuilt at the current primary cursor. */
	resetApplied: boolean;
	/** Current session-level Advisor enable state. */
	enabled: boolean;
	/** Whether at least one Advisor runtime is live. */
	active: boolean;
	/** Advisor names in the resolved request scope. */
	advisors: string[];
}

/** Public, content-free model identity for one Advisor runtime. */
export interface AdvisorStatusModel {
	provider: string;
	id: string;
}

/** Content-free runtime status for one configured Advisor. */
export interface AdvisorStatusEntry {
	name: string;
	status: AdvisorRuntimeStatus;
	active: boolean;
	model?: AdvisorStatusModel;
	configuredToolNames: string[];
}

/** Content-free Advisor lifecycle, roster, and aggregate usage snapshot. */
export interface AdvisorStatus {
	generation: number;
	configured: boolean;
	enabled: boolean;
	active: boolean;
	advisors: AdvisorStatusEntry[];
	/** Aggregate Advisor tokens recorded by the live session. */
	tokens: number;
	/** Cumulative Advisor cost for the session; lifecycle refreshes never clear it. */
	cost: number;
}
