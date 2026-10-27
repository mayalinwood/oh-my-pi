import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	type SessionAdvisorsHost,
	type SessionAdvisorsOptions,
	SessionAdvisors,
} from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { YieldQueue } from "@oh-my-pi/pi-coding-agent/session/yield-queue";

/**
 * A note released at a CONTINUING boundary is handed to the aside queue, and the
 * advisor registers that queue with `skipIdleFlush`: the entry is injected only
 * at the next `drainLazy`, and an idle session never drains it. The release is
 * correct while the run goes on — a continuing boundary is the first point where
 * the primary is about to poll asides again.
 *
 * When the run ENDS at that boundary instead, the entry is still queued as the
 * session goes idle, and the operator sees an advisor that clearly reasoned and
 * never spoke. The terminal release already owns that case: an untagged note
 * resolves to a visible card, which is why the release is tagged. This covers
 * the note released early under that assumption and stranded by its failure.
 */
describe("advisor terminal boundary aside sweep", () => {
	it("preserves an advisor aside the run ended before the queue could deliver it", async () => {
		const settings = await Settings.loadIsolated({ inMemory: true });
		const cards: CustomMessage[] = [];
		const yieldQueue = new YieldQueue({
			isStreaming: () => false,
			injectIdle: async () => {},
			scheduleIdleFlush: () => {},
		});
		// Mirrors the real advisor dispatcher: registered, and never idle-flushed, so
		// an idle session keeps the entry instead of starting a turn to deliver it.
		yieldQueue.register<{ note: string; severity?: string }>("advisor", {
			skipIdleFlush: true,
			build: () => null,
		});
		yieldQueue.enqueue("advisor", {
			note: "Concern: the checkpoint guard drops the signed trailer.",
			severity: "concern",
		});

		const host = {
			settings,
			yieldQueue,
			preserveAdvisorCard: (card: CustomMessage) => {
				cards.push(card);
			},
			agent: { state: { thinkingLevel: undefined } },
		} as unknown as SessionAdvisorsHost;

		const advisors = new SessionAdvisors(host, { enabled: false } as unknown as SessionAdvisorsOptions);
		await advisors.onPrimaryTurnEnd([], false);

		// The entry is no longer parked, and it is visible rather than merely counted.
		expect(yieldQueue.has("advisor")).toBe(false);
		expect(cards).toHaveLength(1);
		expect(String(cards[0]?.content)).toContain("the checkpoint guard drops the signed trailer");
	});
});
