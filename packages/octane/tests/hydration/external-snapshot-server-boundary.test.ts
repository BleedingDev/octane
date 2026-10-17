import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Server from 'octane/server';
import { prerender } from 'octane/static';
import type { ExternalSnapshot, ExternalSnapshotRequest } from 'octane/server';
import {
	SnapshotHost,
	SnapshotStreamingHost,
	createNestedSnapshotRemote,
	SnapshotPair,
	SnapshotPlain,
	SnapshotRemote,
	SnapshotTheme,
} from '../_fixtures/external-snapshot-server-boundary.tsrx';
import { collectReadableStream, deferred } from '../_server-stream.js';

const authority = { publisherBuildId: 'boundary-publisher', runtimeABI: 1 as const };
const releases: Array<() => void> = [];
afterEach(() => {
	for (const release of releases.splice(0)) release();
});
function registerTheme(dispose = vi.fn()) {
	releases.push(
		Server.registerExternalSnapshotContext(SnapshotTheme, {
			key: 'boundary-theme',
			encode: String,
			decode: String,
			dispose,
		}),
	);
	return dispose;
}
async function transport(
	request: ExternalSnapshotRequest,
	signal?: AbortSignal,
	component = SnapshotRemote,
	publisher = authority,
) {
	const prepared = await Server.prepareExternalSnapshotRequest(
		Server.serializeExternalSnapshotRequest(request),
		{ authority: publisher, signal },
	);
	try {
		const snapshot = await Server.renderExternalSnapshot(component, prepared);
		return Server.decodeExternalSnapshot(Server.serializeExternalSnapshot(snapshot));
	} finally {
		await Server.releasePreparedExternalSnapshotRequest(prepared);
	}
}
function boundary(snapshot = transport, options = {}) {
	return Server.externalSnapshotBoundary({
		authority,
		snapshot,
		component: SnapshotRemote,
		contextKeys: ['boundary-theme'],
		...options,
	});
}
const documentOptions = { externalSnapshots: { documentId: 'host-document' } };

describe('native server external snapshot boundaries', () => {
	it('renders a transported compiled publisher with selected host context, CSS, head and isolated IDs', async () => {
		const dispose = registerTheme();
		const requests: ExternalSnapshotRequest[] = [];
		const signals: AbortSignal[] = [];
		const Boundary = boundary((request, signal) => {
			requests.push(request);
			signals.push(signal!);
			return transport(request, signal);
		});
		const result = await prerender(
			SnapshotHost,
			{ Boundary, label: 'Remote product' },
			{
				...documentOptions,
				identifierPrefix: 'host-',
				nonce: 'host-nonce',
			},
		);
		expect(result.html).toContain('Remote product');
		expect(result.html).toContain('host theme');
		expect(result.html).toContain('<title>Remote product</title>');
		expect(result.html).not.toContain('Waiting for publisher');
		expect(result.css).toContain('rebeccapurple');
		expect(result.css).toContain('nonce="host-nonce"');
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.documentId).toBe('host-document');
			expect(request.nonce).toBe('host-nonce');
			expect(request.contexts.map(({ key }) => key)).toEqual(['boundary-theme']);
		}
		const ids = [...result.html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(dispose).toHaveBeenCalled();
		for (const signal of signals) expect(signal.aborted).toBe(true);
	});

	it('keeps independent sibling requests and releases every reconstructed publisher context', async () => {
		const disposed: string[] = [];
		registerTheme(vi.fn((value) => disposed.push(value)));
		const requests: ExternalSnapshotRequest[] = [];
		const result = await prerender(
			SnapshotPair,
			{
				Boundary: boundary((request, signal) => {
					requests.push(request);
					return transport(request, signal);
				}),
			},
			documentOptions,
		);
		expect(result.html).toContain('first publisher');
		expect(result.html).toContain('second publisher');
		expect(new Set(requests.map((request) => request.ownerKey)).size).toBe(2);
		expect(new Set(requests.map((request) => request.identifierPrefix)).size).toBe(2);
		expect(disposed).toEqual(['pair theme', 'pair theme']);
	});

	it('preserves ordinary native server rendering without external document authority', () => {
		const result = Server.renderToStaticMarkup(SnapshotPlain);
		expect(result.html).toBe('<p>Plain native SSR</p>');
		expect(result.css).toBe('');
	});

	it.each([undefined, { documentId: '' }, { documentId: 7 }])(
		'rejects missing or invalid document authority before transport',
		async (externalSnapshots) => {
			registerTheme();
			const snapshot = vi.fn(transport);
			await expect(
				prerender(
					SnapshotHost,
					{ Boundary: boundary(snapshot), label: 'Rejected' },
					{ externalSnapshots },
				),
			).rejects.toThrow();
			expect(snapshot).not.toHaveBeenCalled();
		},
	);

	it('rejects a conflicting stream document before transport', async () => {
		registerTheme();
		const snapshot = vi.fn(transport);
		await expect(
			prerender(
				SnapshotHost,
				{ Boundary: boundary(snapshot), label: 'Rejected' },
				{
					...documentOptions,
					streamedSignals: { buildId: 'host-build', documentId: 'other-document' },
				},
			),
		).rejects.toThrow();
		expect(snapshot).not.toHaveBeenCalled();
	});

	it('rejects mismatched response identity and aborts its transport lease', async () => {
		registerTheme();
		const signals: AbortSignal[] = [];
		const Boundary = boundary(async (request, signal) => {
			signals.push(signal!);
			const snapshot = await transport(request, signal);
			return { ...snapshot, request: { ...snapshot.request, documentId: 'foreign-document' } };
		});
		await expect(
			prerender(SnapshotHost, { Boundary, label: 'Rejected' }, documentOptions),
		).rejects.toThrow();
		expect(signals.length).toBeGreaterThan(0);
		for (const signal of signals) expect(signal.aborted).toBe(true);
	});

	it('aborts a transport that ignores request cancellation and keeps the original reason', async () => {
		registerTheme();
		const started = deferred<void>();
		const pending = deferred<ExternalSnapshot>();
		const signals: AbortSignal[] = [];
		const Boundary = boundary((_request, signal) => {
			signals.push(signal!);
			started.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const reason = new Error('client disconnected');
		const rendering = prerender(
			SnapshotHost,
			{ Boundary, label: 'Cancelled' },
			{ ...documentOptions, signal: controller.signal },
		);
		const rejected = expect(rendering).rejects.toBe(reason);
		await started.promise;
		controller.abort(reason);
		await rejected;
		for (const signal of signals) expect(signal.reason).toBe(reason);
		pending.reject(new Error('late abandoned transport failure'));
		await Promise.resolve();
	});

	it('bounds an uncooperative publisher with its boundary deadline', async () => {
		registerTheme();
		const pending = deferred<ExternalSnapshot>();
		const signals: AbortSignal[] = [];
		const Boundary = boundary(
			(_request, signal) => {
				signals.push(signal!);
				return pending.promise;
			},
			{ timeoutMs: 10 },
		);
		await expect(
			prerender(SnapshotHost, { Boundary, label: 'Timed out' }, documentOptions),
		).rejects.toThrow(/boundary deadline/);
		for (const signal of signals) expect(signal.aborted).toBe(true);
		pending.reject(new Error('late publisher timeout'));
		await Promise.resolve();
	});
	it('preserves the trusted document and selected context through nested publishers', async () => {
		const dispose = registerTheme();
		const requests: ExternalSnapshotRequest[] = [];
		const nestedAuthority = { publisherBuildId: 'nested-publisher', runtimeABI: 1 as const };
		const Child = boundary(
			(request, signal) => {
				requests.push(request);
				return transport(request, signal, SnapshotRemote, nestedAuthority);
			},
			{ authority: nestedAuthority },
		);
		const Parent = createNestedSnapshotRemote(Child);
		const Boundary = boundary((request, signal) => {
			requests.push(request);
			return transport(request, signal, Parent);
		});
		const result = await prerender(
			SnapshotHost,
			{ Boundary, label: 'Outer publisher' },
			documentOptions,
		);
		expect(result.html).toContain('Outer publisher');
		expect(result.html).toContain('Nested publisher');
		expect(result.html).toContain('host theme');
		expect(requests.map((request) => request.documentId)).toEqual([
			'host-document',
			'host-document',
		]);
		expect(new Set(requests.map((request) => request.ownerKey)).size).toBe(2);
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it('isolates concurrent host renders and releases each transport with its owning request', async () => {
		registerTheme();
		const gates = [deferred<void>(), deferred<void>()];
		const started = deferred<void>();
		const requests: ExternalSnapshotRequest[] = [];
		const signals = new Map<string, AbortSignal>();
		const Boundary = boundary(async (request, signal) => {
			requests.push(request);
			signals.set(request.documentId, signal!);
			if (signals.size === 2) started.resolve();
			await gates[request.documentId === 'first-document' ? 0 : 1].promise;
			return transport(request, signal);
		});
		const first = prerender(
			SnapshotHost,
			{ Boundary, label: 'First result', theme: 'first theme' },
			{ externalSnapshots: { documentId: 'first-document' } },
		);
		const second = prerender(
			SnapshotHost,
			{ Boundary, label: 'Second result', theme: 'second theme' },
			{ externalSnapshots: { documentId: 'second-document' } },
		);
		await started.promise;
		gates[1].resolve();
		const secondResult = await second;
		expect(secondResult.html).toContain('second theme');
		expect(secondResult.html).not.toContain('First result');
		expect(signals.get('second-document')!.aborted).toBe(true);
		expect(signals.get('first-document')!.aborted).toBe(false);
		gates[0].resolve();
		const firstResult = await first;
		expect(firstResult.html).toContain('first theme');
		expect(firstResult.html).not.toContain('Second result');
		expect(signals.get('first-document')!.aborted).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it('streams late resources while replacing the provisional namespace with one live transport lease', async () => {
		registerTheme();
		const gate = deferred<void>();
		const requests: ExternalSnapshotRequest[] = [];
		const signals: AbortSignal[] = [];
		let active = 0;
		let maximumActive = 0;
		const Boundary = boundary(async (request, signal) => {
			requests.push(request);
			signals.push(signal!);
			maximumActive = Math.max(maximumActive, ++active);
			signal!.addEventListener('abort', () => active--, { once: true });
			await gate.promise;
			return transport(request, signal);
		});
		const stream = await Server.renderToReadableStream(
			SnapshotStreamingHost,
			{ Boundary, label: 'Streamed publisher' },
			documentOptions,
		);
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const shell = await reader.read();
		expect(decoder.decode(shell.value)).toContain('Waiting for publisher');
		gate.resolve();
		let html = decoder.decode(shell.value);
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			html += decoder.decode(chunk.value);
		}
		await stream.allReady;
		expect(html).toContain('Streamed publisher');
		expect(html).toContain('stream theme');
		expect(html).toContain('rebeccapurple');
		expect(requests).toHaveLength(2);
		expect(new Set(requests.map((request) => request.boundaryId)).size).toBe(2);
		expect(maximumActive).toBe(1);
		expect(active).toBe(0);
		for (const signal of signals) expect(signal.aborted).toBe(true);
	});

	it('reports a streamed publisher failure and preserves its native fallback', async () => {
		registerTheme();
		const reason = new Error('publisher unavailable');
		const signals: AbortSignal[] = [];
		const Boundary = boundary((_request, signal) => {
			signals.push(signal!);
			return Promise.reject(reason);
		});
		const result = await collectReadableStream(
			SnapshotStreamingHost,
			{ Boundary, label: 'Unavailable' },
			documentOptions,
		);
		expect(result.html).toContain('Waiting for publisher');
		expect(result.html).not.toContain('<article');
		expect(result.errors).toContain(reason);
		for (const signal of signals) expect(signal.aborted).toBe(true);
	});

	it('releases an abandoned stream transport and observes a late publisher rejection', async () => {
		registerTheme();
		const pending = deferred<ExternalSnapshot>();
		const signals: AbortSignal[] = [];
		const Boundary = boundary((_request, signal) => {
			signals.push(signal!);
			return pending.promise;
		});
		const stream = await Server.renderToReadableStream(
			SnapshotStreamingHost,
			{ Boundary, label: 'Abandoned' },
			documentOptions,
		);
		const ready = stream.allReady.catch(() => {});
		const reader = stream.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain(
			'Waiting for publisher',
		);
		await reader.cancel(new Error('reader closed'));
		await ready;
		expect(signals).toHaveLength(1);
		expect(signals[0].aborted).toBe(true);
		pending.reject(new Error('abandoned publisher failed'));
		await Promise.resolve();
	});
});
