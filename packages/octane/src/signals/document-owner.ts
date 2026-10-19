import { formatClientError } from '../error-codes.client.generated.js';
import { associateSignalOwnerDocument } from './early-values.js';
import {
	enterSynchronousSignalOwner,
	installDefaultSignalOwner,
	restoreSynchronousSignalOwner,
} from './owner-context.js';
import type { SignalOwner, SignalOwnerIdentity } from './types.js';

const documentOwners = /* @__PURE__ */ new WeakMap<Document, SignalOwnerIdentity>();
let defaultInstalled = false;
/** @internal Actual document capability, shared with an optional renderer. */
export let signalDocumentEnabled = false;
let streamedOwnerActivators: Map<SignalOwnerIdentity, (owner: SignalOwner) => void> | undefined;
export let streamedSignalOwnerActivator: ((owner: SignalOwner) => void) | undefined;
/**
 * @internal Lets a renderer enter each Block's owner in place rather than
 * through a callback frame. The document capability installs it, so renderers
 * that never enable signals do not retain it.
 */
export let signalOwnerFrame:
	| { enter: typeof enterSynchronousSignalOwner; restore: typeof restoreSynchronousSignalOwner }
	| undefined;

/** @internal Shared document identity for state-only and component consumers. */
export function documentSignalOwner(container: Node): SignalOwnerIdentity {
	const ownerDocument =
		container.nodeType === 9 ? (container as Document) : container.ownerDocument;
	if (ownerDocument === null) throw new TypeError(formatClientError(123));
	let owner = documentOwners.get(ownerDocument);
	if (owner === undefined) {
		owner = Object.freeze({ scopeKey: 'octane:document' });
		documentOwners.set(ownerDocument, owner);
	}
	associateSignalOwnerDocument(owner, ownerDocument);
	return owner;
}

/** @internal Compiler capability for global signals without a rendering engine. */
export function enableSignalDocument(abi = 1): void {
	if (abi !== 1) throw new TypeError(formatClientError(74));
	signalDocumentEnabled = true;
	if (defaultInstalled) return;
	defaultInstalled = true;
	signalOwnerFrame = { enter: enterSynchronousSignalOwner, restore: restoreSynchronousSignalOwner };
	installDefaultSignalOwner(() =>
		typeof document === 'undefined' ? null : documentSignalOwner(document),
	);
}

/** @internal Instance activation is optional; global results need no component root. */
export function installStreamedSignalOwnerActivator(
	activate: (owner: SignalOwner) => void,
	documentOwner: SignalOwnerIdentity,
): () => void {
	const activators = (streamedOwnerActivators ??= new Map());
	if (activators.has(documentOwner)) {
		throw new Error(formatClientError(124));
	}
	activators.set(documentOwner, activate);
	streamedSignalOwnerActivator ??= (owner) => {
		const identity = 'documentOwner' in owner ? owner.documentOwner : owner;
		activators.get(identity)?.(owner);
	};
	return () => {
		if (activators.get(documentOwner) !== activate) return;
		activators.delete(documentOwner);
		if (activators.size === 0) streamedSignalOwnerActivator = undefined;
	};
}

/** @internal A joined publisher shares the host document's actual activation lifetime. */
export interface SignalDocumentLifecycleParticipant {
	(): void;
	readonly active: boolean;
	whenActive(): Promise<boolean>;
}

interface DocumentLifecycleRegistration {
	readonly documentId: string;
	join(
		owner: SignalOwner,
		streamedHydration: { suspend(): void } | undefined,
		onRetire: () => void,
	): SignalDocumentLifecycleParticipant;
}

const documentLifecycles = /* @__PURE__ */ new WeakMap<
	Document,
	Set<DocumentLifecycleRegistration>
>();

/** @internal Installed by the optional native document lifecycle implementation. */
export function registerSignalDocumentLifecycle(
	document: Document,
	registration: DocumentLifecycleRegistration,
): () => void {
	let registrations = documentLifecycles.get(document);
	if (registrations === undefined) documentLifecycles.set(document, (registrations = new Set()));
	registrations.add(registration);
	return () => {
		registrations.delete(registration);
		if (registrations.size === 0) documentLifecycles.delete(document);
	};
}

/** @internal Publishers borrow the host's identity check, never its data owner. */
export function joinSignalDocumentLifecycle(options: {
	readonly document: Document;
	readonly documentId: string;
	readonly signalOwner: SignalOwner;
	readonly streamedHydration: { suspend(): void } | undefined;
	readonly onRetire: () => void;
}): SignalDocumentLifecycleParticipant | undefined {
	const registrations = documentLifecycles.get(options.document);
	if (registrations === undefined) return;
	for (const registration of registrations) {
		if (registration.documentId === options.documentId)
			return registration.join(options.signalOwner, options.streamedHydration, options.onRetire);
	}
	throw new TypeError(formatClientError(357));
}
