import { formatClientError } from './error-codes.client.generated.js';
import * as devalue from 'devalue';
import type { ServerCallOptions } from './server-call.js';
import {
	SERVER_RESULT_CONTENT_TYPE,
	ServerCallUncertainError,
	encodeServerArguments,
	serverResultLimits,
	type ServerResultLimits,
} from './server-rpc-protocol.js';
import { readServerResult } from './server-rpc-stream-client.js';
import { enqueueServerCall } from './server-rpc-batch-client.js';

// The native getter checks the AbortSignal brand across same-origin realms.
const signalAborted = /* @__PURE__ */ (() =>
	Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!)();

function isAbortSignal(signal: unknown): signal is AbortSignal {
	try {
		signalAborted.call(signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Compiler target for browser calls to a `module server` export.
 * @internal
 */
export function __serverRpc(
	hash: string,
	args: unknown[],
	options: ServerCallOptions = {},
	stream = false,
	limits?: ServerResultLimits,
): Promise<unknown> {
	return dispatchServerRpc(
		hash,
		args,
		options,
		stream,
		limits,
		stream ? encodeServerArguments : devalue.stringify,
		stream ? undefined : devalue.parse,
	);
}

/** @internal Compiler target when ServerCallContext proves the bounded protocol. */
export function __serverRpcStream(
	hash: string,
	args: unknown[],
	options: ServerCallOptions = {},
	limits?: ServerResultLimits,
): Promise<unknown> {
	return dispatchServerRpc(hash, args, options, true, limits, encodeServerArguments);
}

async function dispatchServerRpc(
	hash: string,
	args: unknown[],
	options: ServerCallOptions,
	stream: boolean,
	limits: ServerResultLimits | undefined,
	encode: (args: unknown[]) => string,
	decodeLegacy?: (body: string) => { value: unknown },
): Promise<unknown> {
	if (
		options === null ||
		typeof options !== 'object' ||
		Object.keys(options).some((key) => key !== 'signal') ||
		(options.signal !== undefined && !isAbortSignal(options.signal))
	)
		throw new TypeError(formatClientError(364));
	options.signal?.throwIfAborted();
	const resolvedLimits = stream ? serverResultLimits(limits) : undefined;
	// Encoding can fail (for example an unresolved Promise); never dispatch first.
	const payload = encode(args);
	if (stream && enqueueServerCall) {
		const batched = enqueueServerCall(hash, payload, options, limits);
		if (batched !== undefined) return batched;
	}
	const deadline = resolvedLimits === undefined ? undefined : Date.now() + resolvedLimits.timeoutMs;
	const cancellation = resolvedLimits === undefined ? undefined : new AbortController();
	const timer =
		resolvedLimits === undefined
			? undefined
			: setTimeout(() => {
					cancellation!.abort(new DOMException(formatClientError(365), 'TimeoutError'));
				}, resolvedLimits.timeoutMs);
	const signal =
		cancellation === undefined
			? options.signal
			: options.signal === undefined
				? cancellation.signal
				: AbortSignal.any([options.signal, cancellation.signal]);
	try {
		let response: Response;
		try {
			// An authored <base> must not redirect calls away from this page's server.
			response = await fetch(new URL('/_$_ripple_rpc_$_/' + hash, globalThis.location.href).href, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(stream ? { Accept: SERVER_RESULT_CONTENT_TYPE } : {}),
				},
				body: payload,
				signal: signal ?? null,
			});
		} catch (cause) {
			throw new ServerCallUncertainError(new Error(formatClientError(366), { cause }));
		}

		if (!response.ok) {
			let message = formatClientError(367, response.status);
			// Unframed HTTP error bodies have no result budget or completion
			// contract. In the bounded protocol, status/outcome are sufficient;
			// cleanup cannot delay settlement or expose private server diagnostics.
			let body = '';
			if (stream) {
				try {
					void response.body?.cancel().catch(() => {});
				} catch {
					/* Preserve the authoritative HTTP outcome. */
				}
			} else {
				body = await response.text().catch(() => '');
			}
			if (body) {
				try {
					const parsed = JSON.parse(body);
					message = typeof parsed?.error === 'string' && parsed.error ? parsed.error : body;
				} catch {
					message = body;
				}
			}
			const error = Object.assign(new Error(message), { status: response.status });
			throw response.headers.get('Octane-RPC-Outcome') === 'rejected'
				? error
				: new ServerCallUncertainError(error);
		}
		if (stream) {
			if (response.headers.get('content-type')?.split(';', 1)[0] !== SERVER_RESULT_CONTENT_TYPE) {
				void response.body?.cancel().catch(() => {});
				throw new ServerCallUncertainError(new Error(formatClientError(368)));
			}
			const remaining = deadline! - Date.now();
			if (remaining <= 0) {
				void response.body?.cancel().catch(() => {});
				throw new ServerCallUncertainError(
					new DOMException(formatClientError(365), 'TimeoutError'),
				);
			}
			// The reader inherits the same absolute deadline. For a returned iterable,
			// it retains the remaining timer after this first-frame call completes.
			return await readServerResult(response, { ...resolvedLimits, timeoutMs: remaining, signal });
		}

		let body: string;
		try {
			body = await response.text();
		} catch (error) {
			throw new ServerCallUncertainError(error);
		}
		if (body === '') {
			throw new ServerCallUncertainError(new Error(formatClientError(369)));
		}
		try {
			return decodeLegacy!(body).value;
		} catch (error) {
			throw new ServerCallUncertainError(error);
		}
	} finally {
		clearTimeout(timer);
	}
}
