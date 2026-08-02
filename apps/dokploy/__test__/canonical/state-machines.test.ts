import {
	aliasTransitions,
	assertStateTransition,
	buildTransitions,
	deploymentTransitions,
	InvalidStateTransitionError,
	isTerminalState,
	normalizeDeploymentState,
	operationTransitions,
	releaseTransitions,
} from "@dokploy/server/services/state-machines/delivery";
import { describe, expect, it } from "vitest";

describe("canonical delivery state machines", () => {
	it("accepts the production deployment happy path", () => {
		const path = [
			"queued",
			"preparing",
			"building",
			"deploying",
			"checking",
			"ready",
		] as const;
		for (let index = 0; index < path.length - 1; index++) {
			assertStateTransition(
				"deployment",
				deploymentTransitions,
				path[index]!,
				path[index + 1]!,
			);
		}
	});

	it("rejects skipping health verification", () => {
		expect(() =>
			assertStateTransition(
				"deployment",
				deploymentTransitions,
				"deploying",
				"ready",
			),
		).toThrow(InvalidStateTransitionError);
	});

	it("keeps terminal deployments immutable", () => {
		for (const state of ["ready", "failed", "cancelled"] as const) {
			expect(isTerminalState(deploymentTransitions, state)).toBe(true);
			expect(() =>
				assertStateTransition(
					"deployment",
					deploymentTransitions,
					state,
					"deploying",
				),
			).toThrow();
		}
	});

	it("allows ready releases to retire but never redeploy in place", () => {
		assertStateTransition("release", releaseTransitions, "ready", "retired");
		expect(() =>
			assertStateTransition("release", releaseTransitions, "ready", "deploying"),
		).toThrow();
	});

	it("keeps completed build attempts immutable", () => {
		expect(isTerminalState(buildTransitions, "succeeded")).toBe(true);
		expect(() =>
			assertStateTransition("build", buildTransitions, "succeeded", "running"),
		).toThrow();
	});

	it("requires alias reconciliation before a route becomes ready", () => {
		assertStateTransition("alias", aliasTransitions, "pending", "ready");
		assertStateTransition("alias", aliasTransitions, "ready", "pending");
		expect(() =>
			assertStateTransition("alias", aliasTransitions, "disabled", "ready"),
		).toThrow();
	});

	it("keeps completed operations immutable", () => {
		assertStateTransition("operation", operationTransitions, "pending", "running");
		assertStateTransition("operation", operationTransitions, "running", "succeeded");
		expect(() =>
			assertStateTransition(
				"operation",
				operationTransitions,
				"succeeded",
				"running",
			),
		).toThrow();
	});

	it("normalizes legacy deployment states during dual-read migration", () => {
		expect(normalizeDeploymentState("running")).toBe("deploying");
		expect(normalizeDeploymentState("done")).toBe("ready");
		expect(normalizeDeploymentState("error")).toBe("failed");
		expect(normalizeDeploymentState("cancelled")).toBe("cancelled");
		expect(normalizeDeploymentState("checking")).toBe("checking");
	});
});
