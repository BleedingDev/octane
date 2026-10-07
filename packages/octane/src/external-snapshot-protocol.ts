import { decodeSignalValue, encodeSignalValue } from './data-encoding.js';
import { isContext } from './context-identity.js';
import { formatClientError } from './error-codes.client.generated.js';
import type { EncodedSignalValue } from './signals/types.js';
import {
	snapshotExternalSnapshotRequest,
	snapshotExternalSnapshotResponse,
} from './external-snapshot-budget.js';

export const EXTERNAL_SNAPSHOT_ATTR = 'data-octane-external-snapshot';
export const EXTERNAL_SNAPSHOT_ABI = 1;

export interface ExternalSnapshotAuthority {
	readonly publisherBuildId: string;
	readonly runtimeABI: 1;
}

/** Native wire data. Transports must forward it without rebuilding its fields. */
export interface ExternalSnapshotRequest {
	readonly version: 1;
	readonly authority: ExternalSnapshotAuthority;
	readonly documentId: string;
	readonly boundaryId: string;
	readonly ownerKey: string;
	readonly identifierPrefix: string;
	readonly props: EncodedSignalValue;
	readonly contexts: readonly { readonly key: string; readonly value: EncodedSignalValue }[];
	readonly nonce?: string;
}

export interface ExternalSnapshot {
	readonly version: 1;
	readonly request: ExternalSnapshotRequest;
	/** Hydratable native boundary output, including its renderer-owned sidecars. */
	readonly html: string;
	/** Native scoped styles, collected by the host through its normal CSS channel. */
	readonly styles: readonly {
		readonly id: string;
		readonly css: string;
		readonly nonce?: string;
	}[];
	readonly head: string;
}

export interface ExternalSnapshotBoundaryOptions<P, C> {
	readonly authority: ExternalSnapshotAuthority;
	readonly snapshot: (
		request: ExternalSnapshotRequest,
		signal?: AbortSignal,
	) => PromiseLike<ExternalSnapshot>;
	/** A native component or native lazy component. */
	readonly component: C;
	/** Optional server snapshot deadline. Expiry aborts this boundary's transport waiter. */
	readonly timeoutMs?: number;
	/** Registered context keys required by this publisher. Missing providers fail closed. */
	readonly contextKeys?: readonly string[];
}

export interface ExternalSnapshotContextCodec<T> {
	readonly key: string;
	readonly encode: (value: T) => unknown;
	readonly decode: (value: unknown, signal?: AbortSignal) => T | PromiseLike<T>;
	/** Release one successfully reconstructed server value after import/render or cancellation. */
	readonly dispose?: (value: T) => void | PromiseLike<void>;
	/** Validate against selected reconstructed contexts before exposed code is imported. */
	readonly validate?: (
		value: T,
		readContext: ExternalSnapshotContextReader,
		signal?: AbortSignal,
	) => void | PromiseLike<void>;
}

/** Physical native context identities selected by this request, without default fallbacks. */
export type ExternalSnapshotContextReader = <T>(
	context: Function & { readonly defaultValue: T },
) => { readonly present: false } | { readonly present: true; readonly value: T };

interface ContextCodec {
	readonly context: Function;
	readonly codec: ExternalSnapshotContextCodec<any>;
}

// Registration is opt-in and renderer-free. Ordinary contexts allocate no records.
const contextCodecs = /* @__PURE__ */ new Map<string, ContextCodec>();
const contextKeys = /* @__PURE__ */ new WeakMap<Function, string>();

/** Register an explicit server projection; client hydration still reads live ancestor contexts. */
export function registerExternalSnapshotContext<T>(
	context: Function & { readonly defaultValue: T },
	codec: ExternalSnapshotContextCodec<T>,
): () => void {
	if (
		!isContext(context) ||
		!validKey(codec.key) ||
		typeof codec.encode !== 'function' ||
		typeof codec.decode !== 'function' ||
		(codec.dispose !== undefined && typeof codec.dispose !== 'function') ||
		(codec.validate !== undefined && typeof codec.validate !== 'function') ||
		contextCodecs.has(codec.key) ||
		contextKeys.has(context)
	)
		throw new TypeError(formatClientError(338));
	const { key, encode, decode, dispose, validate } = codec;
	const entry = { context, codec: Object.freeze({ key, encode, decode, dispose, validate }) };
	contextCodecs.set(key, entry);
	contextKeys.set(context, key);
	return () => {
		if (contextCodecs.get(key) !== entry) return;
		contextCodecs.delete(key);
		contextKeys.delete(context);
	};
}

export function captureExternalSnapshotContexts(
	values: ReadonlyMap<Function, unknown> | null,
	required: readonly string[] | undefined,
): ExternalSnapshotRequest['contexts'] {
	const captured: { key: string; value: EncodedSignalValue }[] = [];
	const keys = new Set<string>();
	for (const key of required ?? []) {
		const entry = contextCodecs.get(key);
		if (entry === undefined || !values?.has(entry.context) || keys.has(key))
			throw new TypeError(formatClientError(338));
		keys.add(key);
		captured.push({ key, value: encodeSignalValue(entry.codec.encode(values.get(entry.context))) });
	}
	return captured;
}

/** Resolve every selected registration before any decoder can unregister or replace another. */
export function snapshotExternalSnapshotContextDecoders(request: ExternalSnapshotRequest) {
	return request.contexts.map(({ key, value }) => {
		const entry = contextCodecs.get(key);
		if (entry === undefined) throw new TypeError(formatClientError(338));
		return { ...entry, value };
	});
}

function validKey(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

export function validateExternalSnapshotAuthority(
	value: unknown,
): asserts value is ExternalSnapshotAuthority {
	if (
		value === null ||
		typeof value !== 'object' ||
		!validKey((value as ExternalSnapshotAuthority).publisherBuildId) ||
		(value as ExternalSnapshotAuthority).runtimeABI !== EXTERNAL_SNAPSHOT_ABI ||
		Object.keys(value).some((key) => key !== 'publisherBuildId' && key !== 'runtimeABI')
	)
		throw new TypeError(formatClientError(337));
}

/** Validate and take an immutable copy before any component or DOM adoption runs. */
export function decodeExternalSnapshotRequest(
	value: unknown,
	expectedAuthority?: ExternalSnapshotAuthority,
): ExternalSnapshotRequest {
	const input = snapshotExternalSnapshotRequest(value) as ExternalSnapshotRequest;
	if (
		input === null ||
		typeof input !== 'object' ||
		input.version !== 1 ||
		!validKey(input.documentId) ||
		!validKey(input.boundaryId) ||
		!validKey(input.ownerKey) ||
		!validKey(input.identifierPrefix) ||
		!Array.isArray(input.contexts) ||
		(input.nonce !== undefined && typeof input.nonce !== 'string') ||
		Object.keys(input).some(
			(key) =>
				![
					'version',
					'authority',
					'documentId',
					'boundaryId',
					'ownerKey',
					'identifierPrefix',
					'props',
					'contexts',
					'nonce',
				].includes(key),
		)
	)
		throw new TypeError(formatClientError(337));
	validateExternalSnapshotAuthority(input.authority);
	if (expectedAuthority !== undefined) {
		validateExternalSnapshotAuthority(expectedAuthority);
		if (
			input.authority.publisherBuildId !== expectedAuthority.publisherBuildId ||
			input.authority.runtimeABI !== expectedAuthority.runtimeABI
		)
			throw new TypeError(formatClientError(339));
	}
	if (
		input.ownerKey !== externalSnapshotOwnerKey(input.documentId, input.boundaryId) ||
		input.identifierPrefix !== input.boundaryId + '-external-'
	)
		throw new TypeError(formatClientError(339));
	decodeSignalValue(input.props);
	const keys = new Set<string>();
	for (const entry of input.contexts) {
		if (
			entry === null ||
			typeof entry !== 'object' ||
			!validKey(entry.key) ||
			keys.has(entry.key) ||
			Object.keys(entry).some((key) => key !== 'key' && key !== 'value')
		)
			throw new TypeError(formatClientError(338));
		decodeSignalValue(entry.value);
		keys.add(entry.key);
	}
	return input;
}

export function decodeExternalSnapshot(value: unknown): ExternalSnapshot {
	return snapshotExternalSnapshotResponse(value, decodeExternalSnapshotRequest) as ExternalSnapshot;
}

export function externalSnapshotOwnerKey(documentId: string, boundaryId: string): string {
	return JSON.stringify(['octane:external', documentId, boundaryId]);
}

export function createExternalSnapshotRequest(
	authority: ExternalSnapshotAuthority,
	documentId: string,
	boundaryId: string,
	props: unknown,
	contexts: ExternalSnapshotRequest['contexts'],
	nonce?: string,
): ExternalSnapshotRequest {
	return decodeExternalSnapshotRequest({
		version: 1,
		authority,
		documentId,
		boundaryId,
		ownerKey: externalSnapshotOwnerKey(documentId, boundaryId),
		identifierPrefix: boundaryId + '-external-',
		props: encodeSignalValue(props),
		contexts,
		...(nonce === undefined ? {} : { nonce }),
	});
}

export function assertExternalSnapshotRequest(
	actual: ExternalSnapshotRequest,
	expected: ExternalSnapshotRequest,
): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new TypeError(formatClientError(339));
}

export function serializeExternalSnapshotRequest(value: ExternalSnapshotRequest): string {
	return JSON.stringify(decodeExternalSnapshotRequest(value)).replace(/</g, '\\u003c');
}

export function serializeExternalSnapshot(value: ExternalSnapshot): string {
	return JSON.stringify(decodeExternalSnapshot(value)).replace(/</g, '\\u003c');
}
