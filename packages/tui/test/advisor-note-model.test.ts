import { beforeAll, describe, expect, test } from "bun:test";
import { createAdvisorMessageCard } from "@oh-my-pi/pi-tui/chat/advisor-message";
import type { AdvisorNote } from "@oh-my-pi/pi-tui/chat/messages";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

type NativeNodeLike = {
	t?: string;
	p?: { spans?: { t?: string }[] };
	c?: NativeNodeLike[];
};

const DESCRIBE_CONTEXT: DescribeContext = {
	cols: 100,
	reduceMotion: true,
	dark: true,
	supports: () => true,
	feature: () => false,
};

/** The terminal (ANSI) rendering of a single advisor note. */
function renderNote(note: AdvisorNote): string {
	return createAdvisorMessageCard({ notes: [note] }, () => true, theme)
		.render(100)
		.join("\n");
}

/** The plain text of the native (span) rendering, free of styling. */
function nativeText(note: AdvisorNote): string {
	const node = createAdvisorMessageCard({ notes: [note] }, () => true, theme).describe?.(DESCRIBE_CONTEXT);
	if (!node) throw new Error("advisor card did not describe itself");
	const parts: string[] = [];
	const visit = (n: NativeNodeLike): void => {
		if (typeof n.t === "string") parts.push(n.t);
		for (const span of n.p?.spans ?? []) if (typeof span.t === "string") parts.push(span.t);
		for (const child of n.c ?? []) visit(child);
	};
	visit(node as unknown as NativeNodeLike);
	return parts.join("");
}

describe("advisor note model attribution", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	test("a named advisor's note names the model that actually produced it", () => {
		const note: AdvisorNote = {
			note: "Check the cache",
			advisor: "m365",
			advisorModel: "m365-advisor/m365-copilot",
		};
		for (const rendered of [renderNote(note), nativeText(note)]) {
			expect(rendered).toContain("m365");
			expect(rendered).toContain("m365-advisor/m365-copilot");
		}
	});

	test("the default advisor's note is labelled with its model, not left anonymous", () => {
		const note: AdvisorNote = { note: "Check the cache", advisorModel: "anthropic/claude-sonnet-4-5" };
		for (const rendered of [renderNote(note), nativeText(note)]) {
			expect(rendered).toContain("anthropic/claude-sonnet-4-5");
		}
	});

	test("a note with no recorded model renders exactly as before", () => {
		const note: AdvisorNote = { note: "Check the cache", advisor: "m365" };
		for (const rendered of [renderNote(note), nativeText(note)]) {
			expect(rendered).toContain("m365");
			expect(rendered).not.toContain("undefined");
			expect(rendered).not.toContain("null");
		}
	});
});
