/**
 * Pure, provider-agnostic framework detection contracts.
 *
 * A `RepositoryEvidence` is a normalized, bounded snapshot of a repository
 * (or a monorepo root within one): the set of relative file paths present,
 * plus the text contents of a small number of manifest files a detector
 * asked to read. Detectors never perform I/O themselves; the caller (e.g.
 * the GitHub tree adapter) is responsible for producing this evidence
 * within its own size/time/rate-limit budget.
 */
export interface RepositoryEvidence {
	/** Relative POSIX paths of every file discovered under the scanned root, bounded by the caller. */
	files: ReadonlySet<string>;
	/** Text contents of manifest files the caller chose to read, keyed by relative path. */
	manifests: ReadonlyMap<string, string>;
}

export type DetectedPackageManager =
	| "npm"
	| "pnpm"
	| "yarn"
	| "bun"
	| "pip"
	| "pipenv"
	| "uv"
	| "poetry"
	| "bundler"
	| "composer"
	| "maven"
	| "gradle"
	| "go"
	| "dotnet"
	| "unknown";

export type DetectedBuildType =
	| "dockerfile"
	| "railpack"
	| "nixpacks"
	| "static";

export interface DetectionEvidenceEntry {
	/** Short human-readable justification, e.g. "found next.config.js". */
	message: string;
}

export interface FrameworkDetectionResult {
	/** Stable machine identifier of the detected preset, e.g. "nextjs". */
	preset: string;
	/** Human-readable display name, e.g. "Next.js". */
	label: string;
	/** 0-1 confidence score; higher wins when multiple detectors match. */
	confidence: number;
	/** Suggested application buildType for the applications table. */
	buildType: DetectedBuildType;
	packageManager: DetectedPackageManager;
	/** Suggested install command, if applicable (Node/Python/Ruby/etc). */
	installCommand?: string;
	/** Suggested build command, if applicable. */
	buildCommand?: string;
	/** Suggested start/run command, if applicable. */
	startCommand?: string;
	/** Suggested static output directory relative to the detected root, if applicable. */
	outputDirectory?: string;
	/** Suggested container port, when determinable from evidence. */
	port?: number;
	evidence: DetectionEvidenceEntry[];
	warnings: string[];
}

export interface FrameworkDetector {
	/** Stable identifier, used for ordering/debugging. Not shown to users. */
	id: string;
	/**
	 * Attempt to match this detector against the given evidence.
	 * Returns null when the detector's required evidence is absent.
	 */
	detect(evidence: RepositoryEvidence): FrameworkDetectionResult | null;
}
