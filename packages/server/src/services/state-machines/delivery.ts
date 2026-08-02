export const deploymentTransitions = {
	queued: ["preparing", "cancelled"],
	preparing: ["building", "deploying", "failed", "cancelling"],
	building: ["deploying", "failed", "cancelling"],
	deploying: ["checking", "failed", "cancelling"],
	checking: ["ready", "failed", "cancelling"],
	cancelling: ["cancelled", "failed"],
	ready: [],
	failed: [],
	cancelled: [],
} as const;

export const buildTransitions = {
	queued: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
} as const;

export const releaseTransitions = {
	queued: ["deploying", "cancelled"],
	deploying: ["checking", "failed", "cancelled"],
	checking: ["ready", "failed", "cancelled"],
	ready: ["retired"],
	failed: [],
	cancelled: [],
	retired: [],
} as const;

export const operationTransitions = {
	pending: ["running", "cancelled"],
	running: ["succeeded", "failed", "cancelled"],
	succeeded: [],
	failed: [],
	cancelled: [],
} as const;

export const aliasTransitions = {
	pending: ["ready", "error", "disabled"],
	ready: ["pending", "disabled"],
	error: ["pending", "disabled"],
	disabled: ["pending"],
} as const;

export type DeploymentState = keyof typeof deploymentTransitions;
export type BuildState = keyof typeof buildTransitions;
export type ReleaseState = keyof typeof releaseTransitions;
export type OperationState = keyof typeof operationTransitions;
export type AliasState = keyof typeof aliasTransitions;

export const legacyDeploymentState = {
	running: "deploying",
	done: "ready",
	error: "failed",
	cancelled: "cancelled",
} as const satisfies Record<string, DeploymentState>;

type TransitionMap = Record<string, readonly string[]>;

export class InvalidStateTransitionError extends Error {
	constructor(
		readonly machine: string,
		readonly current: string,
		readonly next: string,
	) {
		super(`Invalid ${machine} transition: ${current} -> ${next}`);
		this.name = "InvalidStateTransitionError";
	}
}

export const assertStateTransition = <TMap extends TransitionMap>(
	machine: string,
	transitions: TMap,
	current: keyof TMap & string,
	next: string,
): void => {
	if (!transitions[current]?.includes(next)) {
		throw new InvalidStateTransitionError(machine, current, next);
	}
};

export const isTerminalState = <TMap extends TransitionMap>(
	transitions: TMap,
	state: keyof TMap & string,
): boolean => transitions[state]?.length === 0;

export const normalizeDeploymentState = (
	state: DeploymentState | keyof typeof legacyDeploymentState,
): DeploymentState =>
	state in legacyDeploymentState
		? legacyDeploymentState[state as keyof typeof legacyDeploymentState]
		: (state as DeploymentState);
