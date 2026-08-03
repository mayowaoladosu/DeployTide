import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const routeFiles = ["server", "ssh-key", "docker", "cluster", "swarm"] as const;

const source = (route: (typeof routeFiles)[number]) =>
	readFile(
		new URL(`../../server/api/routers/${route}.ts`, import.meta.url),
		"utf8",
	);

describe("legacy infrastructure compatibility route matrix", () => {
	it.each(routeFiles)(
		"keeps %s routes behind operatorProcedure",
		async (route) => {
			const routeSource = await source(route);
			expect(routeSource).toContain("operatorProcedure");
			expect(routeSource).not.toMatch(
				/import\s*\{[^}]*\b(?:publicProcedure|protectedProcedure|adminProcedure)\b/,
			);
		},
	);

	it.each(["server", "ssh-key", "docker", "cluster"] as const)(
		"records %s mutations in the operator ledger",
		async (route) => {
			const routeSource = await source(route);
			expect(routeSource).toContain("recordOperatorAudit");
		},
	);

	it("filters every server list variant to operator-owned rows", async () => {
		const serverSource = await source("server");
		for (const procedure of [
			"all",
			"allForPermissions",
			"count",
			"withSSHKey",
			"buildServers",
		]) {
			expect(serverSource).toContain(`${procedure}: operatorProcedure`);
		}
		expect(
			serverSource.match(/eq\(server\.operatorOwned, true\)/g)?.length,
		).toBeGreaterThanOrEqual(5);
	});

	it("never selects or returns an SSH private key", async () => {
		const sshSource = await source("ssh-key");
		expect(sshSource).not.toContain("privateKey: true");
		expect(sshSource).toContain('privateKey: ""');
	});
});
