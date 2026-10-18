import { formatClientError } from '../error-codes.client.generated.js';
import {
	documentSignalOwner,
	registerSignalDocumentLifecycle,
	type SignalDocumentLifecycleParticipant,
} from '../signals/document-owner.js';
export { joinSignalDocumentLifecycle } from '../signals/document-owner.js';
import {
	assertSignalDocumentOwner,
	retiredSignalOwnerIdentities,
	observeSignalOwnerLifecycle,
	type SignalOwnerLifecycle,
} from '../signals/owner-context.js';
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
	readonly signalOwner: SignalOwner;
	owner: SignalOwnerLifecycle | undefined;
	readonly streamedHydration: Pick<StreamedSignalResults, 'suspend'> | undefined;
	readonly onRetire: () => void;
}

/** Optional feature-local lifetime for one executing document, never an account manager. */
export function installSignalDocumentLifecycle(options: SignalDocumentLifecycleOptions) {
	const document = options.document;
	const view = document.defaultView;
	if (!view || !options.buildId || !options.documentId) {
		throw new TypeError(formatClientError(213));
	}
	const signalOwner = options.signalOwner ?? documentSignalOwner(document);
	assertSignalDocumentOwner(signalOwner);
	let createOwner: ((owner: SignalOwner) => SignalOwnerLifecycle) | undefined;
	let owner: SignalOwnerLifecycle | undefined;
	let frozen = false;
	let disposed = false;
	let waiting: Promise<boolean> | undefined;
	let wake: ((active: boolean) => void) | undefined;
	let participants: Set<DocumentLifecycleParticipant> | undefined;
	const registration = {
		get active() {
			return !disposed && !frozen;
		},
		whenActive(): Promise<boolean> {
			return disposed ? Promise.resolve(false) : (waiting ?? Promise.resolve(true));
		},
		documentId: options.documentId,
		join(
			signalOwner: SignalOwner,
			streamedHydration: Pick<StreamedSignalResults, 'suspend'> | undefined,
			onRetire: () => void,
		): SignalDocumentLifecycleParticipant {
			assertSignalDocumentOwner(signalOwner);
			const participant: DocumentLifecycleParticipant = {
				signalOwner,
				owner: createOwner?.(signalOwner),
				streamedHydration,
				onRetire,
			};
			(participants ??= new Set()).add(participant);
			try {
				if (frozen) {
					try {
						participant.owner?.freeze();
					} finally {
						streamedHydration?.suspend();
					}
				}
			} catch (error) {
				participants.delete(participant);
				if (participant.owner) participant.owner.retire();
				else retiredSignalOwnerIdentities.add(participant.signalOwner);
				throw error;
			}
			const leave = () => {
				participants!.delete(participant);
			};
			return Object.defineProperties(leave, {
				active: { get: () => !disposed && !frozen },
				whenActive: { value: () => registration.whenActive() },
			}) as SignalDocumentLifecycleParticipant;
		},
	};
	const compatible = (): boolean => {
		if (
			owner?.retired ||
			retiredSignalOwnerIdentities.has(signalOwner) ||
			view.document !== document
		)
			return false;
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
		stopObservingOwner();
		view.removeEventListener('pagehide', hide);
		view.removeEventListener('pageshow', show);
		unregister();
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
							if (participant.owner) participant.owner.retire();
							else retiredSignalOwnerIdentities.add(participant.signalOwner);
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
				if (owner) owner.retire();
				else retiredSignalOwnerIdentities.add(signalOwner);
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
		owner?.freeze();
		if (participants !== undefined) {
			for (const participant of participants) {
				try {
					participant.owner?.freeze();
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
		owner?.resume();
		if (disposed || frozen) return;
		if (participants !== undefined) {
			for (const participant of participants) {
				participant.owner?.resume();
				if (disposed || frozen) return;
			}
		}
		options.independentHydration?.resume();
		wake?.(true);
		wake = undefined;
		waiting = undefined;
	};
	const stopObservingOwner = observeSignalOwnerLifecycle((create) => {
		if (disposed) return;
		createOwner = create;
		owner = create(signalOwner);
		if (frozen) owner.freeze();
		for (const participant of participants ?? []) {
			participant.owner = create(participant.signalOwner);
			if (frozen) participant.owner.freeze();
		}
	});
	view.addEventListener('pagehide', hide);
	view.addEventListener('pageshow', show);
	const unregister = registerSignalDocumentLifecycle(document, registration);
	return {
		signalOwner,
		whenActive(): Promise<boolean> {
			return registration.whenActive();
		},
		dispose,
	};
}
