import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
	chmod,
	type FileHandle,
	lstat,
	mkdtemp,
	open,
	realpath,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import Dockerode from "dockerode";
import type {
	AdapterExecutionContext,
	AdapterProbeResult,
	RegistryOperation,
	RegistryOperationResult,
	RegistryProvider,
} from "../contracts";

export const MAX_REGISTRY_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

const MAX_REGISTRY_ARTIFACT_BYTES_BIGINT = BigInt(MAX_REGISTRY_ARTIFACT_BYTES);
const COPY_BUFFER_BYTES = 1024 * 1024;
const NOFOLLOW_FLAG =
	process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const imageNamePattern =
	/^[a-z0-9][a-z0-9._/-]{0,200}(?::[a-zA-Z0-9._-]{1,128})?$/;
const imageReferencePattern =
	/^[a-z0-9][a-z0-9._/-]{0,200}(?::[a-zA-Z0-9._-]{1,128}|@sha256:[a-f0-9]{64})?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const publicationFailureMessage = "Registry artifact publication failed";

type PublishOperation = Extract<
	RegistryOperation,
	{ kind: "artifact.publish" }
>;
type DestroyableStream = NodeJS.ReadableStream & {
	destroy?: (error?: Error) => void;
};
type StreamCompletion =
	| { succeeded: true }
	| { error: unknown; succeeded: false };

class RegistryOperationAbortedError extends Error {
	constructor() {
		super("Registry operation aborted");
		this.name = "RegistryOperationAbortedError";
	}
}

export const isRegistryArtifactSizeAllowed = (size: bigint) =>
	size >= 0n && size <= MAX_REGISTRY_ARTIFACT_BYTES_BIGINT;

const throwIfAborted = (signal?: AbortSignal) => {
	if (signal?.aborted) throw new RegistryOperationAbortedError();
};

const raceWithAbort = <T>(
	operation: Promise<T>,
	signal?: AbortSignal,
	onAbort?: () => void,
): Promise<T> => {
	if (!signal) return operation;
	if (signal.aborted) {
		onAbort?.();
		operation.catch(() => undefined);
		return Promise.reject(new RegistryOperationAbortedError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onSignalAbort);
			callback();
		};
		const onSignalAbort = () => {
			onAbort?.();
			finish(() => reject(new RegistryOperationAbortedError()));
		};
		signal.addEventListener("abort", onSignalAbort, { once: true });
		operation.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
};

const destroyStream = (stream: NodeJS.ReadableStream | undefined) => {
	try {
		(stream as DestroyableStream | undefined)?.destroy?.();
	} catch {
		// Cleanup continues even when a Docker stream has already closed itself.
	}
};

const observeStreamCompletion = (stream: Readable): Promise<StreamCompletion> =>
	finished(stream).then(
		() => ({ succeeded: true }),
		(error: unknown) => ({ error, succeeded: false }),
	);

const metadataMatches = (left: BigIntStats, right: BigIntStats) =>
	left.isFile() &&
	right.isFile() &&
	left.dev === right.dev &&
	left.ino === right.ino &&
	left.size === right.size &&
	left.mtimeNs === right.mtimeNs;

const samePath = (left: string, right: string) =>
	path.relative(left, right) === "" && path.relative(right, left) === "";

const assertImageReference = (reference: string) => {
	if (!imageReferencePattern.test(reference)) {
		throw new Error("Image reference is invalid");
	}
};

const exactImageDigest = (value: unknown) => {
	if (typeof value !== "string" || !digestPattern.test(value)) {
		throw new Error("Registry image did not expose an exact content digest");
	}
	return value;
};

const closeHandle = async (handle: FileHandle | undefined) => {
	if (handle) await handle.close();
};

const copySourceIntoStage = async (input: {
	expectedMetadata: BigIntStats;
	hash: ReturnType<typeof createHash>;
	signal?: AbortSignal;
	source: FileHandle;
	staged: FileHandle;
}) => {
	const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
	let totalBytes = 0n;
	while (true) {
		throwIfAborted(input.signal);
		const { bytesRead } = await input.source.read(
			buffer,
			0,
			buffer.length,
			null,
		);
		throwIfAborted(input.signal);
		if (bytesRead === 0) break;
		totalBytes += BigInt(bytesRead);
		if (!isRegistryArtifactSizeAllowed(totalBytes)) {
			throw new Error("Registry artifact exceeds its publication limit");
		}
		let written = 0;
		while (written < bytesRead) {
			throwIfAborted(input.signal);
			const result = await input.staged.write(
				buffer,
				written,
				bytesRead - written,
				null,
			);
			throwIfAborted(input.signal);
			if (result.bytesWritten <= 0) {
				throw new Error("Registry artifact staging made no progress");
			}
			written += result.bytesWritten;
		}
		input.hash.update(buffer.subarray(0, bytesRead));
	}
	if (totalBytes !== input.expectedMetadata.size) {
		throw new Error("Registry artifact changed during publication");
	}
	return totalBytes;
};

const followDockerProgress = async (input: {
	docker: Dockerode;
	progress: NodeJS.ReadableStream;
	signal?: AbortSignal;
	sourceInput: Readable;
	uploadInput: Readable;
}) =>
	new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			input.signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => {
			destroyStream(input.sourceInput);
			destroyStream(input.uploadInput);
			destroyStream(input.progress);
			finish(() => reject(new RegistryOperationAbortedError()));
		};
		if (input.signal?.aborted) {
			onAbort();
			return;
		}
		input.signal?.addEventListener("abort", onAbort, { once: true });
		input.docker.modem.followProgress(input.progress, (error) =>
			finish(() => (error ? reject(error) : resolve())),
		);
	});

export class DockerContentRegistryProvider implements RegistryProvider {
	readonly adapterType = "docker-content-store";
	readonly #docker: Dockerode;

	constructor(docker: Dockerode = new Dockerode()) {
		this.#docker = docker;
	}

	async probe(context: AdapterExecutionContext): Promise<AdapterProbeResult> {
		throwIfAborted(context.signal);
		const version = await raceWithAbort(this.#docker.version(), context.signal);
		return {
			health: "healthy",
			version: String(version.Version),
			capabilities: ["registry.oci", "registry.local-content-store"],
		};
	}

	async #publish(
		context: AdapterExecutionContext,
		operation: PublishOperation,
	): Promise<RegistryOperationResult> {
		let sourceHandle: FileHandle | undefined;
		let stagedHandle: FileHandle | undefined;
		let stagedInput: Readable | undefined;
		let stagedInputFinished: Promise<StreamCompletion> | undefined;
		let uploadInput: Transform | undefined;
		let uploadInputFinished: Promise<StreamCompletion> | undefined;
		let dockerProgress: NodeJS.ReadableStream | undefined;
		let temporaryDirectory: string | undefined;
		let result: RegistryOperationResult | undefined;
		let failure: unknown;
		const recordFailure = (error: unknown) => {
			failure ??= error;
		};

		try {
			throwIfAborted(context.signal);
			if (
				!imageNamePattern.test(operation.imageName) ||
				!digestPattern.test(operation.expectedContentDigest) ||
				!path.isAbsolute(operation.artifactPath)
			) {
				throw new Error("Registry publication input is invalid");
			}

			const requestedMetadata = await lstat(operation.artifactPath, {
				bigint: true,
			});
			throwIfAborted(context.signal);
			if (
				requestedMetadata.isSymbolicLink() ||
				!requestedMetadata.isFile() ||
				!isRegistryArtifactSizeAllowed(requestedMetadata.size)
			) {
				throw new Error("Registry publication source is invalid");
			}
			const resolvedArtifactPath = await realpath(operation.artifactPath);
			if (!samePath(operation.artifactPath, resolvedArtifactPath)) {
				throw new Error("Registry publication source is invalid");
			}

			temporaryDirectory = await mkdtemp(
				path.join(tmpdir(), "deploytide-registry-"),
			);
			await chmod(temporaryDirectory, 0o700);
			throwIfAborted(context.signal);
			const temporaryMetadata = await lstat(temporaryDirectory, {
				bigint: true,
			});
			if (
				!temporaryMetadata.isDirectory() ||
				(process.platform !== "win32" &&
					(temporaryMetadata.mode & 0o777n) !== 0o700n)
			) {
				throw new Error("Registry staging directory is not private");
			}

			const stagedPath = path.join(temporaryDirectory, "artifact.tar");
			stagedHandle = await open(
				stagedPath,
				constants.O_RDWR | constants.O_CREAT | constants.O_EXCL,
				0o600,
			);
			await stagedHandle.chmod(0o600);
			sourceHandle = await open(
				operation.artifactPath,
				constants.O_RDONLY | NOFOLLOW_FLAG,
			);
			const openedMetadata = await sourceHandle.stat({ bigint: true });
			if (!metadataMatches(requestedMetadata, openedMetadata)) {
				throw new Error("Registry artifact changed before publication");
			}

			const hash = createHash("sha256");
			const stagedBytes = await copySourceIntoStage({
				expectedMetadata: openedMetadata,
				hash,
				signal: context.signal,
				source: sourceHandle,
				staged: stagedHandle,
			});
			await stagedHandle.sync();
			throwIfAborted(context.signal);
			const [sourceAfter, pathAfter, stagedMetadata] = await Promise.all([
				sourceHandle.stat({ bigint: true }),
				lstat(operation.artifactPath, { bigint: true }),
				stagedHandle.stat({ bigint: true }),
			]);
			if (
				!metadataMatches(openedMetadata, sourceAfter) ||
				!metadataMatches(openedMetadata, pathAfter) ||
				!stagedMetadata.isFile() ||
				stagedMetadata.size !== stagedBytes ||
				(process.platform !== "win32" &&
					(stagedMetadata.mode & 0o777n) !== 0o600n)
			) {
				throw new Error("Registry artifact changed during publication");
			}
			const contentDigest = `sha256:${hash.digest("hex")}`;
			if (contentDigest !== operation.expectedContentDigest) {
				throw new Error("Registry artifact digest verification failed");
			}

			const openedSource = sourceHandle;
			sourceHandle = undefined;
			await openedSource.close();
			throwIfAborted(context.signal);

			stagedInput = stagedHandle.createReadStream({
				autoClose: false,
				start: 0,
			});
			stagedInputFinished = observeStreamCompletion(stagedInput);
			const uploadHash = createHash("sha256");
			let uploadedBytes = 0n;
			uploadInput = new Transform({
				transform(chunk, encoding, callback) {
					const bytes = Buffer.isBuffer(chunk)
						? chunk
						: Buffer.from(chunk, encoding);
					uploadedBytes += BigInt(bytes.length);
					if (uploadedBytes > stagedBytes) {
						callback(new Error("Registry upload exceeded its staged artifact"));
						return;
					}
					uploadHash.update(bytes);
					callback(null, bytes);
				},
			});
			uploadInputFinished = observeStreamCompletion(uploadInput);
			stagedInput.once("error", (error) => uploadInput?.destroy(error));
			stagedInput.pipe(uploadInput);
			dockerProgress = await raceWithAbort(
				this.#docker.loadImage(uploadInput),
				context.signal,
				() => {
					destroyStream(stagedInput);
					destroyStream(uploadInput);
				},
			);
			await followDockerProgress({
				docker: this.#docker,
				progress: dockerProgress,
				signal: context.signal,
				sourceInput: stagedInput,
				uploadInput,
			});
			const [sourceCompletion, uploadCompletion] = await Promise.all([
				stagedInputFinished,
				uploadInputFinished,
			]);
			if (!sourceCompletion.succeeded) throw sourceCompletion.error;
			if (!uploadCompletion.succeeded) throw uploadCompletion.error;
			if (
				uploadedBytes !== stagedBytes ||
				`sha256:${uploadHash.digest("hex")}` !== operation.expectedContentDigest
			) {
				throw new Error("Registry upload digest verification failed");
			}
			const image = await raceWithAbort(
				this.#docker.getImage(operation.imageName).inspect(),
				context.signal,
				() => destroyStream(dockerProgress),
			);
			result = {
				kind: "artifact.published",
				imageReference: operation.imageName,
				imageDigest: exactImageDigest(image.Id),
			};
		} catch (error) {
			recordFailure(error);
		} finally {
			destroyStream(stagedInput);
			destroyStream(uploadInput);
			destroyStream(dockerProgress);
			if (stagedInputFinished) {
				const completion = await stagedInputFinished;
				if (!completion.succeeded) recordFailure(completion.error);
			}
			if (uploadInputFinished) {
				const completion = await uploadInputFinished;
				if (!completion.succeeded) recordFailure(completion.error);
			}
			try {
				await closeHandle(sourceHandle);
			} catch (error) {
				recordFailure(error);
			}
			try {
				await closeHandle(stagedHandle);
			} catch (error) {
				recordFailure(error);
			}
			if (temporaryDirectory) {
				try {
					await rm(temporaryDirectory, {
						force: true,
						maxRetries: 3,
						recursive: true,
						retryDelay: 10,
					});
				} catch (error) {
					recordFailure(error);
				}
			}
		}

		if (failure || !result) throw new Error(publicationFailureMessage);
		return result;
	}

	async execute(
		context: AdapterExecutionContext,
		operation: RegistryOperation,
	): Promise<RegistryOperationResult> {
		if (operation.kind === "artifact.publish") {
			return this.#publish(context, operation);
		}
		throwIfAborted(context.signal);
		assertImageReference(operation.imageReference);
		if (operation.kind === "artifact.resolve") {
			const image = await raceWithAbort(
				this.#docker.getImage(operation.imageReference).inspect(),
				context.signal,
			);
			return {
				kind: "artifact.resolved",
				imageReference: operation.imageReference,
				imageDigest: exactImageDigest(image.Id),
			};
		}
		await raceWithAbort(
			this.#docker.getImage(operation.imageReference).remove({ force: false }),
			context.signal,
		);
		return { kind: "artifact.deleted" };
	}
}
