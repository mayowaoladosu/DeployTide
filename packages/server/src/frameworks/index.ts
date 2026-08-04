import {
	nodeFrameworkDetector,
	nodeServerDetector,
	staticSiteDetector,
} from "./detectors/node";
import {
	dockerfileDetector,
	dotnetDetector,
	goDetector,
	javaDetector,
	phpDetector,
	pythonDetector,
	rubyDetector,
} from "./detectors/other";
import type { FrameworkDetectionResult, FrameworkDetector, RepositoryEvidence } from "./types";

/**
 * Detector priority: an explicit Dockerfile always wins first. After that,
 * detectors are ordered from most to least specific evidence so a framework
 * match is preferred over its own generic language/runtime fallback.
 */
const registry: FrameworkDetector[] = [
	dockerfileDetector,
	nodeFrameworkDetector,
	pythonDetector,
	goDetector,
	rubyDetector,
	phpDetector,
	javaDetector,
	dotnetDetector,
	nodeServerDetector,
	staticSiteDetector,
];

export const DETECTOR_REGISTRY_VERSION = "2026.08.1";

const fallbackResult = (): FrameworkDetectionResult => ({
	preset: "unknown",
	label: "Unrecognized project",
	confidence: 0,
	buildType: "railpack",
	packageManager: "unknown",
	evidence: [],
	warnings: [
		"No supported framework or Dockerfile was detected. Railpack will attempt a generic build; configure build/start commands manually if it fails.",
	],
});

/**
 * Run every registered detector against the given evidence and return the
 * highest-confidence match, or a safe Railpack-fallback result when nothing
 * matches. Detectors never throw; a detector that cannot decide returns null.
 */
export const detectFramework = (
	evidence: RepositoryEvidence,
): FrameworkDetectionResult => {
	let best: FrameworkDetectionResult | null = null;
	for (const detector of registry) {
		let candidate: FrameworkDetectionResult | null;
		try {
			candidate = detector.detect(evidence);
		} catch {
			candidate = null;
		}
		if (!candidate) continue;
		if (!best || candidate.confidence > best.confidence) {
			best = candidate;
		}
		// A Dockerfile is authoritative; no other detector can outrank it.
		if (candidate.confidence >= 1) break;
	}
	return best ?? fallbackResult();
};

export type {
	DetectedBuildType,
	DetectedPackageManager,
	FrameworkDetectionResult,
	FrameworkDetector,
	RepositoryEvidence,
} from "./types";
export { buildRepositoryEvidenceFromGithub } from "./github-evidence";
export { findMonorepoRootCandidates, scopeEvidenceToRoot } from "./monorepo";
