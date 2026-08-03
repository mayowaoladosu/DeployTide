import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Dockerode from "dockerode";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	BuildProvider,
	BuildRequest,
	BuildResult,
} from "../contracts";

export const ROOTLESS_BUILDKIT_IMAGE =
	"moby/buildkit@sha256:0c0ce4929976ace509f7a53878303504b2de8857829aea4932af9f7325a30f51";
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1_000;
export const MIN_BUILD_TIMEOUT_MS = 10_000;
export const MAX_BUILD_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
export const MAX_SECRET_FILES = 32;
export const MAX_SECRET_BYTES = 64 * 1024;
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_SOURCE_FILES = 20_000;
const MAX_SOURCE_ENTRIES = 40_000;
const MAX_SOURCE_PATH_BYTES = 16 * 1024 * 1024;
const MAX_RELATIVE_PATH_BYTES = 4 * 1024;
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_BUILD_ARGS = 128;
const MAX_BUILD_ARG_VALUE_BYTES = 64 * 1024;
const MAX_BUILD_ARG_BYTES = 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 30_000;
const READ_BUFFER_BYTES = 1024 * 1024;
const ROOTLESS_USER = "1000:1000";
const NOFOLLOW_FLAG = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const SOURCE_DIGEST_DOMAIN = Buffer.from(
	"deploytide.source-snapshot.v1\0",
	"utf8",
);
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const imagePattern = /^[a-z0-9][a-z0-9._/-]{0,200}(?::[a-zA-Z0-9._-]{1,128})?$/;
const pinnedImagePattern = /^[a-z0-9][a-z0-9._/-]{0,300}@sha256:[a-f0-9]{64}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

type ContainerHandle = ReturnType<Dockerode["getContainer"]>;
type ContainerInspection = Awaited<ReturnType<ContainerHandle["inspect"]>>;
type BuildComponent =
	| "client"
	| "config-volume"
	| "initializer"
	| "network"
	| "socket-volume"
	| "state-volume"
	| "worker";
type SnapshotEntry = {
	absolutePath: string;
	device: number;
	inode: number;
	kind: "directory" | "file";
	mode: number;
	modifiedAtMs: number;
	pathBytes: Buffer;
	relativePath: string;
	size: number;
};
type SnapshotScan = {
	entries: SnapshotEntry[];
	files: number;
	resolvedRoot: string;
	totalBytes: number;
};
type PreparedSecret = {
	id: string;
	resolvedPath: string;
	size: number;
	stagedPath: string;
};
type PreparedOutputDirectory = {
	gid: number;
	resolvedPath: string;
	uid: number;
};
type ResourceCreationTracker = Set<Promise<unknown>>;

export type SourceSnapshotDigest = {
	digest: string;
	files: number;
	resolvedRoot: string;
	totalBytes: number;
};

class BuildExecutionBoundedError extends Error {
	constructor() {
		super("Build execution exceeded its bounded deadline");
		this.name = "BuildExecutionBoundedError";
	}
}

class BuildKitScrubError extends Error {
	constructor() {
		super("Ephemeral BuildKit worker could not be scrubbed");
		this.name = "BuildKitScrubError";
	}
}

const safeExecutionErrorMessages = new Set([
	"Source snapshot root must be a regular directory",
	"Source snapshot roots cannot traverse symbolic links",
	"Source snapshot escaped its bounded directory",
	"Source snapshots cannot contain symbolic links",
	"Source snapshot contains an invalid relative path",
	"Source snapshot path metadata exceeds worker limits",
	"Source snapshot has too many entries",
	"Source snapshots can contain regular files only",
	"Source snapshot exceeds the worker lease limits",
	"Source snapshot contains ambiguous relative paths",
	"Source snapshot changed during digest verification",
	"Source snapshot digest verification failed",
	"Build output root must be a regular directory",
	"Build output roots cannot traverse symbolic links",
	"Build output root permissions are not restrictive",
	"Build output root must be an empty dedicated directory",
	"Build output must be outside the source snapshot",
	"Build output must be outside secret paths",
	"Build secret count exceeds worker limits",
	"Build secret identifier is invalid",
	"Build secret file exceeds worker limits",
	"Build secret paths cannot traverse symbolic links",
	"Build secrets must be outside the source snapshot",
	"Build secret file is duplicated",
	"Build secret changed during execution",
	"Build argument key is invalid",
	"Build arguments exceed worker limits",
	"BuildKit volume ownership initialization failed",
	"Build output ownership initialization failed",
	"BuildKit worker probe exceeded output limits",
	"Rootless BuildKit worker exited before readiness",
	"Rootless BuildKit worker failed readiness",
	"Rootless BuildKit worker security contract mismatch",
	"Rootless build failed",
	"Build artifact exceeds worker limits",
	"Build artifact escaped its bounded output directory",
	"Build artifact permissions or size are invalid",
	"Build artifact changed during verification",
	"Build execution did not produce a result",
]);

const normalizeExecutionError = (error: unknown) => {
	if (error instanceof Error && safeExecutionErrorMessages.has(error.message)) {
		return error;
	}
	return new Error("Rootless build execution failed");
};

const nodeErrorCode = (error: unknown) =>
	(error as { code?: string }).code ?? "";

const throwIfAborted = (signal: AbortSignal) => {
	if (signal.aborted) throw new BuildExecutionBoundedError();
};

const raceWithAbort = <T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> => {
	if (signal.aborted) {
		operation.catch(() => undefined);
		return Promise.reject(new BuildExecutionBoundedError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () =>
			finish(() => reject(new BuildExecutionBoundedError()));
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
};

const trackResourceCreation = <T>(
	tracker: ResourceCreationTracker,
	operation: Promise<T>,
) => {
	tracker.add(operation);
	void operation.then(
		() => tracker.delete(operation),
		() => tracker.delete(operation),
	);
	return operation;
};

const waitForTrackedResourceCreations = async (
	tracker: ResourceCreationTracker,
	signal: AbortSignal,
) => {
	while (tracker.size > 0) {
		await raceWithAbort(
			Promise.allSettled([...tracker]).then(() => undefined),
			signal,
		);
	}
};

const abortableDelay = (milliseconds: number, signal: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new BuildExecutionBoundedError());
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new BuildExecutionBoundedError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

const createDeadline = (timeoutMs: number, parent?: AbortSignal) => {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (parent?.aborted) abort();
	else parent?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	if (typeof timer === "object") timer.unref();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", abort);
		},
	};
};

const validateTimeout = (timeoutMs: number | undefined) => {
	const resolved = timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(resolved) ||
		resolved < MIN_BUILD_TIMEOUT_MS ||
		resolved > MAX_BUILD_TIMEOUT_MS
	) {
		throw new Error("Build timeout is outside the supported bounds");
	}
	return resolved;
};

const validateMaxSourceBytes = (maxBytes: number | undefined) => {
	const resolved = maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
	if (
		!Number.isSafeInteger(resolved) ||
		resolved <= 0 ||
		resolved > MAX_SOURCE_BYTES
	) {
		throw new Error(
			"Source snapshot byte limit is outside the supported bounds",
		);
	}
	return resolved;
};

const samePath = (left: string, right: string) =>
	path.relative(left, right) === "" && path.relative(right, left) === "";

const isPathWithin = (parent: string, candidate: string) => {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) &&
			relative !== ".." &&
			!path.isAbsolute(relative))
	);
};

const assertDisjointPaths = (left: string, right: string, message: string) => {
	if (isPathWithin(left, right) || isPathWithin(right, left)) {
		throw new Error(message);
	}
};

const normalizeRelativePath = (root: string, candidate: string) =>
	path.relative(root, candidate).split(path.sep).join("/");

const assertNoSymlinkPathComponents = async (
	absolutePath: string,
	signal: AbortSignal,
) => {
	const parsed = path.parse(absolutePath);
	let current = parsed.root;
	const segments = absolutePath
		.slice(parsed.root.length)
		.split(path.sep)
		.filter(Boolean);
	for (const segment of segments) {
		current = path.join(current, segment);
		try {
			const stats = await raceWithAbort(lstat(current), signal);
			if (stats.isSymbolicLink()) {
				throw new Error("Build output roots cannot traverse symbolic links");
			}
		} catch (error) {
			if (nodeErrorCode(error) === "ENOENT") return;
			throw error;
		}
	}
};

const buildLabels = (
	leaseId: string,
	component: BuildComponent,
): Record<string, string> => ({
	"com.deploytide.component": component,
	"com.deploytide.ephemeral": "true",
	"com.deploytide.lease": leaseId,
	"com.deploytide.managed-by": "deploytide",
	"com.deploytide.plane": "build",
});

const scanSourceSnapshot = async (
	root: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<SnapshotScan> => {
	throwIfAborted(signal);
	const requestedRoot = path.resolve(root);
	const rootStats = await raceWithAbort(lstat(requestedRoot), signal);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
		throw new Error("Source snapshot root must be a regular directory");
	}
	const resolvedRoot = await raceWithAbort(realpath(requestedRoot), signal);
	if (!samePath(requestedRoot, resolvedRoot)) {
		throw new Error("Source snapshot roots cannot traverse symbolic links");
	}

	const entries: SnapshotEntry[] = [];
	let files = 0;
	let totalBytes = 0;
	let totalPathBytes = 0;
	const visit = async (directory: string): Promise<void> => {
		throwIfAborted(signal);
		const names = await raceWithAbort(readdir(directory), signal);
		names.sort((left, right) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		);
		for (const name of names) {
			throwIfAborted(signal);
			const candidate = path.resolve(directory, name);
			if (
				!isPathWithin(resolvedRoot, candidate) ||
				samePath(resolvedRoot, candidate)
			) {
				throw new Error("Source snapshot escaped its bounded directory");
			}
			const stats = await raceWithAbort(lstat(candidate), signal);
			if (stats.isSymbolicLink()) {
				throw new Error("Source snapshots cannot contain symbolic links");
			}
			const resolvedCandidate = await raceWithAbort(
				realpath(candidate),
				signal,
			);
			if (!samePath(candidate, resolvedCandidate)) {
				throw new Error("Source snapshots cannot contain symbolic links");
			}
			const relativePath = normalizeRelativePath(resolvedRoot, candidate);
			const pathBytes = Buffer.from(relativePath, "utf8");
			if (
				pathBytes.length === 0 ||
				pathBytes.length > MAX_RELATIVE_PATH_BYTES
			) {
				throw new Error("Source snapshot contains an invalid relative path");
			}
			totalPathBytes += pathBytes.length;
			if (totalPathBytes > MAX_SOURCE_PATH_BYTES) {
				throw new Error("Source snapshot path metadata exceeds worker limits");
			}
			if (stats.isDirectory()) {
				entries.push({
					absolutePath: candidate,
					device: stats.dev,
					inode: stats.ino,
					kind: "directory",
					mode: stats.mode & 0o7777,
					modifiedAtMs: stats.mtimeMs,
					pathBytes,
					relativePath,
					size: 0,
				});
				if (entries.length > MAX_SOURCE_ENTRIES) {
					throw new Error("Source snapshot has too many entries");
				}
				await visit(candidate);
				continue;
			}
			if (!stats.isFile()) {
				throw new Error("Source snapshots can contain regular files only");
			}
			files += 1;
			totalBytes += stats.size;
			if (
				files > MAX_SOURCE_FILES ||
				entries.length >= MAX_SOURCE_ENTRIES ||
				totalBytes > maxBytes
			) {
				throw new Error("Source snapshot exceeds the worker lease limits");
			}
			entries.push({
				absolutePath: candidate,
				device: stats.dev,
				inode: stats.ino,
				kind: "file",
				mode: stats.mode & 0o7777,
				modifiedAtMs: stats.mtimeMs,
				pathBytes,
				relativePath,
				size: stats.size,
			});
		}
	};
	await visit(resolvedRoot);
	entries.sort((left, right) =>
		Buffer.compare(left.pathBytes, right.pathBytes),
	);
	for (let index = 1; index < entries.length; index += 1) {
		if (entries[index - 1]?.relativePath === entries[index]?.relativePath) {
			throw new Error("Source snapshot contains ambiguous relative paths");
		}
	}
	return { entries, files, resolvedRoot, totalBytes };
};

const updateUint32 = (hash: ReturnType<typeof createHash>, value: number) => {
	const frame = Buffer.allocUnsafe(4);
	frame.writeUInt32BE(value);
	hash.update(frame);
};

const updateUint64 = (hash: ReturnType<typeof createHash>, value: number) => {
	const frame = Buffer.allocUnsafe(8);
	frame.writeBigUInt64BE(BigInt(value));
	hash.update(frame);
};

const metadataMatches = (
	entry: SnapshotEntry,
	stats: {
		dev: number;
		ino: number;
		isDirectory(): boolean;
		isFile(): boolean;
		mode: number;
		mtimeMs: number;
		size: number;
	},
) =>
	entry.device === stats.dev &&
	entry.inode === stats.ino &&
	entry.mode === (stats.mode & 0o7777) &&
	entry.modifiedAtMs === stats.mtimeMs &&
	entry.size === (entry.kind === "file" ? stats.size : 0) &&
	(entry.kind === "file" ? stats.isFile() : stats.isDirectory());

const digestFile = async (
	hash: ReturnType<typeof createHash>,
	entry: SnapshotEntry,
	buffer: Buffer,
	signal: AbortSignal,
) => {
	const handle = await raceWithAbort(
		open(entry.absolutePath, constants.O_RDONLY | NOFOLLOW_FLAG),
		signal,
	);
	try {
		const before = await raceWithAbort(handle.stat(), signal);
		if (!metadataMatches(entry, before)) {
			throw new Error("Source snapshot changed during digest verification");
		}
		let position = 0;
		while (position < entry.size) {
			throwIfAborted(signal);
			const length = Math.min(buffer.length, entry.size - position);
			const result = await raceWithAbort(
				handle.read(buffer, 0, length, position),
				signal,
			);
			if (result.bytesRead !== length) {
				throw new Error("Source snapshot changed during digest verification");
			}
			hash.update(buffer.subarray(0, result.bytesRead));
			position += result.bytesRead;
		}
		const after = await raceWithAbort(handle.stat(), signal);
		if (!metadataMatches(entry, after)) {
			throw new Error("Source snapshot changed during digest verification");
		}
	} finally {
		await handle.close();
	}
};

const scansMatch = (before: SnapshotScan, after: SnapshotScan) =>
	before.files === after.files &&
	before.totalBytes === after.totalBytes &&
	before.entries.length === after.entries.length &&
	before.entries.every((entry, index) => {
		const candidate = after.entries[index];
		return (
			candidate !== undefined &&
			entry.relativePath === candidate.relativePath &&
			entry.kind === candidate.kind &&
			entry.mode === candidate.mode &&
			entry.size === candidate.size &&
			entry.device === candidate.device &&
			entry.inode === candidate.inode &&
			entry.modifiedAtMs === candidate.modifiedAtMs
		);
	});

/**
 * Hash framing, in byte-sorted relative POSIX path order:
 * domain || u32(entry count) || repeated(
 *   u8(type: directory=0x44, file=0x46) || u32(path byte length) || path UTF-8 ||
 *   u32(permission mode & 07777) || u64(content size) || exact file bytes
 * ). Directories use a zero content size. Nothing in the staged tree is excluded.
 */
export const computeSourceSnapshotDigest = async (
	root: string,
	maxBytes: number = DEFAULT_MAX_SOURCE_BYTES,
	signal?: AbortSignal,
): Promise<SourceSnapshotDigest> => {
	const boundedMaxBytes = validateMaxSourceBytes(maxBytes);
	const localDeadline = signal
		? null
		: createDeadline(DEFAULT_BUILD_TIMEOUT_MS);
	const activeSignal = signal ?? localDeadline?.signal;
	if (!activeSignal) throw new BuildExecutionBoundedError();
	try {
		const scan = await scanSourceSnapshot(root, boundedMaxBytes, activeSignal);
		const hash = createHash("sha256");
		hash.update(SOURCE_DIGEST_DOMAIN);
		updateUint32(hash, scan.entries.length);
		const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
		for (const entry of scan.entries) {
			throwIfAborted(activeSignal);
			hash.update(
				entry.kind === "directory" ? Buffer.from([0x44]) : Buffer.from([0x46]),
			);
			updateUint32(hash, entry.pathBytes.length);
			hash.update(entry.pathBytes);
			updateUint32(hash, entry.mode);
			updateUint64(hash, entry.size);
			if (entry.kind === "file") {
				await digestFile(hash, entry, buffer, activeSignal);
			}
		}
		const verificationScan = await scanSourceSnapshot(
			scan.resolvedRoot,
			boundedMaxBytes,
			activeSignal,
		);
		if (!scansMatch(scan, verificationScan)) {
			throw new Error("Source snapshot changed during digest verification");
		}
		return {
			digest: `sha256:${hash.digest("hex")}`,
			files: scan.files,
			resolvedRoot: scan.resolvedRoot,
			totalBytes: scan.totalBytes,
		};
	} catch (error) {
		if (nodeErrorCode(error)) {
			throw new Error("Rootless build execution failed");
		}
		throw error;
	} finally {
		localDeadline?.dispose();
	}
};

const prepareBuildArguments = (buildArgs: BuildRequest["buildArgs"]) => {
	const entries = Object.entries(buildArgs ?? {});
	if (entries.length > MAX_BUILD_ARGS) {
		throw new Error("Build arguments exceed worker limits");
	}
	let totalBytes = 0;
	const arguments_: string[] = [];
	for (const [key, value] of entries) {
		if (!identifierPattern.test(key)) {
			throw new Error("Build argument key is invalid");
		}
		const valueBytes = Buffer.byteLength(value, "utf8");
		totalBytes += Buffer.byteLength(key, "utf8") + valueBytes;
		if (
			valueBytes > MAX_BUILD_ARG_VALUE_BYTES ||
			totalBytes > MAX_BUILD_ARG_BYTES
		) {
			throw new Error("Build arguments exceed worker limits");
		}
		arguments_.push("--opt", `build-arg:${key}=${value}`);
	}
	return arguments_;
};

const prepareOutputDirectory = async (
	requestedDirectory: string,
	signal: AbortSignal,
): Promise<PreparedOutputDirectory> => {
	const resolvedDirectory = path.resolve(requestedDirectory);
	await assertNoSymlinkPathComponents(resolvedDirectory, signal);
	try {
		const existing = await raceWithAbort(lstat(resolvedDirectory), signal);
		if (existing.isSymbolicLink() || !existing.isDirectory()) {
			throw new Error("Build output root must be a regular directory");
		}
	} catch (error) {
		if (nodeErrorCode(error) !== "ENOENT") throw error;
		await raceWithAbort(
			mkdir(resolvedDirectory, { mode: 0o700, recursive: true }),
			signal,
		);
	}
	const beforeMode = await raceWithAbort(lstat(resolvedDirectory), signal);
	if (beforeMode.isSymbolicLink() || !beforeMode.isDirectory()) {
		throw new Error("Build output root must be a regular directory");
	}
	const resolvedRealPath = await raceWithAbort(
		realpath(resolvedDirectory),
		signal,
	);
	if (!samePath(resolvedDirectory, resolvedRealPath)) {
		throw new Error("Build output roots cannot traverse symbolic links");
	}
	if ((await raceWithAbort(readdir(resolvedRealPath), signal)).length !== 0) {
		throw new Error("Build output root must be an empty dedicated directory");
	}
	try {
		await raceWithAbort(chmod(resolvedDirectory, 0o700), signal);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
	const afterMode = await raceWithAbort(lstat(resolvedRealPath), signal);
	if (process.platform !== "win32" && (afterMode.mode & 0o777) !== 0o700) {
		throw new Error("Build output root permissions are not restrictive");
	}
	return {
		gid: afterMode.gid,
		resolvedPath: resolvedRealPath,
		uid: afterMode.uid,
	};
};

const prepareSecretFiles = async (
	secrets: BuildRequest["secretFiles"],
	sourceRoot: string,
	signal: AbortSignal,
): Promise<{ secrets: PreparedSecret[]; stagingDir: string | undefined }> => {
	if ((secrets?.length ?? 0) > MAX_SECRET_FILES) {
		throw new Error("Build secret count exceeds worker limits");
	}
	if ((secrets?.length ?? 0) === 0) {
		return { secrets: [], stagingDir: undefined };
	}
	// Secrets are staged into a directory this process fully owns rather than
	// bind-mounted directly from their original host path. The rootless build
	// client always runs as a fixed, unprivileged uid (1000) that has no
	// relationship to the calling process's uid, so the original file's mode
	// and ownership cannot be relied on for readability inside the container.
	// Each staged copy is deleted once the build finishes.
	const stagingDir = await raceWithAbort(
		mkdtemp(path.join(tmpdir(), "dt-buildkit-secrets-")),
		signal,
	);
	await raceWithAbort(chmod(stagingDir, 0o700), signal);
	const prepared: PreparedSecret[] = [];
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const secret of secrets ?? []) {
		throwIfAborted(signal);
		if (!identifierPattern.test(secret.id) || ids.has(secret.id)) {
			throw new Error("Build secret identifier is invalid");
		}
		const requestedPath = path.resolve(secret.path);
		const stats = await raceWithAbort(lstat(requestedPath), signal);
		if (
			stats.isSymbolicLink() ||
			!stats.isFile() ||
			stats.size > MAX_SECRET_BYTES
		) {
			throw new Error("Build secret file exceeds worker limits");
		}
		const resolvedPath = await raceWithAbort(realpath(requestedPath), signal);
		if (!samePath(requestedPath, resolvedPath)) {
			throw new Error("Build secret paths cannot traverse symbolic links");
		}
		assertDisjointPaths(
			sourceRoot,
			resolvedPath,
			"Build secrets must be outside the source snapshot",
		);
		const pathKey =
			process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
		if (paths.has(pathKey)) {
			throw new Error("Build secret file is duplicated");
		}
		ids.add(secret.id);
		paths.add(pathKey);
		const content = await raceWithAbort(readFile(resolvedPath), signal);
		const stagedPath = path.join(stagingDir, secret.id);
		await raceWithAbort(writeFile(stagedPath, content, { mode: 0o400 }), signal);
		// Readable by any uid: the copy lives inside a 0700 staging directory
		// that only this process (and root) can traverse, so broadening the
		// file's own read bit does not expose it outside the ephemeral build.
		await raceWithAbort(chmod(stagedPath, 0o444), signal);
		prepared.push({
			id: secret.id,
			resolvedPath,
			size: stats.size,
			stagedPath,
		});
	}
	return { secrets: prepared, stagingDir };
};

const pullImage = async (
	docker: Dockerode,
	image: string,
	signal: AbortSignal,
) => {
	try {
		await raceWithAbort(docker.getImage(image).inspect(), signal);
		return;
	} catch (error) {
		const statusCode = (error as { statusCode?: number }).statusCode;
		if (
			error instanceof BuildExecutionBoundedError ||
			signal.aborted ||
			(statusCode !== undefined && statusCode !== 404)
		) {
			throw error;
		}
	}
	const stream = await raceWithAbort(docker.pull(image), signal);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => {
			if ("destroy" in stream && typeof stream.destroy === "function") {
				stream.destroy();
			}
			finish(() => reject(new BuildExecutionBoundedError()));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		docker.modem.followProgress(stream, (error) =>
			finish(() => (error ? reject(error) : resolve())),
		);
	});
};

const prepareVolumeOwnership = async (input: {
	docker: Dockerode;
	image: string;
	leaseId: string;
	name: string;
	resourceCreations: ResourceCreationTracker;
	signal: AbortSignal;
	volume: string;
}) => {
	await removeOwnedContainer(
		input.docker,
		input.name,
		buildLabels(input.leaseId, "initializer"),
		input.signal,
	);
	const initializer = await raceWithAbort(
		trackResourceCreation(
			input.resourceCreations,
			input.docker.createContainer({
				Image: input.image,
				name: input.name,
				User: "0:0",
				Entrypoint: ["chown"],
				Cmd: ["-R", "1000:1000", "/volume"],
				Labels: buildLabels(input.leaseId, "initializer"),
				HostConfig: {
					AutoRemove: false,
					Binds: [`${input.volume}:/volume:rw`],
					CapDrop: ["ALL"],
					CapAdd: ["CHOWN", "DAC_OVERRIDE"],
					Devices: [],
					DeviceRequests: [],
					Memory: 128 * 1024 * 1024,
					NanoCpus: 500_000_000,
					NetworkMode: "none",
					OomKillDisable: false,
					PidsLimit: 32,
					PortBindings: {},
					Privileged: false,
					ReadonlyRootfs: true,
					SecurityOpt: ["no-new-privileges"],
					Tmpfs: {
						"/home/user/.local/share/buildkit":
							"rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000",
					},
				},
			}),
		),
		input.signal,
	);
	try {
		await raceWithAbort(initializer.start(), input.signal);
		const result = await raceWithAbort(initializer.wait(), input.signal);
		if (result.StatusCode !== 0) {
			throw new Error("BuildKit volume ownership initialization failed");
		}
	} finally {
		await removeOwnedContainer(
			input.docker,
			input.name,
			buildLabels(input.leaseId, "initializer"),
			input.signal,
		);
	}
};

const changeOutputOwnership = async (input: {
	directory: string;
	docker: Dockerode;
	image: string;
	leaseId: string;
	name: string;
	owner: string;
	recursive: boolean;
	resourceCreations: ResourceCreationTracker;
	signal: AbortSignal;
}) => {
	await removeOwnedContainer(
		input.docker,
		input.name,
		buildLabels(input.leaseId, "initializer"),
		input.signal,
	);
	const initializer = await raceWithAbort(
		trackResourceCreation(
			input.resourceCreations,
			input.docker.createContainer({
				Image: input.image,
				name: input.name,
				User: "0:0",
				Entrypoint: ["chown"],
				Cmd: input.recursive
					? ["-R", input.owner, "/output"]
					: [input.owner, "/output"],
				Labels: buildLabels(input.leaseId, "initializer"),
				HostConfig: {
					AutoRemove: false,
					Binds: [`${input.directory}:/output:rw`],
					CapDrop: ["ALL"],
					CapAdd: ["CHOWN", "DAC_OVERRIDE"],
					Devices: [],
					DeviceRequests: [],
					Memory: 128 * 1024 * 1024,
					NanoCpus: 500_000_000,
					NetworkMode: "none",
					OomKillDisable: false,
					PidsLimit: 32,
					PortBindings: {},
					Privileged: false,
					ReadonlyRootfs: true,
					SecurityOpt: ["no-new-privileges"],
					Tmpfs: {
						"/home/user/.local/share/buildkit":
							"rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000",
					},
				},
			}),
		),
		input.signal,
	);
	try {
		await raceWithAbort(initializer.start(), input.signal);
		const result = await raceWithAbort(initializer.wait(), input.signal);
		if (result.StatusCode !== 0) {
			throw new Error("Build output ownership initialization failed");
		}
	} finally {
		await removeOwnedContainer(
			input.docker,
			input.name,
			buildLabels(input.leaseId, "initializer"),
			input.signal,
		);
	}
};

const collectBoundedStream = async (
	stream: NodeJS.ReadableStream,
	maxBytes: number,
	signal: AbortSignal,
) => {
	const iterator = stream[Symbol.asyncIterator]();
	let totalBytes = 0;
	try {
		while (true) {
			const next = await raceWithAbort(iterator.next(), signal);
			if (next.done) return;
			totalBytes += Buffer.from(next.value as Uint8Array).length;
			if (totalBytes > maxBytes) {
				throw new Error("BuildKit worker probe exceeded output limits");
			}
		}
	} catch (error) {
		if ("destroy" in stream && typeof stream.destroy === "function") {
			stream.destroy();
		}
		throw error;
	}
};

const waitForWorker = async (
	docker: Dockerode,
	workerName: string,
	signal: AbortSignal,
) => {
	const worker = docker.getContainer(workerName);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		throwIfAborted(signal);
		try {
			const exec = await raceWithAbort(
				worker.exec({
					AttachStderr: true,
					AttachStdout: true,
					Cmd: [
						"buildctl",
						"--addr",
						"unix:///run/buildkit/buildkitd.sock",
						"debug",
						"workers",
					],
				}),
				signal,
			);
			const stream = await raceWithAbort(
				exec.start({ hijack: true, stdin: false }),
				signal,
			);
			await collectBoundedStream(stream, MAX_PROBE_BYTES, signal);
			const inspected = await raceWithAbort(exec.inspect(), signal);
			if (inspected.ExitCode === 0) return;
		} catch (error) {
			if (error instanceof BuildExecutionBoundedError || signal.aborted) {
				throw new BuildExecutionBoundedError();
			}
			try {
				const inspected = await raceWithAbort(worker.inspect(), signal);
				if (!inspected.State.Running) {
					throw new Error("Rootless BuildKit worker exited before readiness");
				}
			} catch (inspectionError) {
				if (
					inspectionError instanceof Error &&
					inspectionError.message ===
						"Rootless BuildKit worker exited before readiness"
				) {
					throw inspectionError;
				}
			}
		}
		await abortableDelay(250, signal);
	}
	throw new Error("Rootless BuildKit worker failed readiness");
};

const sorted = (values: string[] | null | undefined) =>
	[...(values ?? [])].sort();

const isEmptyRecord = (value: unknown) =>
	value === null ||
	value === undefined ||
	(typeof value === "object" && Object.keys(value).length === 0);

const hasExactWorkerSecurityOptions = (
	options: string[] | null | undefined,
) => {
	const normalized = sorted(options);
	return (
		JSON.stringify(normalized) ===
			JSON.stringify(["apparmor=unconfined", "seccomp=unconfined"]) ||
		JSON.stringify(normalized) ===
			JSON.stringify([
				"apparmor=unconfined",
				"label=disable",
				"seccomp=unconfined",
			])
	);
};

const exactDeployTideLabels = (
	labels: Record<string, string> | null | undefined,
	expected: Record<string, string>,
) => {
	const actualEntries = Object.entries(labels ?? {})
		.filter(([key]) => key.startsWith("com.deploytide."))
		.sort(([left], [right]) => left.localeCompare(right));
	const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
};

const resourceOwnershipError = () =>
	new Error("Ephemeral BuildKit resource ownership mismatch");

const inspectOwnedContainer = async (
	docker: Dockerode,
	name: string,
	expectedLabels: Record<string, string>,
	signal: AbortSignal,
) => {
	const container = docker.getContainer(name);
	try {
		const inspection = await raceWithAbort(container.inspect(), signal);
		if (!exactDeployTideLabels(inspection.Config.Labels, expectedLabels)) {
			throw resourceOwnershipError();
		}
		return container;
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode === 404) return null;
		throw error;
	}
};

const removeOwnedContainer = async (
	docker: Dockerode,
	name: string,
	expectedLabels: Record<string, string>,
	signal: AbortSignal,
) => {
	const container = await inspectOwnedContainer(
		docker,
		name,
		expectedLabels,
		signal,
	);
	if (!container) return;
	await raceWithAbort(container.remove({ force: true, v: true }), signal);
	try {
		await raceWithAbort(container.inspect(), signal);
		throw resourceOwnershipError();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
	}
};

const inspectOwnedNetwork = async (
	docker: Dockerode,
	name: string,
	expectedLabels: Record<string, string>,
	signal: AbortSignal,
) => {
	const network = docker.getNetwork(name);
	try {
		const inspection = await raceWithAbort(network.inspect(), signal);
		if (!exactDeployTideLabels(inspection.Labels, expectedLabels)) {
			throw resourceOwnershipError();
		}
		return { inspection, network };
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode === 404) return null;
		throw error;
	}
};

const assertNetworkSecurityContract = async (
	docker: Dockerode,
	name: string,
	leaseId: string,
	signal: AbortSignal,
) => {
	const owned = await inspectOwnedNetwork(
		docker,
		name,
		buildLabels(leaseId, "network"),
		signal,
	);
	const inspection = owned?.inspection;
	if (
		!inspection ||
		inspection.Driver !== "bridge" ||
		inspection.Scope !== "local" ||
		inspection.Internal ||
		inspection.Attachable ||
		inspection.Ingress ||
		inspection.Options?.["com.docker.network.bridge.enable_icc"] !== "false" ||
		inspection.Options?.["com.docker.network.bridge.host_binding_ipv4"] !==
			"127.0.0.1"
	) {
		throw resourceOwnershipError();
	}
};

const removeOwnedNetwork = async (
	docker: Dockerode,
	name: string,
	leaseId: string,
	signal: AbortSignal,
) => {
	const owned = await inspectOwnedNetwork(
		docker,
		name,
		buildLabels(leaseId, "network"),
		signal,
	);
	if (!owned) return;
	await raceWithAbort(owned.network.remove(), signal);
	try {
		await raceWithAbort(owned.network.inspect(), signal);
		throw resourceOwnershipError();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
	}
};

type VolumeComponent = "config-volume" | "socket-volume" | "state-volume";

const inspectOwnedVolume = async (
	docker: Dockerode,
	name: string,
	expectedLabels: Record<string, string>,
	signal: AbortSignal,
) => {
	const volume = docker.getVolume(name);
	try {
		const inspection = await raceWithAbort(volume.inspect(), signal);
		if (!exactDeployTideLabels(inspection.Labels, expectedLabels)) {
			throw resourceOwnershipError();
		}
		return volume;
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode === 404) return null;
		throw error;
	}
};

const assertVolumeOwnership = async (
	docker: Dockerode,
	name: string,
	leaseId: string,
	component: VolumeComponent,
	signal: AbortSignal,
) => {
	if (
		!(await inspectOwnedVolume(
			docker,
			name,
			buildLabels(leaseId, component),
			signal,
		))
	) {
		throw resourceOwnershipError();
	}
};

const removeOwnedVolume = async (
	docker: Dockerode,
	name: string,
	leaseId: string,
	component: VolumeComponent,
	signal: AbortSignal,
) => {
	const volume = await inspectOwnedVolume(
		docker,
		name,
		buildLabels(leaseId, component),
		signal,
	);
	if (!volume) return;
	await raceWithAbort(volume.remove({ force: true }), signal);
	try {
		await raceWithAbort(volume.inspect(), signal);
		throw resourceOwnershipError();
	} catch (error) {
		if ((error as { statusCode?: number }).statusCode !== 404) throw error;
	}
};

const assertWorkerSecurityContract = (
	inspection: ContainerInspection,
	input: {
		configVolume: string;
		image: string;
		leaseId: string;
		networkName: string;
		socketVolume: string;
		stateVolume: string;
	},
) => {
	const expectedBinds = [
		`${input.configVolume}:/home/user/.docker:rw`,
		`${input.socketVolume}:/run/buildkit:rw`,
		`${input.stateVolume}:/home/user/.local/share/buildkit:rw`,
	].sort();
	const expectedMounts: Array<[string, string]> = [
		[input.configVolume, "/home/user/.docker"] as [string, string],
		[input.socketVolume, "/run/buildkit"] as [string, string],
		[input.stateVolume, "/home/user/.local/share/buildkit"] as [string, string],
	].sort((left, right) => left[1].localeCompare(right[1]));
	const actualMounts = (inspection.Mounts ?? [])
		.map((mount): [string, string, string, string] => {
			const typedMount = mount as typeof mount & { Type?: string };
			return [
				mount.Name ?? "",
				mount.Destination,
				typedMount.Type ?? "",
				String(mount.RW),
			];
		})
		.sort((left, right) => left[1].localeCompare(right[1]));
	const mountContractMatches =
		actualMounts.length === expectedMounts.length &&
		actualMounts.every(
			(mount, index) =>
				mount[0] === expectedMounts[index]?.[0] &&
				mount[1] === expectedMounts[index]?.[1] &&
				mount[2] === "volume" &&
				mount[3] === "true",
		);
	const networkNames = Object.keys(
		inspection.NetworkSettings.Networks ?? {},
	).sort();
	const hostConfig = inspection.HostConfig;
	const expectedCommand = [
		"--addr",
		"unix:///run/buildkit/buildkitd.sock",
		"--oci-worker-no-process-sandbox",
		"--root",
		"/home/user/.local/share/buildkit",
	];
	const expectedTmpfs = {
		"/run/user/1000": "rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
		"/tmp": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
	};
	const valid =
		inspection.Config.Image === input.image &&
		inspection.Config.User === ROOTLESS_USER &&
		JSON.stringify(inspection.Config.Cmd ?? []) ===
			JSON.stringify(expectedCommand) &&
		exactDeployTideLabels(
			inspection.Config.Labels,
			buildLabels(input.leaseId, "worker"),
		) &&
		hostConfig.AutoRemove === false &&
		hostConfig.Privileged === true &&
		hostConfig.ReadonlyRootfs === false &&
		hostConfig.NetworkMode === input.networkName &&
		hostConfig.PidsLimit === 1024 &&
		hostConfig.Memory === 4 * 1024 * 1024 * 1024 &&
		hostConfig.NanoCpus === 4_000_000_000 &&
		hostConfig.OomKillDisable !== true &&
		["", "no"].includes(hostConfig.RestartPolicy?.Name ?? "") &&
		(hostConfig.RestartPolicy?.MaximumRetryCount ?? 0) === 0 &&
		["", "private"].includes(hostConfig.PidMode ?? "") &&
		hostConfig.IpcMode === "private" &&
		["", "private"].includes(hostConfig.UTSMode ?? "") &&
		hostConfig.PublishAllPorts === false &&
		JSON.stringify(Object.entries(hostConfig.Tmpfs ?? {}).sort()) ===
			JSON.stringify(Object.entries(expectedTmpfs).sort()) &&
		JSON.stringify(sorted(hostConfig.Binds)) ===
			JSON.stringify(expectedBinds) &&
		JSON.stringify(sorted(hostConfig.CapAdd)) === JSON.stringify([]) &&
		JSON.stringify(sorted(hostConfig.CapDrop)) === JSON.stringify([]) &&
		hasExactWorkerSecurityOptions(hostConfig.SecurityOpt) &&
		isEmptyRecord(hostConfig.PortBindings) &&
		(hostConfig.Devices?.length ?? 0) === 0 &&
		(hostConfig.DeviceRequests?.length ?? 0) === 0 &&
		isEmptyRecord(inspection.NetworkSettings.Ports) &&
		["", "unconfined"].includes(inspection.AppArmorProfile ?? "") &&
		inspection.State.Running === true &&
		JSON.stringify(networkNames) === JSON.stringify([input.networkName]) &&
		mountContractMatches;
	if (!valid) {
		throw new Error("Rootless BuildKit worker security contract mismatch");
	}
};

const verifyArtifact = async (
	artifactPath: string,
	outputDirectory: string,
	signal: AbortSignal,
) => {
	const before = await raceWithAbort(lstat(artifactPath), signal);
	if (
		before.isSymbolicLink() ||
		!before.isFile() ||
		before.nlink !== 1 ||
		before.size <= 0 ||
		before.size > MAX_ARTIFACT_BYTES
	) {
		throw new Error("Build artifact exceeds worker limits");
	}
	const resolvedArtifact = await raceWithAbort(realpath(artifactPath), signal);
	if (
		!samePath(artifactPath, resolvedArtifact) ||
		!isPathWithin(outputDirectory, resolvedArtifact) ||
		samePath(outputDirectory, resolvedArtifact)
	) {
		throw new Error("Build artifact escaped its bounded output directory");
	}
	try {
		await raceWithAbort(chmod(resolvedArtifact, 0o600), signal);
	} catch (error) {
		if (process.platform !== "win32") throw error;
	}
	const handle = await raceWithAbort(
		open(resolvedArtifact, constants.O_RDONLY | NOFOLLOW_FLAG),
		signal,
	);
	try {
		const secured = await raceWithAbort(handle.stat(), signal);
		if (
			!secured.isFile() ||
			secured.size !== before.size ||
			secured.size > MAX_ARTIFACT_BYTES ||
			(process.platform !== "win32" && (secured.mode & 0o777) !== 0o600)
		) {
			throw new Error("Build artifact permissions or size are invalid");
		}
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
		let position = 0;
		while (position < secured.size) {
			throwIfAborted(signal);
			const length = Math.min(buffer.length, secured.size - position);
			const result = await raceWithAbort(
				handle.read(buffer, 0, length, position),
				signal,
			);
			if (result.bytesRead !== length) {
				throw new Error("Build artifact changed during verification");
			}
			hash.update(buffer.subarray(0, result.bytesRead));
			position += result.bytesRead;
		}
		const after = await raceWithAbort(handle.stat(), signal);
		if (
			after.size !== secured.size ||
			after.mtimeMs !== secured.mtimeMs ||
			after.ino !== secured.ino ||
			after.dev !== secured.dev
		) {
			throw new Error("Build artifact changed during verification");
		}
		return `sha256:${hash.digest("hex")}`;
	} finally {
		await handle.close();
	}
};

const removeArtifactResidue = async (artifactPath: string) => {
	const cleanupDeadline = createDeadline(CLEANUP_TIMEOUT_MS);
	try {
		await raceWithAbort(
			rm(artifactPath, { force: true }),
			cleanupDeadline.signal,
		);
	} finally {
		cleanupDeadline.dispose();
	}
};

const cleanupBuildResources = async (input: {
	artifactPath: string;
	buildSucceeded: boolean;
	clientName: string;
	configVolume: string;
	docker: Dockerode;
	image: string;
	initializerName: string;
	leaseId: string;
	networkName: string;
	outputDirectory: PreparedOutputDirectory;
	outputOwnershipChanged: boolean;
	resourceCreations: ResourceCreationTracker;
	socketVolume: string;
	stateVolume: string;
	workerName: string;
}) => {
	const cleanupDeadline = createDeadline(CLEANUP_TIMEOUT_MS);
	const failures: unknown[] = [];
	const attempt = async (operation: () => Promise<void>) => {
		try {
			await operation();
		} catch (error) {
			failures.push(error);
		}
	};
	try {
		await attempt(() =>
			waitForTrackedResourceCreations(
				input.resourceCreations,
				cleanupDeadline.signal,
			),
		);
		await Promise.all(
			[
				{
					labels: buildLabels(input.leaseId, "client"),
					name: input.clientName,
				},
				{
					labels: buildLabels(input.leaseId, "worker"),
					name: input.workerName,
				},
				{
					labels: buildLabels(input.leaseId, "initializer"),
					name: input.initializerName,
				},
			].map(({ labels, name }) =>
				attempt(() =>
					removeOwnedContainer(
						input.docker,
						name,
						labels,
						cleanupDeadline.signal,
					),
				),
			),
		);
		if (input.outputOwnershipChanged) {
			await attempt(() =>
				changeOutputOwnership({
					directory: input.outputDirectory.resolvedPath,
					docker: input.docker,
					image: input.image,
					leaseId: input.leaseId,
					name: input.initializerName,
					owner: `${input.outputDirectory.uid}:${input.outputDirectory.gid}`,
					recursive: true,
					resourceCreations: input.resourceCreations,
					signal: cleanupDeadline.signal,
				}),
			);
		}
		await attempt(() =>
			waitForTrackedResourceCreations(
				input.resourceCreations,
				cleanupDeadline.signal,
			),
		);
		await attempt(() =>
			removeOwnedContainer(
				input.docker,
				input.initializerName,
				buildLabels(input.leaseId, "initializer"),
				cleanupDeadline.signal,
			),
		);
		if (!input.buildSucceeded) {
			await attempt(() =>
				raceWithAbort(
					rm(input.artifactPath, { force: true }),
					cleanupDeadline.signal,
				),
			);
		}
		const volumes = [
			[input.stateVolume, "state-volume"],
			[input.configVolume, "config-volume"],
			[input.socketVolume, "socket-volume"],
		] as const;
		await Promise.all(
			volumes.map(([name, component]) =>
				attempt(() =>
					removeOwnedVolume(
						input.docker,
						name,
						input.leaseId,
						component,
						cleanupDeadline.signal,
					),
				),
			),
		);
		await attempt(() =>
			removeOwnedNetwork(
				input.docker,
				input.networkName,
				input.leaseId,
				cleanupDeadline.signal,
			),
		);
	} finally {
		cleanupDeadline.dispose();
	}
	if (failures.length > 0) throw new BuildKitScrubError();
};

export class RootlessBuildKitProvider implements BuildProvider {
	readonly adapterType = "rootless-buildkit";
	readonly #docker: Dockerode;
	readonly #image: string;
	readonly #progress: (stage: string) => void | Promise<void>;

	constructor(input?: {
		docker?: Dockerode;
		image?: string;
		progress?: (stage: string) => void | Promise<void>;
	}) {
		this.#docker = input?.docker ?? new Dockerode();
		this.#image = input?.image ?? ROOTLESS_BUILDKIT_IMAGE;
		if (
			!pinnedImagePattern.test(this.#image) ||
			this.#image !== ROOTLESS_BUILDKIT_IMAGE
		) {
			throw new Error("BuildKit worker image must be pinned by digest");
		}
		this.#progress = input?.progress ?? (() => undefined);
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		if (context.signal?.aborted) throw new BuildExecutionBoundedError();
		const deadline = createDeadline(DEFAULT_BUILD_TIMEOUT_MS, context.signal);
		try {
			const [version] = await Promise.all([
				raceWithAbort(this.#docker.version(), deadline.signal),
				pullImage(this.#docker, this.#image, deadline.signal),
			]);
			return {
				health: "healthy",
				version: String(version.Version),
				capabilities: [
					"build.rootless",
					"build.dockerfile",
					"artifact.docker-tar",
				],
			};
		} finally {
			deadline.dispose();
		}
	}

	async execute(
		context: AdapterExecutionContext,
		request: BuildRequest,
	): Promise<BuildResult> {
		if (
			!identifierPattern.test(request.buildId) ||
			!identifierPattern.test(request.leaseId)
		) {
			throw new Error("Build and lease identifiers are invalid");
		}
		if (!imagePattern.test(request.imageName)) {
			throw new Error("Build image name is invalid");
		}
		if (!digestPattern.test(request.sourceSnapshotDigest)) {
			throw new Error("Source snapshot digest is invalid");
		}
		const timeoutMs = validateTimeout(request.timeoutMs);
		const maxSourceBytes = validateMaxSourceBytes(request.maxSourceBytes);
		const deadline = createDeadline(timeoutMs, context.signal);
		let artifactResiduePath: string | undefined;
		try {
			throwIfAborted(deadline.signal);
			await raceWithAbort(
				Promise.resolve(this.#progress("validating-source-snapshot")),
				deadline.signal,
			);
			const snapshot = await computeSourceSnapshotDigest(
				request.sourceSnapshotPath,
				maxSourceBytes,
				deadline.signal,
			);
			if (snapshot.digest !== request.sourceSnapshotDigest) {
				throw new Error("Source snapshot digest verification failed");
			}

			const { secrets: preparedSecrets, stagingDir: secretsStagingDir } =
				await prepareSecretFiles(
					request.secretFiles,
					snapshot.resolvedRoot,
					deadline.signal,
				);
			const preparedBuildArguments = prepareBuildArguments(request.buildArgs);
			const requestedOutput = path.resolve(request.outputDirectory);
			assertDisjointPaths(
				snapshot.resolvedRoot,
				requestedOutput,
				"Build output must be outside the source snapshot",
			);
			for (const secret of preparedSecrets) {
				assertDisjointPaths(
					secret.resolvedPath,
					requestedOutput,
					"Build output must be outside secret paths",
				);
			}
			const preparedOutputDirectory = await prepareOutputDirectory(
				requestedOutput,
				deadline.signal,
			);
			const outputDirectory = preparedOutputDirectory.resolvedPath;
			assertDisjointPaths(
				snapshot.resolvedRoot,
				outputDirectory,
				"Build output must be outside the source snapshot",
			);
			for (const secret of preparedSecrets) {
				assertDisjointPaths(
					secret.resolvedPath,
					outputDirectory,
					"Build output must be outside secret paths",
				);
			}
			const artifactPath = path.join(outputDirectory, "image.tar");
			await raceWithAbort(rm(artifactPath, { force: true }), deadline.signal);
			artifactResiduePath = artifactPath;

			// Docker's writable-layer size option is driver/platform dependent. Keep it
			// portable and enforce the complete source (<=1 GiB), tmpfs, and artifact
			// (<=2 GiB) bounds instead of pretending a non-portable quota is effective.
			await raceWithAbort(
				Promise.resolve(this.#progress("resolving-buildkit-image")),
				deadline.signal,
			);
			await pullImage(this.#docker, this.#image, deadline.signal);

			const suffix = createHash("sha256")
				.update(`${request.buildId}:${request.leaseId}:${context.fencingToken}`)
				.digest("hex")
				.slice(0, 12);
			const networkName = `dt-build-${suffix}`;
			const workerName = `dt-buildkit-${suffix}`;
			const clientName = `dt-buildctl-${suffix}`;
			const initializerName = `dt-buildkit-init-${suffix}`;
			const stateVolume = `dt-buildkit-state-${suffix}`;
			const configVolume = `dt-buildkit-config-${suffix}`;
			const socketVolume = `dt-buildkit-socket-${suffix}`;
			const resourceCreations: ResourceCreationTracker = new Set();
			let outputOwnershipChanged = false;
			let buildSucceeded = false;
			try {
				await raceWithAbort(
					Promise.resolve(this.#progress("creating-isolated-network")),
					deadline.signal,
				);
				await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createNetwork({
							Name: networkName,
							Driver: "bridge",
							Internal: false,
							CheckDuplicate: true,
							Attachable: false,
							Ingress: false,
							Options: {
								"com.docker.network.bridge.enable_icc": "false",
								"com.docker.network.bridge.host_binding_ipv4": "127.0.0.1",
							},
							Labels: buildLabels(request.leaseId, "network"),
						}),
					),
					deadline.signal,
				);
				await assertNetworkSecurityContract(
					this.#docker,
					networkName,
					request.leaseId,
					deadline.signal,
				);
				await raceWithAbort(
					Promise.resolve(this.#progress("creating-ephemeral-state")),
					deadline.signal,
				);
				await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createVolume({
							Name: stateVolume,
							Labels: buildLabels(request.leaseId, "state-volume"),
						}),
					),
					deadline.signal,
				);
				await assertVolumeOwnership(
					this.#docker,
					stateVolume,
					request.leaseId,
					"state-volume",
					deadline.signal,
				);
				await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createVolume({
							Name: configVolume,
							Labels: buildLabels(request.leaseId, "config-volume"),
						}),
					),
					deadline.signal,
				);
				await assertVolumeOwnership(
					this.#docker,
					configVolume,
					request.leaseId,
					"config-volume",
					deadline.signal,
				);
				await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createVolume({
							Name: socketVolume,
							Labels: buildLabels(request.leaseId, "socket-volume"),
						}),
					),
					deadline.signal,
				);
				await assertVolumeOwnership(
					this.#docker,
					socketVolume,
					request.leaseId,
					"socket-volume",
					deadline.signal,
				);
				for (const volume of [stateVolume, configVolume, socketVolume]) {
					await prepareVolumeOwnership({
						docker: this.#docker,
						image: this.#image,
						leaseId: request.leaseId,
						name: initializerName,
						resourceCreations,
						signal: deadline.signal,
						volume,
					});
				}
				outputOwnershipChanged =
					process.platform !== "win32" && preparedOutputDirectory.uid !== 1000;
				if (outputOwnershipChanged) {
					await changeOutputOwnership({
						directory: outputDirectory,
						docker: this.#docker,
						image: this.#image,
						leaseId: request.leaseId,
						name: initializerName,
						owner: ROOTLESS_USER,
						recursive: false,
						resourceCreations,
						signal: deadline.signal,
					});
				}

				await raceWithAbort(
					Promise.resolve(this.#progress("starting-rootless-worker")),
					deadline.signal,
				);
				const workerBinds = [
					`${configVolume}:/home/user/.docker:rw`,
					`${stateVolume}:/home/user/.local/share/buildkit:rw`,
					`${socketVolume}:/run/buildkit:rw`,
				];
				const worker = await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createContainer({
							Image: this.#image,
							name: workerName,
							User: ROOTLESS_USER,
							Env: [
								"DOCKER_CONFIG=/tmp/docker-config",
								"HOME=/home/user",
								"TMPDIR=/tmp",
								"XDG_RUNTIME_DIR=/run/user/1000",
							],
							Cmd: [
								"--addr",
								"unix:///run/buildkit/buildkitd.sock",
								"--oci-worker-no-process-sandbox",
								"--root",
								"/home/user/.local/share/buildkit",
							],
							Labels: buildLabels(request.leaseId, "worker"),
							HostConfig: {
								AutoRemove: false,
								Binds: workerBinds,
								CapAdd: [],
								CapDrop: [],
								Devices: [],
								DeviceRequests: [],
								Memory: 4 * 1024 * 1024 * 1024,
								NanoCpus: 4_000_000_000,
								NetworkMode: networkName,
								IpcMode: "private",
								PidMode: "",
								OomKillDisable: false,
								PidsLimit: 1024,
								PortBindings: {},
								Privileged: true,
								PublishAllPorts: false,
								ReadonlyRootfs: false,
								RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
								SecurityOpt: ["seccomp=unconfined", "apparmor=unconfined"],
								Tmpfs: {
									"/run/user/1000":
										"rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
									"/tmp": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
								},
								UTSMode: "",
							},
						}),
					),
					deadline.signal,
				);
				// Privileged + unconfined applies only to this disposable outer
				// namespace bootstrap required by rootless BuildKit. The effective
				// BuildKit process is pinned to uid/gid 1000, has no host socket,
				// host devices, host paths, or published ports, and is inspected below.
				await raceWithAbort(worker.start(), deadline.signal);
				const workerInspection = await raceWithAbort(
					worker.inspect(),
					deadline.signal,
				);
				assertWorkerSecurityContract(workerInspection, {
					configVolume,
					image: this.#image,
					leaseId: request.leaseId,
					networkName,
					socketVolume,
					stateVolume,
				});
				await raceWithAbort(
					Promise.resolve(this.#progress("waiting-for-rootless-worker")),
					deadline.signal,
				);
				await waitForWorker(this.#docker, workerName, deadline.signal);

				const binds = [
					`${configVolume}:/home/user/.docker:rw`,
					`${socketVolume}:/run/buildkit:rw`,
					`${snapshot.resolvedRoot}:/workspace:ro`,
					`${outputDirectory}:/out:rw`,
				];
				const secretArguments: string[] = [];
				for (const secret of preparedSecrets) {
					binds.push(`${secret.stagedPath}:/run/secrets/${secret.id}:ro`);
					secretArguments.push(
						"--secret",
						`id=${secret.id},src=/run/secrets/${secret.id}`,
					);
				}
				await raceWithAbort(
					Promise.resolve(this.#progress("starting-build-client")),
					deadline.signal,
				);
				const client = await raceWithAbort(
					trackResourceCreation(
						resourceCreations,
						this.#docker.createContainer({
							Image: this.#image,
							name: clientName,
							User: ROOTLESS_USER,
							Entrypoint: ["buildctl"],
							Cmd: [
								"--addr",
								"unix:///run/buildkit/buildkitd.sock",
								"build",
								"--frontend",
								"dockerfile.v0",
								"--local",
								"context=/workspace",
								"--local",
								"dockerfile=/workspace",
								"--opt",
								`platform=linux/${request.architecture}`,
								...preparedBuildArguments,
								...secretArguments,
								"--output",
								`type=docker,name=${request.imageName},dest=/out/image.tar`,
							],
							Labels: buildLabels(request.leaseId, "client"),
							HostConfig: {
								AutoRemove: false,
								Binds: binds,
								CapAdd: [],
								CapDrop: ["ALL"],
								Devices: [],
								DeviceRequests: [],
								Memory: 1024 * 1024 * 1024,
								NanoCpus: 1_000_000_000,
								NetworkMode: networkName,
								OomKillDisable: false,
								PidsLimit: 256,
								PortBindings: {},
								Privileged: false,
								PublishAllPorts: false,
								ReadonlyRootfs: true,
								SecurityOpt: ["no-new-privileges"],
								Tmpfs: {
									"/home/user/.local/share/buildkit":
										"rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000",
									"/home/user/.local/tmp":
										"rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
									"/run/user/1000":
										"rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
									"/tmp": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
								},
							},
						}),
					),
					deadline.signal,
				);
				await raceWithAbort(client.start(), deadline.signal);
				await raceWithAbort(
					Promise.resolve(this.#progress("building-artifact")),
					deadline.signal,
				);
				const waitResult = await raceWithAbort(client.wait(), deadline.signal);
				if (waitResult.StatusCode !== 0) {
					const logs = await raceWithAbort(
						client.logs({ stdout: true, stderr: true }),
						deadline.signal,
					);
					let diagnostic = Buffer.from(logs).toString("utf8").slice(-4_000);
					for (const secret of preparedSecrets) {
						const redactionValue = (
							await readFile(secret.resolvedPath, "utf8")
						).trim();
						if (redactionValue) {
							diagnostic = diagnostic.replaceAll(redactionValue, "[redacted]");
						}
					}
					await Promise.resolve(
						this.#progress(`build-client-failed:${diagnostic}`),
					);
					throw new Error("Rootless build failed");
				}
				buildSucceeded = true;
			} finally {
				void Promise.resolve(this.#progress("scrubbing-worker")).catch(
					() => undefined,
				);
				await cleanupBuildResources({
					artifactPath,
					buildSucceeded,
					clientName,
					configVolume,
					docker: this.#docker,
					image: this.#image,
					initializerName,
					leaseId: request.leaseId,
					networkName,
					outputDirectory: preparedOutputDirectory,
					outputOwnershipChanged,
					resourceCreations,
					socketVolume,
					stateVolume,
					workerName,
				});
				if (secretsStagingDir) {
					await rm(secretsStagingDir, { force: true, recursive: true }).catch(
						() => undefined,
					);
				}
				void Promise.resolve(this.#progress("worker-scrubbed")).catch(
					() => undefined,
				);
			}
			throwIfAborted(deadline.signal);
			if (!buildSucceeded) {
				throw new Error("Build execution did not produce a result");
			}
			await raceWithAbort(
				Promise.resolve(this.#progress("verifying-artifact")),
				deadline.signal,
			);
			const artifactDigest = await verifyArtifact(
				artifactPath,
				outputDirectory,
				deadline.signal,
			);
			const result: BuildResult = {
				kind: "build.completed",
				artifactPath,
				artifactDigest,
				workerReference: workerName,
				builderVersion: "buildkit-v0.25.1-rootless",
				sourceSnapshotDigest: snapshot.digest,
				scrubbed: true,
			};
			artifactResiduePath = undefined;
			return result;
		} catch (error) {
			let diagnostic = (
				error instanceof Error ? error.message : String(error)
			).slice(-2_000);
			for (const sensitivePath of [
				request.sourceSnapshotPath,
				request.outputDirectory,
				...(request.secretFiles ?? []).map((secret) => secret.path),
			]) {
				if (sensitivePath)
					diagnostic = diagnostic.replaceAll(sensitivePath, "[path]");
			}
			await Promise.resolve(this.#progress(`build-error:${diagnostic}`)).catch(
				() => undefined,
			);
			if (artifactResiduePath) {
				try {
					await removeArtifactResidue(artifactResiduePath);
				} catch {
					throw new BuildKitScrubError();
				}
			}
			if (error instanceof BuildKitScrubError) throw error;
			if (
				deadline.signal.aborted ||
				error instanceof BuildExecutionBoundedError
			) {
				throw new BuildExecutionBoundedError();
			}
			throw normalizeExecutionError(error);
		} finally {
			deadline.dispose();
		}
	}
}
