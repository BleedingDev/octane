import { formatClientError } from '../error-codes.client.generated.js';
import { documentSignalOwner } from '../signals/document-owner.js';
import { createSignalOwnerLifecycle } from '../signals/facade.js';
import type { SignalOwner } from '../signals/types.js';
import type { IndependentHydrateLifecycle } from './independent-island.js';
import type { StreamedSignalResults } from './streamed-signals.js';

export interface SignalDocumentLifecycleOptions {
	readonly document: Document;
	readonly buildId: string;
	readonly documentId: string;
	readonly signalOwner?: SignalOwner;
	readonly streamedHydration?: Pick<StreamedSignalResults, 'suspend'>;
	readonly independentHydration?: IndependentHydrateLifecycle;
	/** Host-owned identity carrier. Null, mismatch, or failure retires persisted state. */
	readonly readIdentity?: () => { readonly buildId: string; readonly documentId: string } | null;
	readonly onMismatch?: () => void;
}

interface DocumentLifecycleParticipant {
	readonly owner: ReturnType<typeof createSignalOwnerLifecycle>;
	readonly streamedHydration: Pick<StreamedSignalResults, 'suspend'> | undefined;
	readonly onRetire: () => void;
}

interface DocumentLifecycleRegistration {
	readonly document: Document;
	readonly documentId: string;
	join(
		owner: SignalOwner,
		streamedHydration: Pick<StreamedSignalResults, 'suspend'> | undefined,
		onRetire: () => void,
	): () => void;
}

const documentLifecycles = /* @__PURE__ */ new WeakMap<
	SignalOwner,
	Set<DocumentLifecycleRegistration>
>();

/** @internal Publishers borrow the host's identity check, never its data owner. */
export function joinSignalDocumentLifecycle(options: {
	readonly document: Document;
	readonly documentId: string;
	readonly hostSignalOwner: SignalOwner | undefined;
	readonly signalOwner: SignalOwner;
	readonly streamedHydration: Pick<StreamedSignalResults, 'suspend'> | undefined;
	readonly onRetire: () => void;
}): (() => void) | undefined {
	// A manual renderer may opt out of document lifecycle handling entirely.
	if (options.hostSignalOwner === undefined) return;
	const registrations = documentLifecycles.get(options.hostSignalOwner);
	if (registrations === undefined) return;
	for (const registration of registrations) {
		if (
			registration.document === options.document &&
			registration.documentId === options.documentId
		)
			return registration.join(options.signalOwner, options.streamedHydration, options.onRetire);
	}
	throw new TypeError(formatClientError(357));
}

/** Optional feature-local lifetime for one executing document, never an account manager. */
export function installSignalDocumentLifecycle(options: SignalDocumentLifecycleOptions) {
	const document = options.document;
	const view = document.defaultView;
	if (!view || !options.buildId || !options.documentId) {
		throw new TypeError(formatClientError(213));
	}
	const signalOwner = options.signalOwner ?? documentSignalOwner(document);
	const owner = createSignalOwnerLifecycle(signalOwner);
	let frozen = false;
	let disposed = false;
	let waiting: Promise<boolean> | undefined;
	let wake: ((active: boolean) => void) | undefined;
	let participants: Set<DocumentLifecycleParticipant> | undefined;
	const registration: DocumentLifecycleRegistration = {
		document,
		documentId: options.documentId,
		join(signalOwner, streamedHydration, onRetire) {
			const participant = {
				owner: createSignalOwnerLifecycle(signalOwner),
				streamedHydration,
				onRetire,
			};
			(participants ??= new Set()).add(participant);
			try {
				if (frozen) {
					try {
						participant.owner.freeze();
					} finally {
						streamedHydration?.suspend();
					}
				}
			} catch (error) {
				participants.delete(participant);
				participant.owner.retire();
				throw error;
			}
			return () => {
				participants!.delete(participant);
			};
		},
	};
	const compatible = (): boolean => {
		if (owner.retired || view.document !== document) return false;
		try {
			if (options.readIdentity !== undefined) {
				const identity = options.readIdentity();
				return identity?.buildId === options.buildId && identity.documentId === options.documentId;
			}
			const data = JSON.parse(document.getElementById('__octane_data')?.textContent || 'null');
			return (
				data?.clientBuild?.version === 1 &&
				data.clientBuild.buildId === options.buildId &&
				data.streamedSignals?.buildId === options.buildId &&
				data.streamedSignals.documentId === options.documentId
			);
		} catch {
			return false;
		}
	};
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		view.removeEventListener('pagehide', hide);
		view.removeEventListener('pageshow', show);
		const registrations = documentLifecycles.get(signalOwner)!;
		registrations.delete(registration);
		if (registrations.size === 0) documentLifecycles.delete(signalOwner);
		try {
			// Unmount islands while their document data is still live. Retiring first
			// would notify each island of the retirement and break its cleanups.
			options.independentHydration?.();
		} finally {
			try {
				if (participants !== undefined) {
					let failure: { error: unknown } | undefined;
					for (const participant of participants) {
						// A native error boundary may rethrow during teardown. Finish each
						// independent publisher before reporting the first failure.
						try {
							participant.onRetire();
						} catch (error) {
							failure ??= { error };
						}
						try {
							participant.owner.retire();
						} catch (error) {
							failure ??= { error };
						}
						try {
							participant.streamedHydration?.suspend();
						} catch (error) {
							failure ??= { error };
						}
					}
					if (failure !== undefined) throw failure.error;
				}
			} finally {
				participants?.clear();
				owner.retire();
				options.streamedHydration?.suspend();
				wake?.(false);
				wake = undefined;
			}
		}
	};
	const hide = (event: PageTransitionEvent): void => {
		if (!event.persisted) {
			dispose();
			return;
		}
		if (disposed || frozen) return;
		frozen = true;
		waiting = new Promise<boolean>((resolve) => {
			wake = resolve;
		});
		owner.freeze();
		if (participants !== undefined) {
			for (const participant of participants) {
				try {
					participant.owner.freeze();
				} finally {
					participant.streamedHydration?.suspend();
				}
			}
		}
		// Close the old stream permanently. A compatible restore starts unfinished
		// idempotent reads under new attempts; it never replays a mutation.
		options.streamedHydration?.suspend();
		options.independentHydration?.pause();
	};
	const show = (event: PageTransitionEvent): void => {
		if (!event.persisted || disposed || !frozen) return;
		if (!compatible()) {
			dispose();
			(options.onMismatch ?? (() => view.location.reload()))();
			return;
		}
		frozen = false;
		owner.resume();
		if (disposed || frozen) return;
		if (participants !== undefined) {
			for (const participant of participants) {
				participant.owner.resume();
				if (disposed || frozen) return;
			}
		}
		options.independentHydration?.resume();
		wake?.(true);
		wake = undefined;
		waiting = undefined;
	};
	view.addEventListener('pagehide', hide);
	view.addEventListener('pageshow', show);
	let registrations = documentLifecycles.get(signalOwner);
	if (registrations === undefined) documentLifecycles.set(signalOwner, (registrations = new Set()));
	registrations.add(registration);
	return {
		signalOwner,
		whenActive(): Promise<boolean> {
			return disposed ? Promise.resolve(false) : (waiting ?? Promise.resolve(true));
		},
		dispose,
	};
}
