import { decodeSignalValue } from '../data-encoding.js';
import { isContext } from '../context-identity.js';
import { formatServerError } from '../error-codes.server.generated.js';
import {
	decodeExternalSnapshotRequest,
	snapshotExternalSnapshotContextDecoders,
	validateExternalSnapshotAuthority,
	type ExternalSnapshotAuthority,
	type ExternalSnapshotRequest,
	type ExternalSnapshotContextReader,
} from '../external-snapshot-protocol.js';
import { retireSignalOwnerIdentity } from '../signals/owner-context.js';

export interface ExternalSnapshotRenderOptions {
	readonly authority: ExternalSnapshotAuthority;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onError?: (error: unknown) => void;
	/** Trusted endpoint-local providers, installed without adding component frames. */
	readonly initializeContexts?: (
		provide: <T>(context: Function & { readonly defaultValue: T }, value: T) => void,
	) => void;
}

declare const preparedBrand: unique symbol;
/** Opaque request lease. Its deadline spans native admission, module import and rendering. */
export interface PreparedExternalSnapshotRequest {
	readonly [preparedBrand]: true;
	readonly signal: AbortSignal;
}

interface Acquisition {
	value: unknown;
	dispose: (value: any) => void | PromiseLike<void>;
}
interface PreparedState {
	request: ExternalSnapshotRequest;
	props: unknown;
	options: ExternalSnapshotRenderOptions;
	contexts: Map<Function, unknown>;
	owner: { readonly scopeKey: string };
	controller: AbortController;
	signal: AbortSignal;
	timer: ReturnType<typeof setTimeout> | undefined;
	removeAbort: () => void;
	acquired: Acquisition[];
	closed: boolean;
	used: boolean;
	cleanup?: Promise<void>;
}
const preparedRequests = /* @__PURE__ */ new WeakMap<object, PreparedState>();
const CLEANUP_TIMEOUT_MS = 1000;

function stateOf(handle: PreparedExternalSnapshotRequest): PreparedState {
	const state =
		handle !== null && typeof handle === 'object' ? preparedRequests.get(handle) : undefined;
	if (state === undefined) throw new TypeError(formatServerError(343));
	return state;
}
function combinedFailure(errors: unknown[]): unknown {
	return errors.length === 1 ? errors[0] : new AggregateError(errors, formatServerError(351));
}
function report(state: PreparedState, error: unknown): void {
	try {
		if (state.options.onError !== undefined) state.options.onError(error);
		else console.error(error);
	} catch (diagnosticError) {
		console.error(new AggregateError([error, diagnosticError], formatServerError(351)));
	}
}

async function dispose(value: Acquisition): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.resolve().then(() => value.dispose(value.value)),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(formatServerError(344))), CLEANUP_TIMEOUT_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function close(state: PreparedState): Promise<void> {
	if (state.closed) return state.cleanup!;
	// Closing is synchronous: import/render and late decoder results cannot acquire
	// this lease while a disposer is awaiting its own work.
	state.closed = true;
	clearTimeout(state.timer);
	state.removeAbort();
	const acquired = state.acquired.splice(0).reverse();
	const errors: unknown[] = [];
	state.contexts.clear();
	state.props = undefined;
	state.request = undefined!;
	// Closed handles retain only cancellation/diagnostic/cleanup state, not the
	// endpoint initializer or its request transport graph.
	state.options = { authority: state.options.authority, onError: state.options.onError };
	state.cleanup = Promise.resolve().then(async () => {
		for (const value of acquired) {
			try {
				await dispose(value);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw combinedFailure(errors);
	});
	// Automatic cancellation may precede a caller's finally. Keep the same rejecting
	// cleanup promise for that caller while avoiding an unhandled rejection.
	state.cleanup.catch(() => {});
	// Cancellation and owner retirement can reenter release synchronously. Publish
	// the cleanup lease first, after detaching the admitted request graph.
	state.controller.abort();
	try {
		retireSignalOwnerIdentity(state.owner);
	} catch (error) {
		errors.push(error);
	}
	return state.cleanup;
}

export function releasePreparedExternalSnapshotRequest(
	handle: PreparedExternalSnapshotRequest,
): Promise<void> {
	return close(stateOf(handle));
}

export function claimPreparedExternalSnapshotRequest(handle: PreparedExternalSnapshotRequest) {
	const state = stateOf(handle);
	if (state.closed || state.used) throw new TypeError(formatServerError(343));
	state.signal.throwIfAborted();
	state.used = true;
	return state;
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) work.catch(() => {});
	signal.throwIfAborted();
	let remove: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				const aborted = () => reject(signal.reason);
				signal.addEventListener('abort', aborted, { once: true });
				remove = () => signal.removeEventListener('abort', aborted);
			}),
		]);
	} finally {
		remove?.();
	}
}

/** Internal scope callback is supplied by the native server renderer, not a transport. */
export async function prepareExternalSnapshotRequest(
	wire: unknown,
	options: ExternalSnapshotRenderOptions,
	initialize: (
		contexts: Map<Function, unknown>,
		callback: NonNullable<ExternalSnapshotRenderOptions['initializeContexts']>,
	) => void,
	defaultTimeoutMs: number,
): Promise<PreparedExternalSnapshotRequest> {
	const captured = Object.freeze({ ...options });
	validateExternalSnapshotAuthority(captured.authority);
	if (
		captured.timeoutMs !== undefined &&
		(!Number.isFinite(captured.timeoutMs) || captured.timeoutMs < 0)
	)
		throw new TypeError(formatServerError(337));
	const request = decodeExternalSnapshotRequest(wire, captured.authority);
	// Every registration is selected before decoder code can mutate the registry.
	const decoders = snapshotExternalSnapshotContextDecoders(request);
	const controller = new AbortController();
	const signal =
		captured.signal === undefined
			? controller.signal
			: AbortSignal.any([controller.signal, captured.signal]);
	const state: PreparedState = {
		request,
		props: decodeSignalValue(request.props),
		options: captured,
		contexts: new Map(),
		owner: Object.freeze({ scopeKey: request.ownerKey }),
		controller,
		signal,
		timer: undefined,
		removeAbort: () => {},
		acquired: [],
		closed: false,
		used: false,
	};
	const timeoutMs = captured.timeoutMs ?? defaultTimeoutMs;
	if (timeoutMs > 0)
		state.timer = setTimeout(() => controller.abort(new Error(formatServerError(342))), timeoutMs);
	const aborted = () => {
		close(state).catch((error) => report(state, error));
	};
	signal.addEventListener('abort', aborted, { once: true });
	state.removeAbort = () => signal.removeEventListener('abort', aborted);
	try {
		signal.throwIfAborted();
		const restoring = Promise.all(
			decoders.map(async ({ context, codec, value }) => {
				signal.throwIfAborted();
				const restored = await codec.decode(decodeSignalValue(value), signal);
				const acquisition =
					codec.dispose === undefined ? undefined : { value: restored, dispose: codec.dispose };
				if (state.closed || signal.aborted) {
					if (acquisition !== undefined)
						void dispose(acquisition).catch((error) => report(state, error));
					signal.throwIfAborted();
					throw new TypeError(formatServerError(343));
				}
				if (acquisition !== undefined) state.acquired.push(acquisition);
				state.contexts.set(context, restored);
			}),
		);
		await withAbort(restoring, signal);
		let validating = true;
		const readContext: ExternalSnapshotContextReader = (context) => {
			if (!validating || state.closed || !isContext(context))
				throw new TypeError(formatServerError(338));
			return state.contexts.has(context)
				? Object.freeze({ present: true, value: state.contexts.get(context) as any })
				: Object.freeze({ present: false });
		};
		try {
			for (const { context, codec } of decoders) {
				signal.throwIfAborted();
				if (codec.validate !== undefined)
					await withAbort(
						Promise.resolve().then(() =>
							codec.validate!(state.contexts.get(context), readContext, signal),
						),
						signal,
					);
			}
		} finally {
			validating = false;
		}
		if (captured.initializeContexts !== undefined)
			initialize(state.contexts, captured.initializeContexts);
		signal.throwIfAborted();
		const handle = Object.freeze({ signal }) as PreparedExternalSnapshotRequest;
		preparedRequests.set(handle, state);
		return handle;
	} catch (error) {
		try {
			await close(state);
		} catch (cleanupError) {
			throw combinedFailure([error, cleanupError]);
		}
		throw error;
	}
}

export async function preserveExternalSnapshotCleanup<T>(
	handle: PreparedExternalSnapshotRequest,
	render: () => Promise<T>,
): Promise<T> {
	let result: T;
	try {
		result = await render();
	} catch (error) {
		try {
			await releasePreparedExternalSnapshotRequest(handle);
		} catch (cleanupError) {
			throw combinedFailure([error, cleanupError]);
		}
		throw error;
	}
	await releasePreparedExternalSnapshotRequest(handle);
	return result;
}
