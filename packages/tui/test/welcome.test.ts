import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { gradientEscape, PI_LOGO, pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("natively sets the version under the wordmark beside the logo", () => {
		const tree = new WelcomeComponent("18.4.12").describe({} as never);
		expect(tree.c?.[0]).toMatchObject({
			key: "lockup",
			p: { role: "omp.welcome.lockup" },
			c: [
				{ k: "image", key: "logo" },
				{
					k: "col",
					p: { role: "omp.welcome.mark" },
					c: [
						{ p: { role: "omp.welcome.wordmark" } },
						{ p: { role: "omp.welcome.version", spans: [{ t: "v18.4.12" }] } },
					],
				},
			],
		});
	});

	it("uses the Diamat D and diamond mark", () => {
		expect(PI_LOGO).toHaveLength(5);
		expect(PI_LOGO.join("\n")).toContain("◆");
		expect(PI_LOGO.join("\n")).not.toContain("╘");
	});

	it("paints the Diamat mark with the Grafana warm-to-violet palette", () => {
		expect(gradientEscape(0)).toMatch(/\x1b\[(?:38;2;255;136;51|38;5;208)m/);
		expect(gradientEscape(1)).toMatch(/\x1b\[(?:38;2;184;119;217|38;5;141)m/);
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0");
		expect(welcome.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0");
		expect(welcomeSpecial.tip).toBe("Please use nerdfont 😭.");

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("centers the lockup and every tip line in the terminal width", () => {
		const columns = 140;
		const rows = new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row).trimEnd());
		const indent = (row: string) => visibleWidth(row) - visibleWidth(row.trimStart());
		const expectCentered = (left: number, right: number) => expect(Math.abs(left - right)).toBeLessThanOrEqual(1);

		// The lockup is one block: the logo's top row starts it, the wordmark row ends it.
		const bar = rows.find(row => row.includes(PI_LOGO[0]!.trim())) ?? "";
		expect(bar).not.toBe("");
		const word = rows.find(row => row.includes("▄▀▀▄")) ?? "";
		// The mark's own leading blanks belong to the block, so the left edge is measured from them.
		const logoLead = PI_LOGO[0]!.length - PI_LOGO[0]!.trimStart().length;
		expectCentered(indent(bar) - logoLead, columns - visibleWidth(word));

		// Each tip line centers on its own.
		const below = rows.slice(rows.findIndex(row => row.includes("Tip: "))).filter(row => row.length > 0);
		expect(below.length).toBeGreaterThanOrEqual(1);
		for (const row of below) expectCentered(indent(row), columns - visibleWidth(row));
	});

	it("drops the tip below 50 columns", () => {
		const text = (columns: number) => Bun.stripANSI(new WelcomeComponent("1.0.0").render(columns).join("\n"));
		expect(text(50)).toContain("Tip: ");
		expect(text(49)).not.toContain("Tip: ");
		expect(text(49)).toContain("v1.0.0");
	});

	it("sets the version under the wordmark while the lockup fits, else keeps the logo alone", () => {
		const rows = (columns: number) => new WelcomeComponent("1.0.0").render(columns).map(row => Bun.stripANSI(row));

		// The lockup needs the logo, a 4-column gap and the 15-column wordmark inside the 2-column
		// margin. The logo width is read from the mark itself so a redesign moves the boundary
		// with it instead of silently invalidating the test.
		const logoWidth = Math.max(...PI_LOGO.map(row => row.length));
		const logoTop = PI_LOGO[0]!.trim();
		const fitsAt = logoWidth + 4 + 15 + 2;
		const fits = rows(fitsAt);
		const word = fits.find(row => row.includes("▄▀▀▄"));
		const version = fits.find(row => row.includes("v1.0.0"));
		expect(fits.some(row => row.includes(logoTop))).toBe(true);
		expect(version?.indexOf("v1.0.0")).toBe(word?.indexOf("▄▀▀▄"));

		const narrow = rows(fitsAt - 1).join("\n");
		expect(narrow).toContain(logoTop);
		expect(narrow).not.toContain("▄▀▀▄");
		expect(narrow).not.toContain("v1.0.0");
	});
});
