import { formatClientError } from './error-codes.client.generated.js';
import {
	serverResultLimits,
	serverResultReader,
	ServerCallUncertainError,
	type ServerResultLimits,
} from './server-rpc-protocol.js';

/** A single-consumer result; iterator.return() cancels only this invocation. */
export async function readServerResult(
	response: Response,
	options: ServerResultLimits & { signal?: AbortSignal | undefined } = {},
): Promise<unknown> {
	if (response.body === null) throw new ServerCallUncertainError(new Error(formatClientError(370)));
	const limits = serverResultLimits(options);
	const reader = response.body.getReader();
	let finished = false;
	const read = serverResultReader(reader, limits, () => finished);
	let failure: unknown;
	const cleanup = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', abort);
	};
	const close = async () => {
		if (finished) return;
		finished = true;
		cleanup();
		// A custom transport may never finish cancellation. Retire now so an
		// error or iterator return cannot be held hostage by best-effort cleanup.
		try {
			void reader.cancel().catch(() => {});
		} catch {
			/* Already closed. */
		}
		reader.releaseLock();
	};
	const abort = () => {
		failure = new ServerCallUncertainError(
			options.signal?.reason ?? new DOMException(formatClientError(371), 'AbortError'),
		);
		void close();
	};
	const timer = setTimeout(() => {
		failure = new ServerCallUncertainError(
			new DOMException(formatClientError(365), 'TimeoutError'),
		);
		void close();
	}, limits.timeoutMs);
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	const next = async () => {
		if (failure !== undefined) throw failure;
		try {
			const frame = await read();
			if (failure !== undefined) throw failure;
			if (finished) return { kind: 'complete' } as const;
			if (frame.kind === 'error') throw new Error(frame.error);
			return frame;
		} catch (error) {
			// return() may retire a reader while a budget wait is pending. Check
			// before close() so a fresh protocol failure is never swallowed.
			if (finished && failure === undefined) return { kind: 'complete' } as const;
			await close();
			throw failure ?? new ServerCallUncertainError(error);
		}
	};
	try {
		const first = await next();
		if (first.kind === 'value') {
			if ((await next()).kind !== 'complete') throw new Error(formatClientError(372));
			await close();
			return first.value;
		}
		if (first.kind !== 'stream') throw new Error(formatClientError(373));
		let claimed = false;
		return {
			[Symbol.asyncIterator]() {
				if (claimed) throw new Error(formatClientError(374));
				claimed = true;
				let pulls: Promise<unknown> = Promise.resolve();
				const pull = async (): Promise<IteratorResult<unknown>> => {
					if (failure !== undefined) throw failure;
					if (finished) return { done: true, value: undefined };
					const frame = await next();
					if (frame.kind === 'value') return { done: false, value: frame.value };
					await close();
					if (frame.kind !== 'complete') throw new Error(formatClientError(375));
					return { done: true, value: undefined };
				};
				return {
					next(): Promise<IteratorResult<unknown>> {
						const result = pulls.then(pull, pull);
						pulls = result;
						return result;
					},
					async return(): Promise<IteratorResult<unknown>> {
						await close();
						return { done: true, value: undefined };
					},
				};
			},
		};
	} catch (error) {
		await close();
		throw error instanceof ServerCallUncertainError ? error : new ServerCallUncertainError(error);
	}
}
