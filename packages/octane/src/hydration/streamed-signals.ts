import { formatClientError } from '../error-codes.client.generated.js';
import {
	documentSignalOwner,
	enableSignalDocument,
	installStreamedSignalOwnerActivator,
} from '../signals/document-owner.js';
import { attachStreamedSignalResult, initializeDocumentSignalOwner } from '../signals/facade.js';
import { registerSignalOwnerDocument } from '../signals/early-values.js';
import { retireSignalOwnerIdentity } from '../signals/owner-context.js';
import {
	validateNativeSignalManifest,
	type NativeSignalManifest,
} from '../signals/native-read-seeds.js';
export type { NativeSignalManifest, NativeSignalReference } from '../signals/native-read-seeds.js';
import type {
	SignalOwner,
	SignalOwnerIdentity,
	SignalRendererOwnerIdentity,
} from '../signals/types.js';
import {
	isStreamFrameIdentity,
	isStreamedRendererFrame,
	streamFrameIdentityKey,
	type StreamFrameIdentity,
} from '../streamed-signals-protocol.js';
import {
	installStreamedRendererGlobal,
	readStreamedMailboxAuthorities,
	streamedRendererAuthorityKey,
	type StreamedRendererAuthority,
	type StreamedRendererDeliveryOptions,
} from './stream-delivery.js';
import { createStreamedRegionReceiver, type StreamedRegionReceiver } from './stream-receiver.js';
import {
	createStreamedResultReceiver,
	type StreamedResultReceiver,
	type StreamedResultReceiverOptions,
} from './stream-result-receiver.js';
export {
	installSignalDocumentLifecycle,
	type SignalDocumentLifecycleOptions,
} from './document-lifecycle.js';

const STREAMED_SIGNAL_SELECTIONS = '__octaneStreamedSignalSelections';

interface EarlyStreamedSignalSelections {
	readonly version: 1;
	readonly identities: unknown[];
	overflow?: boolean;
	readonly authorities?: unknown;
	readonly refused?: unknown;
	readonly exhausted?: unknown;
	register(identity: unknown): void;
}

interface EarlyStreamedRenderer {
	readonly version: 1;
	readonly frames: unknown[];
	receive(frame: unknown): void;
}

interface StreamedSelectionRouter {
	readonly early: EarlyStreamedSignalSelections;
	readonly leases: Map<string, (identity: StreamFrameIdentity) => void>;
	readonly retired: Set<string>;
	readonly admitted: Set<string>;
	readonly refused: Set<string>;
	exhausted: boolean;
	removed: boolean;
	pendingBytes: number;
	restore(): void;
}

const streamedSelectionRouters = /* @__PURE__ */ new WeakMap<
	Record<string, unknown>,
	StreamedSelectionRouter
>();

function installSelectionLease(
	target: Record<string, unknown>,
	early: EarlyStreamedSignalSelections,
	authority: StreamedRendererAuthority,
	register: (identity: StreamFrameIdentity) => void,
) {
	const key = streamedRendererAuthorityKey(authority);
	let router = streamedSelectionRouters.get(target);
	if (
		router !== undefined &&
		(router.early !== early || router.leases.has(key) || router.retired.has(key))
	)
		throw new Error(formatClientError(124));
	if (router === undefined) {
		const history = readStreamedMailboxAuthorities(
			early,
			early.identities,
			false,
			256,
			formatClientError(268),
		);
		const { admitted, refused } = history;
		let initialBytes = history.bytes;
		for (const identity of early.identities)
			initialBytes += new TextEncoder().encode(JSON.stringify(identity)).byteLength;
		if (early.identities.length + refused.size > 256 || initialBytes > 4 * 1024 * 1024)
			throw new Error(formatClientError(268));
		const leases = new Map<string, (identity: StreamFrameIdentity) => void>();
		const retired = new Set<string>();
		const originalRegister = early.register;
		const created: StreamedSelectionRouter = {
			early,
			leases,
			retired,
			admitted,
			refused,
			exhausted: history.exhausted,
			removed: false,
			pendingBytes: initialBytes,
			restore() {
				created.removed = true;
				if (early.register === route) early.register = originalRegister;
			},
		};
		const route = (candidate: unknown) => {
			if (created.removed) return;
			if (!isStreamFrameIdentity(candidate)) throw new Error(formatClientError(269));
			const candidateKey = streamedRendererAuthorityKey(candidate);
			const lease = leases.get(candidateKey);
			if (lease !== undefined) {
				lease(candidate);
				return;
			}
			if (retired.has(candidateKey)) return;
			if (refused.has(candidateKey) || (created.exhausted && !admitted.has(candidateKey)))
				throw new Error(formatClientError(268));
			const bytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
			const known = admitted.has(candidateKey);
			const authorityBytes = known ? 0 : new TextEncoder().encode(candidateKey).byteLength;
			if (
				!known &&
				(admitted.size + refused.size + retired.size >= 256 ||
					created.pendingBytes + authorityBytes > 4 * 1024 * 1024)
			) {
				created.exhausted = true;
				throw new Error(formatClientError(268));
			}
			if (
				early.identities.length + refused.size + retired.size >= 256 ||
				created.pendingBytes + bytes + authorityBytes > 4 * 1024 * 1024
			) {
				// Keep one refusal instead of this authority's incomplete selections.
				let retained = 0;
				for (const queued of early.identities) {
					if (
						isStreamFrameIdentity(queued) &&
						streamedRendererAuthorityKey(queued) === candidateKey
					)
						created.pendingBytes -= new TextEncoder().encode(JSON.stringify(queued)).byteLength;
					else early.identities[retained++] = queued;
				}
				early.identities.length = retained;
				const refusalBytes = authorityBytes;
				if (
					early.identities.length + refused.size + retired.size >= 256 ||
					created.pendingBytes + refusalBytes > 4 * 1024 * 1024
				) {
					// Exhaustion cannot forget the rejected key and admit it later.
					// Existing leases still deliver directly, before this cold mailbox.
					created.exhausted = true;
					if (admitted.delete(candidateKey))
						created.pendingBytes -= new TextEncoder().encode(candidateKey).byteLength;
				} else {
					admitted.delete(candidateKey);
					refused.add(candidateKey);
					created.pendingBytes += refusalBytes;
				}
				throw new Error(formatClientError(268));
			}
			admitted.add(candidateKey);
			early.identities.push(candidate);
			created.pendingBytes += bytes + authorityBytes;
		};
		early.register = route;
		router = created;
		streamedSelectionRouters.set(target, router);
	}
	if ((router.exhausted && !router.admitted.has(key)) || router.refused.has(key))
		throw new Error(formatClientError(268));
	router.admitted.delete(key);
	router.leases.set(key, register);
	const installed = router;
	let removed = false;
	return {
		drain() {
			const matching: StreamFrameIdentity[] = [];
			let retained = 0;
			let pendingBytes = 0;
			for (const admittedKey of installed.admitted)
				pendingBytes += new TextEncoder().encode(admittedKey).byteLength;
			for (const retiredKey of installed.retired)
				pendingBytes += new TextEncoder().encode(retiredKey).byteLength;
			for (const refusedKey of installed.refused)
				pendingBytes += new TextEncoder().encode(refusedKey).byteLength;
			for (const candidate of early.identities) {
				if (!isStreamFrameIdentity(candidate)) throw new Error(formatClientError(269));
				if (streamedRendererAuthorityKey(candidate) === key) matching.push(candidate);
				else {
					early.identities[retained++] = candidate;
					pendingBytes += new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
				}
			}
			early.identities.length = retained;
			installed.pendingBytes = pendingBytes;
			for (const identity of matching) register(identity);
		},
		dispose() {
			if (removed) return;
			removed = true;
			installed.leases.delete(key);
			const retirementBytes = new TextEncoder().encode(key).byteLength;
			if (
				early.identities.length + installed.refused.size + installed.retired.size >= 256 ||
				installed.admitted.size + installed.refused.size + installed.retired.size >= 256 ||
				installed.pendingBytes + retirementBytes > 4 * 1024 * 1024
			)
				installed.exhausted = true;
			else {
				installed.retired.add(key);
				installed.pendingBytes += retirementBytes;
			}
			// The retired mailbox still fences late calls through its own closure.
			// Keep failed authority markers for this mailbox lifetime too; dropping
			// them would let a later join mistake incomplete history for no history.
			if (
				installed.leases.size === 0 &&
				early.identities.length === 0 &&
				installed.refused.size === 0 &&
				!installed.exhausted &&
				streamedSelectionRouters.get(target) === installed
			) {
				streamedSelectionRouters.delete(target);
				installed.restore();
			}
		},
	};
}

export interface StreamedSignalHydrationOptions extends StreamedRendererDeliveryOptions {
	readonly buildId: string;
	readonly documentId: string;
	/** Custom authority; pass it to hydrateRoot or use runWithSignalOwner in behavior callbacks. */
	readonly signalOwner?: SignalOwnerIdentity;
	/**
	 * Full version 1 initial-response data only. Install once, before live access or stream
	 * attachment. Only the document scope is initialized; instance snapshots stay
	 * historical. A failed join retires newly initialized authority rather than
	 * rolling state back. The caller supplies the matching build/document identity.
	 */
	readonly initialSignals?: NativeSignalManifest;
	readonly target?: Record<string, unknown>;
}

export interface StreamedSignalResults {
	readonly signalOwner: SignalOwnerIdentity;
	readonly receiver: StreamedResultReceiver;
	dispose(): void;
	/** Permanently fence this document's old ingress without restoring its early mailbox. */
	suspend(): void;
}

export interface StreamedSignalHydration extends StreamedSignalResults {
	readonly receiver: StreamedRegionReceiver;
}

function documentOwner(owner: SignalOwner): SignalOwnerIdentity {
	return 'documentOwner' in owner ? owner.documentOwner : owner;
}

/**
 * Upgrade the server's pre-module mailboxes before behavior reads or hydration.
 * No component root is required. An optional hydrateRoot receives the returned
 * owner so its instance-local descriptors join the same server-authorized
 * selections without starting duplicate browser loaders.
 */
export function bootstrapStreamedSignalHydration(
	options: StreamedSignalHydrationOptions,
): StreamedSignalHydration {
	return bootstrapStreamedSignals(options, createStreamedRegionReceiver);
}

/**
 * Upgrade the same pre-module mailboxes when the host owns DOM delivery.
 * Results join the existing signal owner synchronously, without region placement
 * support. Use bootstrapStreamedSignalHydration to register streamed HTML ranges.
 */
export function bootstrapStreamedSignalResults(
	options: StreamedSignalHydrationOptions,
): StreamedSignalResults {
	return bootstrapStreamedSignals(options, createStreamedResultReceiver);
}

function bootstrapStreamedSignals<Receiver extends StreamedResultReceiver>(
	options: StreamedSignalHydrationOptions,
	createReceiver: (options: StreamedResultReceiverOptions) => Receiver,
): StreamedSignalResults & { readonly receiver: Receiver } {
	if (!options.buildId || !options.documentId) {
		throw new TypeError(formatClientError(266));
	}
	const target = options.target ?? (globalThis as Record<string, unknown>);
	const signalOwner = options.signalOwner ?? documentSignalOwner(document);
	const receiver = createReceiver({
		buildId: options.buildId,
		documentId: options.documentId,
		ownerKey: signalOwner.scopeKey,
		...(options.maxPendingFrames === undefined
			? {}
			: { maxPendingFrames: options.maxPendingFrames }),
		...(options.maxPendingBytes === undefined ? {} : { maxPendingBytes: options.maxPendingBytes }),
		...(options.timeoutMs === undefined ? {} : { pendingTimeoutMs: options.timeoutMs }),
	});
	const early = target[STREAMED_SIGNAL_SELECTIONS] as EarlyStreamedSignalSelections | undefined;
	if (
		early === undefined ||
		early === null ||
		typeof early !== 'object' ||
		early.version !== 1 ||
		!Array.isArray(early.identities) ||
		typeof early.register !== 'function'
	) {
		receiver.dispose();
		throw new Error(formatClientError(267));
	}
	if (early.overflow === true) {
		receiver.dispose();
		throw new Error(formatClientError(268));
	}
	const selections = new Map<string, { identity: StreamFrameIdentity; detach?: () => void }>();
	const owners = new Map<string, SignalRendererOwnerIdentity>();
	let disposed = false;
	const attach = (
		selection: { identity: StreamFrameIdentity; detach?: () => void },
		owner: SignalRendererOwnerIdentity,
	): void => {
		if (selection.detach !== undefined || selection.identity.instanceKey !== owner.instanceKey)
			return;
		selection.detach = attachStreamedSignalResult(receiver, owner, selection.identity);
	};
	const register = (candidate: unknown): void => {
		if (disposed) return;
		if (
			!isStreamFrameIdentity(candidate) ||
			candidate.buildId !== options.buildId ||
			candidate.documentId !== options.documentId ||
			candidate.ownerKey !== signalOwner.scopeKey
		) {
			throw new Error(formatClientError(269));
		}
		const slot = JSON.stringify([candidate.instanceKey, candidate.nodeKey]);
		const previous = selections.get(slot);
		previous?.detach?.();
		receiver.registerSelection(candidate);
		const selection = { identity: candidate };
		selections.set(slot, selection);
		const owner = owners.get(candidate.instanceKey);
		if (owner !== undefined) attach(selection, owner);
		else if (candidate.nodeKey.startsWith('g:')) {
			// A global descriptor belongs to the document cell even though the wire
			// retains the exact renderer instance that selected this attempt. Join it
			// before any root exists; an i: descriptor still waits for its real scope.
			attach(selection, {
				scopeKey: signalOwner.scopeKey,
				documentOwner: signalOwner,
				instanceOwner: signalOwner,
				instanceKey: candidate.instanceKey,
			});
		}
	};
	const authority = {
		buildId: options.buildId,
		documentId: options.documentId,
		ownerKey: signalOwner.scopeKey,
	};
	let selectionLease: ReturnType<typeof installSelectionLease> | undefined;
	let uninstallOwnerActivator: (() => void) | undefined;
	let initialized = false;
	try {
		// Reserve the exact authority before initializing state or touching mailboxes.
		selectionLease = installSelectionLease(target, early, authority, register);
		uninstallOwnerActivator = installStreamedSignalOwnerActivator((owner) => {
			if (disposed || !('documentOwner' in owner) || documentOwner(owner) !== signalOwner) return;
			if (owners.has(owner.instanceKey)) return;
			owners.set(owner.instanceKey, owner);
			for (const selection of selections.values()) attach(selection, owner);
		}, signalOwner);
		if (options.initialSignals !== undefined) {
			const manifest = validateNativeSignalManifest(options.initialSignals);
			if (manifest.version !== 1) throw new TypeError(formatClientError(270));
			initializeDocumentSignalOwner(
				signalOwner,
				manifest.scopes.find((scope) => scope.scopeKey === signalOwner.scopeKey) ?? {
					version: 1,
					scopeKey: signalOwner.scopeKey,
					entries: [],
				},
			);
			initialized = true;
		}
		registerSignalOwnerDocument(signalOwner, document);
		enableSignalDocument();
		selectionLease.drain();
	} catch (error) {
		uninstallOwnerActivator?.();
		selectionLease?.dispose();
		for (const selection of selections.values()) selection.detach?.();
		receiver.dispose();
		// Never retain partially initialized document state after a failed join.
		// Its authority is retired rather than rolling live data backward.
		if (initialized) retireSignalOwnerIdentity(signalOwner);
		throw error;
	}
	// Result calls that beat module evaluation must be in the engine mailbox
	// before a synchronous hydrateRoot read can consider starting its loader.
	// Placement stays on the normal async delivery path because its DOM range and
	// styles may not be registered yet.
	const earlyRenderer = target['__octaneStreamedRenderer'] as EarlyStreamedRenderer | undefined;
	if (
		earlyRenderer !== undefined &&
		earlyRenderer !== null &&
		typeof earlyRenderer === 'object' &&
		earlyRenderer.version === 1 &&
		Array.isArray(earlyRenderer.frames)
	) {
		const current = new Set(
			[...selections.values()].map(({ identity }) => streamFrameIdentityKey(identity)),
		);
		let retained = 0;
		for (const frame of earlyRenderer.frames) {
			if (
				isStreamedRendererFrame(frame) &&
				frame.channel === 'result' &&
				current.has(streamFrameIdentityKey(frame.identity))
			) {
				void receiver.receive(frame).catch(() => {});
			} else {
				earlyRenderer.frames[retained++] = frame;
			}
		}
		earlyRenderer.frames.length = retained;
	}
	let uninstallDelivery: () => void;
	try {
		uninstallDelivery = installStreamedRendererGlobal(receiver, target, { ...options, authority });
	} catch (error) {
		uninstallOwnerActivator();
		selectionLease.dispose();
		for (const selection of selections.values()) selection.detach?.();
		receiver.dispose();
		if (initialized) retireSignalOwnerIdentity(signalOwner);
		throw error;
	}
	const close = (restore: boolean): void => {
		if (disposed) return;
		disposed = true;
		selectionLease.dispose();
		uninstallOwnerActivator();
		for (const selection of selections.values()) selection.detach?.();
		uninstallDelivery();
		if (!restore && target['__octaneStreamedRenderer'] === undefined) {
			// Only the final lease fences ingress; sibling publishers stay live.
			target['__octaneStreamedRenderer'] = { receive() {} };
		}
		selections.clear();
		owners.clear();
		receiver.dispose();
	};
	return {
		signalOwner,
		receiver,
		dispose() {
			close(true);
		},
		suspend() {
			close(false);
		},
	};
}
