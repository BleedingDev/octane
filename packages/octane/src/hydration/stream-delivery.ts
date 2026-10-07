import { formatClientError } from '../error-codes.client.generated.js';
import {
	isStreamedRendererFrame,
	isStreamFrameIdentity,
	streamFrameIdentityKey,
	type StreamedRendererFrame,
	type StreamFrameIdentity,
} from '../streamed-signals-protocol.js';
import {
	StreamedReceiverError,
	type StreamedFrameDisposition,
	type StreamedResultReceiver,
} from './stream-result-receiver.js';

type StreamedDeliveryReceiver = Pick<StreamedResultReceiver, 'receive' | 'failSelection'>;

/** Stable realm slot used by CSP-nonced server frame calls. */
export const STREAMED_RENDERER_RECEIVER = '__octaneStreamedRenderer';

export interface StreamedRendererGlobal {
	receive(frame: unknown): void;
}

interface EarlyStreamedRendererGlobal extends StreamedRendererGlobal {
	readonly version: 1;
	readonly frames: unknown[];
	readonly overflow?: boolean;
}

export interface StreamedRendererDeliveryOptions {
	readonly maxFrameBytes?: number;
	/** Includes style/composition waits; also caps unfinished inline result channels. */
	readonly maxPendingFrames?: number;
	readonly maxPendingBytes?: number;
	/** Maximum queue/placement wait and result inactivity; readers also bound each pending read. */
	readonly timeoutMs?: number;
}

export type StreamedRendererAuthority = Pick<
	StreamFrameIdentity,
	'buildId' | 'documentId' | 'ownerKey'
>;

/** @internal The publisher, document and data owner jointly authorize a stream. */
export function streamedRendererAuthorityKey(authority: StreamedRendererAuthority): string {
	return JSON.stringify([authority.buildId, authority.documentId, authority.ownerKey]);
}

export interface StreamedRendererReadOptions extends StreamedRendererDeliveryOptions {
	readonly maxTotalBytes?: number;
	readonly signal?: AbortSignal;
}

const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_PENDING_BYTES = 16 * 1024 * 1024;
const DEFAULT_PENDING_FRAMES = 64;
const DEFAULT_TIMEOUT_MS = 30_000;

function positiveLimit(value: number | undefined, fallback: number): number {
	const limit = value ?? fallback;
	if (!Number.isSafeInteger(limit) || limit <= 0) {
		throw new RangeError(formatClientError(222));
	}
	return limit;
}

/** Cold, optional stream work only. Ordering belongs to one identity/channel;
 * HTML style waits never hold the result channel or another independent region. */
function createDelivery(
	receiver: StreamedDeliveryReceiver,
	options: StreamedRendererDeliveryOptions,
	delivered?: (frame: StreamedRendererFrame, disposition: StreamedFrameDisposition) => void,
) {
	const maxFrameBytes = positiveLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
	const maxPendingBytes = positiveLimit(options.maxPendingBytes, DEFAULT_PENDING_BYTES);
	const maxPendingFrames = positiveLimit(options.maxPendingFrames, DEFAULT_PENDING_FRAMES);
	const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const tails = new Map<string, Promise<void>>();
	const pending = new Set<Promise<void>>();
	const aborters = new Set<(error: StreamedReceiverError) => void>();
	const waiters = new Set<() => void>();
	let pendingBytes = 0;
	let closed: StreamedReceiverError | undefined;
	const notify = () => {
		for (const wake of waiters) wake();
		waiters.clear();
	};
	function validateSize(bytes: number) {
		if (bytes > maxFrameBytes || bytes > maxPendingBytes)
			throw new StreamedReceiverError('overflow', formatClientError(223));
	}
	return {
		async room(bytes: number) {
			validateSize(bytes);
			while (pending.size >= maxPendingFrames || pendingBytes + bytes > maxPendingBytes) {
				if (closed !== undefined) throw closed;
				await new Promise<void>((resolve) => waiters.add(resolve));
			}
			if (closed !== undefined) throw closed;
		},
		enqueue(frame: StreamedRendererFrame, bytes: number): Promise<void> {
			if (closed !== undefined) return Promise.reject(closed);
			try {
				validateSize(bytes);
				if (pending.size >= maxPendingFrames || pendingBytes + bytes > maxPendingBytes)
					throw new StreamedReceiverError('overflow', formatClientError(224));
			} catch (error) {
				receiver.failSelection(frame.identity, error as StreamedReceiverError);
				throw error;
			}
			const key = JSON.stringify([streamFrameIdentityKey(frame.identity), frame.channel]);
			const previous = tails.get(key) ?? Promise.resolve();
			let canceled: StreamedReceiverError | undefined;
			let abort!: (error: StreamedReceiverError) => void;
			const cancellation = new Promise<never>((_, reject) => {
				abort = (error) => {
					canceled = error;
					// Fence synchronously: compositionend can fire in the same task as
					// uninstall, before the rejected delivery's catch handler runs.
					try {
						receiver.failSelection(frame.identity, error);
					} catch {
						/* Still settle delivery. */
					}
					reject(error);
				};
				aborters.add(abort);
			});
			const timer = setTimeout(
				() => abort(new StreamedReceiverError('timeout', formatClientError(225))),
				timeoutMs,
			);
			const work = previous
				.catch(() => {})
				.then(() => {
					if (canceled !== undefined) throw canceled;
					return receiver.receive(frame);
				});
			const delivery: Promise<void> = Promise.race([work, cancellation])
				.then((disposition) => {
					if (canceled !== undefined) throw canceled;
					delivered?.(frame, disposition);
				})
				.catch((cause: unknown) => {
					const error =
						cause instanceof StreamedReceiverError
							? cause
							: new StreamedReceiverError('protocol', formatClientError(226));
					try {
						receiver.failSelection(frame.identity, error);
					} catch {
						/* Cleanup still runs. */
					}
					throw error;
				})
				.finally(() => {
					clearTimeout(timer);
					aborters.delete(abort);
					pending.delete(delivery);
					pendingBytes -= bytes;
					if (tails.get(key) === delivery) tails.delete(key);
					notify();
				});
			pending.add(delivery);
			pendingBytes += bytes;
			tails.set(key, delivery);
			void delivery.catch(() => {});
			return delivery;
		},
		async drain() {
			while (pending.size !== 0) await Promise.allSettled([...pending]);
		},
		close(error: StreamedReceiverError) {
			if (closed !== undefined) return;
			closed = error;
			for (const abort of aborters) abort(error);
			notify();
		},
	};
}

function createGlobalDelivery(
	receiver: StreamedDeliveryReceiver,
	options: StreamedRendererDeliveryOptions,
) {
	const maxOpenResults = positiveLimit(options.maxPendingFrames, DEFAULT_PENDING_FRAMES);
	const resultTimeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const openResults = new Map<
		string,
		{ identity: StreamFrameIdentity; timer: ReturnType<typeof setTimeout> }
	>();
	function forgetResult(identity: StreamFrameIdentity) {
		const key = streamFrameIdentityKey(identity);
		const result = openResults.get(key);
		if (result === undefined) return;
		clearTimeout(result.timer);
		openResults.delete(key);
	}
	const delivery = createDelivery(receiver, options, (frame, disposition) => {
		if (disposition === 'stale' || frame.channel !== 'result') return;
		if (frame.kind === 'complete' || frame.kind === 'error') {
			forgetResult(frame.identity);
		} else {
			const key = streamFrameIdentityKey(frame.identity);
			const previous = openResults.get(key);
			if (previous !== undefined) clearTimeout(previous.timer);
			else if (openResults.size >= maxOpenResults)
				throw new StreamedReceiverError('overflow', formatClientError(229));
			const timer = setTimeout(() => {
				forgetResult(frame.identity);
				try {
					receiver.failSelection(
						frame.identity,
						new StreamedReceiverError('timeout', formatClientError(230)),
					);
				} catch {
					/* The result was fenced before the host error callback ran. */
				}
			}, resultTimeoutMs);
			openResults.set(key, { identity: frame.identity, timer });
		}
	});
	let removed = false;
	return {
		receive(frame: unknown): void {
			if (removed) return;
			if (!isStreamedRendererFrame(frame)) {
				void receiver.receive(frame).catch(() => {});
				return;
			}
			try {
				void delivery
					.enqueue(frame, new TextEncoder().encode(JSON.stringify(frame)).byteLength)
					.catch(() => forgetResult(frame.identity));
			} catch {
				forgetResult(frame.identity);
				// The affected receiver selection reports overflow synchronously.
				// Inline callers cannot await backpressure or retry accepted work.
			}
		},
		close() {
			removed = true;
			const error = new StreamedReceiverError('terminal', formatClientError(231));
			delivery.close(error);
			for (const { identity, timer } of openResults.values()) {
				clearTimeout(timer);
				try {
					receiver.failSelection(identity, error);
				} catch {
					/* Keep retiring this transport. */
				}
			}
			openResults.clear();
		},
	};
}

interface StreamedRendererRouter {
	readonly ingress: EarlyStreamedRendererGlobal & { overflow?: boolean };
	readonly leases: Map<string, ReturnType<typeof createGlobalDelivery>>;
	readonly retired: Set<string>;
	pendingBytes: number;
	removed: boolean;
}

const streamedRendererRouters = new WeakMap<Record<string, unknown>, StreamedRendererRouter>();
const EXCLUSIVE_AUTHORITY = '*';

/**
 * Join the realm's frame ingress with an explicit publisher/document/owner lease.
 * Without an authority, the receiver owns the ingress exclusively. Independent
 * leases cannot replace one another, and their queues and cancellation stay local.
 */
export function installStreamedRendererGlobal(
	receiver: StreamedDeliveryReceiver,
	target: Record<string, unknown> = globalThis as Record<string, unknown>,
	options: StreamedRendererDeliveryOptions & {
		readonly authority?: StreamedRendererAuthority;
	} = {},
): () => void {
	const authority = options.authority;
	if (
		authority !== undefined &&
		(!authority.buildId ||
			!authority.documentId ||
			!authority.ownerKey ||
			typeof authority.buildId !== 'string' ||
			typeof authority.documentId !== 'string' ||
			typeof authority.ownerKey !== 'string')
	) {
		throw new TypeError(formatClientError(269));
	}
	const key =
		authority === undefined ? EXCLUSIVE_AUTHORITY : streamedRendererAuthorityKey(authority);
	let router = streamedRendererRouters.get(target);
	if (router !== undefined && target[STREAMED_RENDERER_RECEIVER] !== router.ingress)
		throw new Error(formatClientError(227));
	if (
		router !== undefined &&
		(router.leases.has(key) ||
			router.leases.has(EXCLUSIVE_AUTHORITY) ||
			(key === EXCLUSIVE_AUTHORITY && router.leases.size !== 0))
	)
		throw new Error(formatClientError(227));
	if (router?.ingress.overflow === true) throw new Error(formatClientError(228));
	const delivery = createGlobalDelivery(receiver, options);
	if (router === undefined) {
		const previous = Object.getOwnPropertyDescriptor(target, STREAMED_RENDERER_RECEIVER);
		const early = previous?.value as EarlyStreamedRendererGlobal | undefined;
		if (
			previous !== undefined &&
			(early === null ||
				typeof early !== 'object' ||
				early.version !== 1 ||
				!Array.isArray(early.frames) ||
				typeof early.receive !== 'function')
		)
			throw new Error(formatClientError(227));
		if (early?.overflow === true) throw new Error(formatClientError(228));
		const leases = new Map<string, ReturnType<typeof createGlobalDelivery>>();
		const retired = new Set<string>();
		const buffered = early?.frames ?? [];
		let initialBytes = 0;
		for (const frame of buffered) {
			const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
			if (bytes > DEFAULT_MAX_FRAME_BYTES) throw new Error(formatClientError(228));
			initialBytes += bytes;
		}
		if (buffered.length > 512 || initialBytes > DEFAULT_PENDING_BYTES)
			throw new Error(formatClientError(228));
		const created: StreamedRendererRouter = {
			ingress: {
				version: 1,
				frames: buffered,
				receive(frame: unknown) {
					if (created.removed) return;
					const exclusive = leases.get(EXCLUSIVE_AUTHORITY);
					if (exclusive !== undefined) {
						exclusive.receive(frame);
						return;
					}
					const identity =
						frame !== null && typeof frame === 'object'
							? (frame as { identity?: unknown }).identity
							: undefined;
					if (!isStreamFrameIdentity(identity)) return;
					const frameKey = streamedRendererAuthorityKey(identity);
					const lease = leases.get(frameKey);
					if (lease !== undefined) {
						lease.receive(frame);
						return;
					}
					if (retired.has(frameKey) || !isStreamedRendererFrame(frame)) return;
					// Claimed authorities go directly to their delivery queue. Only
					// unclaimed frames count against this separate early mailbox.
					const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
					if (
						buffered.length >= 512 ||
						bytes > DEFAULT_MAX_FRAME_BYTES ||
						created.pendingBytes + bytes > DEFAULT_PENDING_BYTES
					) {
						created.ingress.overflow = true;
						return;
					}
					buffered.push(frame);
					created.pendingBytes += bytes;
				},
			},
			leases,
			retired,
			pendingBytes: initialBytes,
			removed: false,
		};
		router = created;
		Object.defineProperty(target, STREAMED_RENDERER_RECEIVER, {
			value: router.ingress,
			configurable: true,
		});
		streamedRendererRouters.set(target, router);
	}
	if (router.ingress.overflow === true) throw new Error(formatClientError(228));
	router.retired.delete(key);
	router.leases.set(key, delivery);
	let retained = 0;
	let pendingBytes = 0;
	for (const frame of router.ingress.frames) {
		if (
			key === EXCLUSIVE_AUTHORITY ||
			(isStreamedRendererFrame(frame) && streamedRendererAuthorityKey(frame.identity) === key)
		)
			delivery.receive(frame);
		else {
			router.ingress.frames[retained++] = frame;
			pendingBytes += new TextEncoder().encode(JSON.stringify(frame)).byteLength;
		}
	}
	router.ingress.frames.length = retained;
	router.pendingBytes = pendingBytes;
	const installed = router;
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		installed.leases.delete(key);
		installed.retired.add(key);
		delivery.close();
		if (installed.leases.size !== 0 || installed.ingress.frames.length !== 0) return;
		installed.removed = true;
		streamedRendererRouters.delete(target);
		if (target[STREAMED_RENDERER_RECEIVER] === installed.ingress)
			delete target[STREAMED_RENDERER_RECEIVER];
	};
}

/**
 * Incrementally consume the same newline-delimited frame protocol used by the
 * initial document stream. A bounded cross-channel window permits independent
 * progress; a full window applies backpressure before accepting another frame.
 */
export async function readStreamedRendererResponse(
	response: Response,
	receiver: StreamedDeliveryReceiver,
	options: StreamedRendererReadOptions = {},
): Promise<void> {
	if (response.body === null) throw new Error(formatClientError(232));
	const maxFrameBytes = positiveLimit(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES);
	const maxTotalBytes = positiveLimit(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
	const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const reader = response.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const openResults = new Map<string, StreamFrameIdentity>();
	const delivery = createDelivery(receiver, options, (frame, disposition) => {
		if (disposition === 'stale' || frame.channel !== 'result') return;
		const key = streamFrameIdentityKey(frame.identity);
		if (frame.kind === 'open') openResults.set(key, frame.identity);
		else if (frame.kind === 'complete' || frame.kind === 'error') openResults.delete(key);
	});
	let frameParts: Uint8Array[] = [];
	let frameBytes = 0;
	let totalBytes = 0;
	let finished = false;
	let failure: StreamedReceiverError | undefined;
	function failOpenResults(error: StreamedReceiverError): boolean {
		let failed = false;
		for (const identity of openResults.values())
			failed = receiver.failSelection(identity, error) || failed;
		openResults.clear();
		return failed;
	}
	const acceptLine = async (): Promise<void> => {
		if (frameBytes === 0) return;
		const bytes =
			frameParts.length === 1
				? frameParts[0]
				: (() => {
						const joined = new Uint8Array(frameBytes);
						let offset = 0;
						for (const part of frameParts) {
							joined.set(part, offset);
							offset += part.byteLength;
						}
						return joined;
					})();
		const frame = JSON.parse(decoder.decode(bytes)) as unknown;
		if (!isStreamedRendererFrame(frame))
			throw new StreamedReceiverError('protocol', formatClientError(233));
		await delivery.room(frameBytes);
		void delivery.enqueue(frame, frameBytes).catch((error: StreamedReceiverError) => {
			failure ??= error;
		});
	};

	const abort = (): void => {
		failure ??= new StreamedReceiverError('terminal', formatClientError(234));
		delivery.close(failure);
		failOpenResults(failure);
		void reader.cancel(options.signal?.reason).catch(() => {});
	};
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	try {
		for (;;) {
			if (failure !== undefined && options.signal?.aborted) throw failure;
			options.signal?.throwIfAborted();
			// Local delivery backpressure has its own bounded wait. Only time
			// spent waiting for the transport belongs to the response deadline.
			const timer = setTimeout(() => {
				failure ??= new StreamedReceiverError('timeout', formatClientError(235));
				abort();
			}, timeoutMs);
			let next: Awaited<ReturnType<typeof reader.read>>;
			try {
				next = await reader.read();
			} finally {
				clearTimeout(timer);
			}
			if (next.done) break;
			totalBytes += next.value.byteLength;
			if (totalBytes > maxTotalBytes) {
				throw new Error(formatClientError(236));
			}
			let start = 0;
			for (let index = 0; index < next.value.byteLength; index++) {
				if (next.value[index] !== 10) continue;
				const part = next.value.subarray(start, index);
				if (part.byteLength > 0) frameParts.push(part);
				frameBytes += part.byteLength;
				if (frameBytes > maxFrameBytes) {
					throw new Error(formatClientError(223));
				}
				await acceptLine();
				frameParts = [];
				frameBytes = 0;
				start = index + 1;
			}
			const tail = next.value.subarray(start);
			if (tail.byteLength > 0) frameParts.push(tail);
			frameBytes += tail.byteLength;
			if (frameBytes > maxFrameBytes) {
				throw new Error(formatClientError(223));
			}
		}
		if (frameBytes !== 0) throw new Error(formatClientError(237));
		await delivery.drain();
		const terminalError = new StreamedReceiverError('terminal', formatClientError(238));
		if (failOpenResults(terminalError)) failure ??= terminalError;
		if (failure !== undefined) throw failure;
		finished = true;
	} catch (cause) {
		const error =
			cause instanceof StreamedReceiverError
				? cause
				: new StreamedReceiverError(
						'protocol',
						cause instanceof Error ? cause.message : formatClientError(239),
					);
		delivery.close(error);
		failOpenResults(error);
		throw error;
	} finally {
		options.signal?.removeEventListener('abort', abort);
		if (!finished) {
			try {
				void reader.cancel().catch(() => {});
			} catch {
				// The transport may already have failed or closed.
			}
		}
		reader.releaseLock();
	}
}
