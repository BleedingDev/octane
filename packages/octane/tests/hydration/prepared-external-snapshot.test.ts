import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Server from 'octane/server';
import { createContext } from '../../src/universal-native.js';
import {
	createExternalSnapshotRequest,
	captureExternalSnapshotContexts,
} from '../../src/external-snapshot-protocol.js';
import { deferred } from '../_server-stream.js';

const authority = { publisherBuildId: 'prepared-publisher', runtimeABI: 1 as const };
const First = createContext('first default');
const Second = createContext('second default');
const Third = createContext('third default');
const unregister: (() => void)[] = [];
afterEach(() => {
	for (const release of unregister.splice(0)) release();
});

function register(context, key, decode, dispose?, validate?) {
	unregister.push(
		Server.registerExternalSnapshotContext(context, {
			key,
			encode: (value) => value,
			decode,
			dispose,
			validate,
		}),
	);
}
function request(keys: string[] = [], props: unknown = { label: 'owned props' }) {
	return createExternalSnapshotRequest(
		authority,
		'prepared-document',
		'boundary',
		props,
		captureExternalSnapshotContexts(
			new Map([
				[First, 'first host'],
				[Second, 'second host'],
				[Third, 'third host'],
			]),
			keys,
		),
	);
}

describe('prepared external publisher requests', () => {
	it('validates only after all selected contexts decode and exposes their physical presence', async () => {
		const pending = deferred<string>();
		const validate = vi.fn((value, readContext) => {
			expect(value).toBe('first host');
			expect(readContext(First)).toEqual({ present: true, value: 'first host' });
			expect(readContext(Second)).toEqual({ present: true, value: 'restored second' });
			expect(readContext(Third)).toEqual({ present: false });
			expect(Object.isFrozen(readContext(Second))).toBe(true);
		});
		register(First, 'first', String, undefined, validate);
		register(Second, 'second', () => pending.promise);
		const preparing = Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
			authority,
		});
		await Promise.resolve();
		expect(validate).not.toHaveBeenCalled();
		pending.resolve('restored second');
		const prepared = await preparing;
		expect(validate).toHaveBeenCalledTimes(1);
		await Server.releasePreparedExternalSnapshotRequest(prepared);
	});

	it.each(['sync', 'async'])(
		'rejects a %s sibling-context validation before import and disposes every decoded value',
		async (mode) => {
			const disposed: string[] = [];
			const load = vi.fn();
			const validate = (value, readContext) => {
				expect(readContext(Second)).toEqual({ present: true, value: 'second host' });
				if (mode === 'async') return Promise.reject(new Error('invalid sibling context'));
				throw new Error('invalid sibling context');
			};
			register(First, 'first', String, (value) => disposed.push(value), validate);
			register(Second, 'second', String, (value) => disposed.push(value));
			await expect(
				Server.prepareExternalSnapshotRequest(request(['first', 'second']), { authority }).then(
					load,
				),
			).rejects.toThrow('invalid sibling context');
			expect(load).not.toHaveBeenCalled();
			expect(disposed).toEqual(['second host', 'first host']);
		},
	);

	it('keeps cancellation and selected cleanup active while an asynchronous validator waits', async () => {
		const pending = deferred<void>();
		const controller = new AbortController();
		const disposed: string[] = [];
		let lateRead: (() => unknown) | undefined;
		const started = deferred<void>();
		register(
			First,
			'first',
			String,
			(value) => disposed.push(value),
			async (value, readContext) => {
				lateRead = () => readContext(First);
				started.resolve();
				await pending.promise;
			},
		);
		const preparing = Server.prepareExternalSnapshotRequest(request(['first']), {
			authority,
			signal: controller.signal,
		});
		const rejected = expect(preparing).rejects.toThrow('validation canceled');
		await started.promise;
		controller.abort(new Error('validation canceled'));
		await rejected;
		expect(disposed).toEqual(['first host']);
		expect(() => lateRead!()).toThrow();
		pending.resolve();
		await Promise.resolve();
	});

	it('captures validator callbacks at registration and rejects non-context reader keys', async () => {
		const validate = vi.fn((value, readContext) => {
			expect(() => readContext(() => {})).toThrow();
		});
		const codec = { key: 'first', encode: String, decode: String, validate };
		unregister.push(Server.registerExternalSnapshotContext(First, codec));
		codec.validate = () => {
			throw new Error('mutated validator');
		};
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first']), { authority });
		expect(validate).toHaveBeenCalledTimes(1);
		await Server.releasePreparedExternalSnapshotRequest(prepared);
	});

	it('restores contexts before expose import and disposes them after an import failure', async () => {
		const disposed: string[] = [];
		register(
			First,
			'first',
			(value) => String(value),
			(value) => disposed.push(value),
		);
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first']), { authority });
		const load = vi.fn(() => {
			throw new Error('import failed');
		});
		try {
			expect(() => load()).toThrow('import failed');
		} finally {
			await Server.releasePreparedExternalSnapshotRequest(prepared);
		}
		expect(disposed).toEqual(['first host']);
		expect(prepared.signal.aborted).toBe(true);
		await Server.releasePreparedExternalSnapshotRequest(prepared);
		expect(disposed).toEqual(['first host']);
	});

	it('claims one genuine handle and rejects copies, concurrent use, reuse and released handles', async () => {
		const component = vi.fn((props) => Server.createElement('p', { children: props.label }));
		const prepared = await Server.prepareExternalSnapshotRequest(request(), { authority });
		await expect(Server.renderExternalSnapshot(component, { ...prepared })).rejects.toThrow();
		const rendering = Server.renderExternalSnapshot(component, prepared);
		await expect(Server.renderExternalSnapshot(component, prepared)).rejects.toThrow();
		expect((await rendering).html).toContain('owned props');
		await expect(Server.renderExternalSnapshot(component, prepared)).rejects.toThrow();
		await Server.releasePreparedExternalSnapshotRequest(prepared);
		const released = await Server.prepareExternalSnapshotRequest(request(), { authority });
		await Server.releasePreparedExternalSnapshotRequest(released);
		await expect(Server.renderExternalSnapshot(component, released)).rejects.toThrow();
		expect(component).toHaveBeenCalledTimes(1);
	});

	it('lets a synchronous abort observer await the already-owned cleanup', async () => {
		const cleanup = deferred<void>();
		const disposed: string[] = [];
		register(First, 'first', String, async (value) => {
			disposed.push(value);
			await cleanup.promise;
		});
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first']), { authority });
		let nested: Promise<void> | undefined;
		let nestedFinished = false;
		prepared.signal.addEventListener('abort', () => {
			nested = Server.releasePreparedExternalSnapshotRequest(prepared);
			nested?.then(() => {
				nestedFinished = true;
			});
		});
		const release = Server.releasePreparedExternalSnapshotRequest(prepared);
		try {
			expect(nested).toBeInstanceOf(Promise);
			await Promise.resolve();
			expect(nestedFinished).toBe(false);
		} finally {
			cleanup.resolve();
			await release;
		}
		await nested;
		expect(nestedFinished).toBe(true);
		expect(disposed).toEqual(['first host']);
	});

	it('closes before awaiting cleanup and attempts LIFO cleanup despite disposer errors', async () => {
		const calls: string[] = [];
		const cleanup = deferred<void>();
		register(First, 'first', String, (value) => {
			calls.push(value);
			throw new Error('first cleanup');
		});
		register(Second, 'second', String, async (value) => {
			calls.push(value);
			await cleanup.promise;
			throw new Error('second cleanup');
		});
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
			authority,
		});
		const release = Server.releasePreparedExternalSnapshotRequest(prepared);
		const rejected = expect(release).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: 'second cleanup' }),
				expect.objectContaining({ message: 'first cleanup' }),
			],
		});
		expect(prepared.signal.aborted).toBe(true);
		await expect(
			Server.renderExternalSnapshot(() => 'must not execute', prepared),
		).rejects.toThrow();
		cleanup.resolve();
		await rejected;
		expect(calls).toEqual(['second host', 'first host']);
	});

	it('releases acquired values on partial decode failure and disposes a late value once', async () => {
		const pending = deferred<string>();
		const disposed: string[] = [];
		register(
			First,
			'first',
			() => pending.promise,
			(value) => disposed.push(value),
		);
		register(
			Second,
			'second',
			() => {
				throw new Error('restore failed');
			},
			(value) => disposed.push(value),
		);
		await expect(
			Server.prepareExternalSnapshotRequest(request(['first', 'second']), { authority }),
		).rejects.toThrow('restore failed');
		pending.resolve('late restored value');
		await vi.waitFor(() => expect(disposed).toEqual(['late restored value']));
	});

	it('disposes successful earlier decodes when a later selected decoder fails', async () => {
		const failed = deferred<string>();
		const disposed: string[] = [];
		register(First, 'first', String, (value) => {
			disposed.push(value);
		});
		register(
			Second,
			'second',
			() => failed.promise,
			(value) => {
				disposed.push(value);
			},
		);
		const preparing = Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
			authority,
		});
		const rejected = expect(preparing).rejects.toThrow('restore failed');
		await Promise.resolve();
		failed.reject(new Error('restore failed'));
		await rejected;
		expect(disposed).toEqual(['first host']);
	});

	it('cancels pending reconstruction and reports a late disposer failure without executing an expose', async () => {
		const pending = deferred<string>();
		const controller = new AbortController();
		const errors: unknown[] = [];
		register(
			First,
			'first',
			() => pending.promise,
			() => {
				throw new Error('late cleanup failed');
			},
		);
		const preparing = Server.prepareExternalSnapshotRequest(request(['first']), {
			authority,
			signal: controller.signal,
			onError: (error) => {
				errors.push(error);
			},
		});
		const rejected = expect(preparing).rejects.toThrow('caller canceled');
		controller.abort(new Error('caller canceled'));
		await rejected;
		pending.resolve('late value');
		await vi.waitFor(() => expect(errors).toMatchObject([{ message: 'late cleanup failed' }]));
	});

	it('handles a decoder that synchronously cancels its request and then rejects', async () => {
		const controller = new AbortController();
		register(First, 'first', () => {
			controller.abort(new Error('decoder canceled'));
			return Promise.reject(new Error('decoder rejected'));
		});
		register(Second, 'second', String);
		await expect(
			Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
				authority,
				signal: controller.signal,
			}),
		).rejects.toThrow('decoder canceled');
		await Promise.resolve();
	});

	it('captures every selected codec before decoder code replaces a registration', async () => {
		const disposed: string[] = [];
		const secondDispose = vi.fn((value) => {
			disposed.push(value);
		});
		const secondDecode = vi.fn(String);
		const releaseSecond = Server.registerExternalSnapshotContext(Second, {
			key: 'second',
			encode: String,
			decode: secondDecode,
			dispose: secondDispose,
		});
		unregister.push(releaseSecond);
		register(First, 'first', (value) => {
			releaseSecond();
			return String(value);
		});
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
			authority,
		});
		expect(secondDecode).toHaveBeenCalledWith('second host', prepared.signal);
		await Server.releasePreparedExternalSnapshotRequest(prepared);
		expect(disposed).toEqual(['second host']);
	});

	it('bounds cleanup when a context disposer never settles and attempts remaining disposers', async () => {
		const disposed: string[] = [];
		register(First, 'first', String, (value) => {
			disposed.push(value);
		});
		register(Second, 'second', String, () => new Promise(() => {}));
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first', 'second']), {
			authority,
		});
		vi.useFakeTimers();
		try {
			const release = Server.releasePreparedExternalSnapshotRequest(prepared);
			const rejected = expect(release).rejects.toThrow();
			await vi.advanceTimersByTimeAsync(1001);
			await rejected;
			expect(disposed).toEqual(['first host']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('restores ambient context when an initializer throws or returns a thenable', async () => {
		for (const initializeContexts of [
			() => {
				throw new Error('initializer failed');
			},
			async (provide) => {
				provide(First, 'temporary');
			},
		]) {
			await expect(
				Server.prepareExternalSnapshotRequest(request(), { authority, initializeContexts }),
			).rejects.toThrow();
			expect(Server.useContext(First)).toBe('first default');
		}
		const prepared = await Server.prepareExternalSnapshotRequest(request(), { authority });
		expect(
			(
				await Server.renderExternalSnapshot(
					() => Server.createElement('p', { children: Server.useContext(First) }),
					prepared,
				)
			).html,
		).toContain('first default');
		await Server.releasePreparedExternalSnapshotRequest(prepared);
	});

	it('keeps the preparation deadline active through import and rejects a late render', async () => {
		const disposed: string[] = [];
		register(First, 'first', String, (value) => disposed.push(value));
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first']), {
			authority,
			timeoutMs: 20,
		});
		await vi.waitFor(() => expect(prepared.signal.aborted).toBe(true));
		const component = vi.fn(() => 'must not execute');
		await expect(Server.renderExternalSnapshot(component, prepared)).rejects.toThrow();
		await Server.releasePreparedExternalSnapshotRequest(prepared);
		expect(component).not.toHaveBeenCalled();
		expect(disposed).toEqual(['first host']);
	});

	it('installs endpoint providers under a real native context scope without component frames', async () => {
		register(First, 'first', String);
		let observed: string | undefined;
		let lateProvide: (() => void) | undefined;
		const options = {
			authority,
			initializeContexts(provide) {
				observed = Server.useContext(First);
				provide(Second, observed + ' local');
				expect(Server.useContext(Second)).toBe('first host local');
				lateProvide = () => provide(Second, 'late');
			},
		};
		const prepared = await Server.prepareExternalSnapshotRequest(request(['first']), options);
		options.initializeContexts = () => {
			throw new Error('mutated callback');
		};
		expect(observed).toBe('first host');
		expect(() => lateProvide!()).toThrow();
		const result = await Server.renderExternalSnapshot(
			() => Server.createElement('p', { children: Server.useContext(Second) }),
			prepared,
		);
		expect(result.html).toContain('first host local');
		await Server.releasePreparedExternalSnapshotRequest(prepared);
		expect(Server.useContext(Second)).toBe('second default');
	});

	it('preserves render and cleanup failures on the original producer API', async () => {
		register(First, 'first', String, () => {
			throw new Error('cleanup failed');
		});
		const rendering = Server.renderExternalSnapshot(
			() => {
				throw new Error('render failed');
			},
			request(['first']),
			{ authority },
		);
		await expect(rendering).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: 'render failed' }),
				expect.objectContaining({ message: 'cleanup failed' }),
			],
		});
	});
});

describe('bounded native request admission', () => {
	it.each(['object', 'wire'])(
		'rejects excessive encoded depth before restoring contexts from %s',
		async (mode) => {
			const decode = vi.fn(String);
			register(First, 'first', decode);
			const original = request(['first']);
			let encoded: unknown = ['null'];
			for (let i = 0; i < 65; i++) encoded = ['array', [encoded]];
			const input = { ...original, props: encoded };
			await expect(
				Server.prepareExternalSnapshotRequest(mode === 'wire' ? JSON.stringify(input) : input, {
					authority,
				}),
			).rejects.toThrow();
			expect(decode).not.toHaveBeenCalled();
		},
	);
	it('rejects excessive nodes and aggregate strings shared across props and contexts', async () => {
		const decode = vi.fn(String);
		register(First, 'first', decode);
		const original = request(['first']);
		for (const props of [
			['array', Array.from({ length: 100001 }, () => ['null'])],
			['string', 'x'.repeat(1024 * 1024 + 1)],
		]) {
			await expect(
				Server.prepareExternalSnapshotRequest({ ...original, props }, { authority }),
			).rejects.toThrow();
		}
		const large = ['string', 'x'.repeat(1024 * 1024)];
		await expect(
			Server.prepareExternalSnapshotRequest(
				{
					...original,
					props: ['array', Array.from({ length: 5 }, () => large)],
					contexts: [{ key: 'first', value: ['array', Array.from({ length: 4 }, () => large)] }],
				},
				{ authority },
			),
		).rejects.toThrow();
		expect(decode).not.toHaveBeenCalled();
	});
	it('rejects getters without evaluating them', async () => {
		const getter = vi.fn(() => ['null']);
		const input = { ...request() };
		Object.defineProperty(input, 'props', { enumerable: true, get: getter });
		await expect(Server.prepareExternalSnapshotRequest(input, { authority })).rejects.toThrow();
		expect(getter).not.toHaveBeenCalled();
	});
});
