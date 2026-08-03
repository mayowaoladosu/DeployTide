import { toProductSlug } from "@dokploy/server/services/product-slugs";
import { describe, expect, it } from "vitest";

describe("product slugs", () => {
	it.each([
		["Acme Storefront", "acme-storefront"],
		["  Ship / Preview  ", "ship-preview"],
		["Café API", "cafe-api"],
		["---", "project"],
	])("normalizes %s", (input, expected) => {
		expect(toProductSlug(input)).toBe(expected);
	});

	it("keeps route segments bounded", () => {
		expect(toProductSlug("a".repeat(100))).toHaveLength(54);
	});
});