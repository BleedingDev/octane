import { formatClientError } from '../error-codes.client.generated.js';
import type { SignalOwnerIdentity } from '../signals/types.js';

export interface NativeStreamedAuthority {
	readonly buildId: string;
	readonly documentId: string;
	readonly ownerKey: string;
	readonly document: Document;
}

interface AuthorityRegistration {
	readonly authority: NativeStreamedAuthority;
	leases: number;
}

const authorities = /* @__PURE__ */ new WeakMap<SignalOwnerIdentity, AuthorityRegistration>();

function validKey(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

/** Called only after the native bootstrap has successfully claimed its authority. */
export function registerNativeStreamedAuthority(
	owner: SignalOwnerIdentity,
	authority: Omit<NativeStreamedAuthority, 'document'>,
	document: Document,
): () => void {
	if (
		owner === null ||
		typeof owner !== 'object' ||
		authority === null ||
		typeof authority !== 'object' ||
		document === null ||
		typeof document !== 'object'
	)
		throw new TypeError(formatClientError(266));
	const { buildId, documentId, ownerKey } = authority;
	if (
		!validKey(buildId) ||
		!validKey(documentId) ||
		typeof ownerKey !== 'string' ||
		ownerKey.length === 0 ||
		owner.scopeKey !== ownerKey
	)
		throw new TypeError(formatClientError(266));

	let entry = authorities.get(owner);
	if (entry === undefined) {
		entry = { authority: Object.freeze({ buildId, documentId, ownerKey, document }), leases: 0 };
		authorities.set(owner, entry);
	} else if (
		entry.authority.buildId !== buildId ||
		entry.authority.documentId !== documentId ||
		entry.authority.ownerKey !== ownerKey ||
		entry.authority.document !== document
	)
		throw new Error(formatClientError(124));

	const registration = entry;
	registration.leases++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		registration.leases--;
		// An old release must never retire a later registration for this identity.
		if (registration.leases === 0 && authorities.get(owner) === registration)
			authorities.delete(owner);
	};
}

export function getNativeStreamedAuthority(
	owner: SignalOwnerIdentity,
	document: Document,
): NativeStreamedAuthority | undefined {
	const authority = authorities.get(owner)?.authority;
	return authority?.document === document ? authority : undefined;
}
