import { formatClientError } from './error-codes.client.generated.js';

export const PUBLISHER_BOUNDARY_ATTR = 'data-octane-publisher';

export interface PublisherBoundaryDescriptor {
	readonly version: 1;
	readonly publisherKey: string;
	readonly documentId: string | null;
	readonly boundaryId: string;
	readonly ownerKey: string;
	readonly identifierPrefix: string;
	readonly streamBuildId: string | null;
}

const descriptorKeys = [
	'version',
	'publisherKey',
	'documentId',
	'boundaryId',
	'ownerKey',
	'identifierPrefix',
	'streamBuildId',
] as const;

// Includes the maximum escaped canonical descriptor for four 1024-unit keys.
const MAX_WIRE_LENGTH = 64 * 1024;
const MAX_STREAM_IDENTITY_LENGTH = 1024;

function invalid(): never {
	throw new TypeError(formatClientError(337));
}

function validKey(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

export function createPublisherBoundaryDescriptor(
	publisherKey: string,
	documentId: string | null,
	boundaryId: string,
	streamBuildId: string | null,
): PublisherBoundaryDescriptor {
	if (
		!validKey(publisherKey) ||
		(documentId !== null && !validKey(documentId)) ||
		!validKey(boundaryId) ||
		(streamBuildId !== null && !validKey(streamBuildId))
	)
		invalid();
	const ownerKey = JSON.stringify(['octane:publisher', documentId, publisherKey, boundaryId]);
	const identifierPrefix = `${boundaryId}-publisher-`;
	if (
		ownerKey.length > MAX_STREAM_IDENTITY_LENGTH ||
		identifierPrefix.length > MAX_STREAM_IDENTITY_LENGTH ||
		JSON.stringify([identifierPrefix, 'root']).length > MAX_STREAM_IDENTITY_LENGTH
	)
		invalid();
	return Object.freeze({
		version: 1 as const,
		publisherKey,
		documentId,
		boundaryId,
		ownerKey,
		identifierPrefix,
		streamBuildId,
	});
}

/** Admit descriptor data without reading getters or retaining the caller's object. */
export function decodePublisherBoundaryDescriptor(value: unknown): PublisherBoundaryDescriptor {
	if (typeof value === 'string') {
		if (value.length > MAX_WIRE_LENGTH) invalid();
		try {
			value = JSON.parse(value);
		} catch {
			invalid();
		}
	}
	if (value === null || typeof value !== 'object') invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid();
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== descriptorKeys.length ||
		keys.some(
			(key) =>
				typeof key !== 'string' || !descriptorKeys.includes(key as (typeof descriptorKeys)[number]),
		)
	)
		invalid();
	const descriptors: Record<string, PropertyDescriptor> = Object.create(null);
	for (const key of descriptorKeys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (property === undefined || !property.enumerable || !('value' in property)) invalid();
		descriptors[key] = property;
	}
	const version: unknown = descriptors.version.value;
	const publisherKey: unknown = descriptors.publisherKey.value;
	const documentId: unknown = descriptors.documentId.value;
	const boundaryId: unknown = descriptors.boundaryId.value;
	const streamBuildId: unknown = descriptors.streamBuildId.value;
	if (
		version !== 1 ||
		!validKey(publisherKey) ||
		(documentId !== null && !validKey(documentId)) ||
		!validKey(boundaryId) ||
		(streamBuildId !== null && !validKey(streamBuildId))
	)
		invalid();
	const admitted = createPublisherBoundaryDescriptor(
		publisherKey,
		documentId,
		boundaryId,
		streamBuildId,
	);
	if (
		descriptors.ownerKey.value !== admitted.ownerKey ||
		descriptors.identifierPrefix.value !== admitted.identifierPrefix
	)
		invalid();
	return admitted;
}

export function serializePublisherBoundaryDescriptor(
	descriptor: PublisherBoundaryDescriptor,
): string {
	return JSON.stringify(decodePublisherBoundaryDescriptor(descriptor)).replace(/</g, '\\u003c');
}
