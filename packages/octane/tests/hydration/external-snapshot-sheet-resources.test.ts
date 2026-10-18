import { describe, expect, it } from 'vitest';
import * as Server from 'octane/server';
import { prerender } from 'octane/static';
import type { ExternalSnapshot, ExternalSnapshotRequest } from 'octane/server';
import { loadServerFixture } from '../_server-fixture.js';
import { activateStreamedMarkup, deferred, resetStreamRuntimeGlobals } from '../_server-stream.js';

const {
	ResourceRemote,
	ResourceGroupedRemote,
	ResourceGroupedHost,
	createPendingResourceRemote,
	createResourceParent,
	ResourceHost,
	ResourceInlineHost,
	ResourcePair,
	ResourceStreamingHost,
} = loadServerFixture<typeof import('../_fixtures/external-snapshot-sheet-resources.tsrx')>(
	'packages/octane/tests/_fixtures/external-snapshot-sheet-resources.tsrx',
	{
		compileOptions: {
			dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod',
			hmr: false,
		},
	},
);
const authority = {
	publisherBuildId: 'resource-publisher',
	runtimeABI: 1 as const,
};
const nonce = 'host-resource-nonce';
const options = {
	externalSnapshots: { documentId: 'resource-document' },
	nonce,
};

async function transport(
	request: ExternalSnapshotRequest,
	signal: AbortSignal | undefined,
	component = ResourceRemote,
	publisher = authority,
): Promise<ExternalSnapshot> {
	const prepared = await Server.prepareExternalSnapshotRequest(request, {
		authority: publisher,
		signal,
	});
	try {
		return Server.decodeExternalSnapshot(
			Server.serializeExternalSnapshot(await Server.renderExternalSnapshot(component, prepared)),
		);
	} finally {
		await Server.releasePreparedExternalSnapshotRequest(prepared);
	}
}
function boundary(
	component = ResourceRemote,
	publisher = authority,
	snapshot = (request: ExternalSnapshotRequest, signal?: AbortSignal) =>
		transport(request, signal, component, publisher),
) {
	return Server.externalSnapshotBoundary({
		authority: publisher,
		component,
		snapshot,
	});
}
function documentOf(html: string) {
	return new DOMParser().parseFromString(html, 'text/html');
}
function oneResource(document: Document, href: string) {
	const resources = [
		...document.querySelectorAll('link[rel="stylesheet"],style[data-href]'),
	].filter(
		(element) => (element.getAttribute('href') ?? element.getAttribute('data-href')) === href,
	);
	expect(resources).toHaveLength(1);
	return resources[0]!;
}

describe('external snapshot native sheet resources', () => {
	it('deduplicates nested and direct sheets by href while retaining residual metadata', async () => {
		const snapshots: ExternalSnapshot[] = [];
		const nestedAuthority = {
			publisherBuildId: 'nested-resource-publisher',
			runtimeABI: 1 as const,
		};
		const Child = boundary(ResourceRemote, nestedAuthority);
		const Parent = createResourceParent(Child);
		const Boundary = boundary(Parent, authority, async (request, signal) => {
			const snapshot = await transport(request, signal, Parent);
			snapshots.push(snapshot);
			return snapshot;
		});
		for (const documentId of ['resource-document', 'second-resource-document']) {
			const result = await prerender(
				ResourceHost,
				{ Boundary, nonce },
				{
					...options,
					externalSnapshots: { documentId },
				},
			);
			const document = documentOf(result.html);
			expect(oneResource(document, '/shared.css').getAttribute('data-precedence')).toBe('host');
			expect(oneResource(document, '/shared.css').getAttribute('nonce')).toBe(nonce);
			for (const href of ['/remote.css', '/nested.css', '/inline.css']) {
				expect(oneResource(document, href).getAttribute('nonce')).toBe(nonce);
			}
			expect(oneResource(document, '/inline.css').textContent).toContain('rebeccapurple');
			expect(
				document.querySelector('[data-parent] [data-resource="nested"]')?.textContent,
			).toContain('nested');
			expect(document.querySelector('title')?.textContent).toBe('nested');
		}
		for (const snapshot of snapshots) {
			expect(snapshot.head).toContain('<title>nested</title>');
			expect(snapshot.head).not.toContain('<link');
			expect(snapshot.head).not.toContain('<style');
			expect(snapshot.sheets.map((sheet) => sheet.href)).toEqual([
				'/shared.css',
				'/remote.css',
				'/nested.css',
				'/inline.css',
			]);
		}
	});

	it('keeps an earlier inline resource when a publisher initializes a link with the same href', async () => {
		const result = await prerender(ResourceInlineHost, { Boundary: boundary(), nonce }, options);
		const resource = oneResource(documentOf(result.html), '/shared.css');
		expect(resource.tagName).toBe('STYLE');
		expect(resource.textContent).toContain('color: blue');
		expect(resource.getAttribute('data-precedence')).toBe('host-inline');
		expect(resource.getAttribute('nonce')).toBe(nonce);
	});

	it('keeps ordinary native resource rendering unchanged without an external boundary', async () => {
		const result = await prerender(ResourceHost, { Boundary: ResourceRemote, nonce }, { nonce });
		const document = documentOf(result.html);
		expect(oneResource(document, '/shared.css').getAttribute('data-precedence')).toBe('host');
		for (const href of ['/remote.css', '/inline.css']) oneResource(document, href);
		expect(document.querySelector('article')?.textContent).toContain('remote');
	});

	it('shares sibling links and inline resources while preserving the first published attributes', async () => {
		const result = await prerender(ResourcePair, { Boundary: boundary(), nonce }, options);
		const document = documentOf(result.html);
		const shared = oneResource(document, '/shared.css');
		expect(shared.getAttribute('data-precedence')).toBe('federated');
		expect(shared.getAttribute('nonce')).toBe(nonce);
		expect(shared.getAttribute('crossorigin')).toBe('anonymous');
		expect(shared.getAttribute('integrity')).toBe('sha256-shared');
		expect(shared.getAttribute('media')).toBe('screen');
		for (const href of ['/first.css', '/second.css', '/inline.css']) oneResource(document, href);
		expect(
			[...document.querySelectorAll('article')].map((node) => node.getAttribute('data-resource')),
		).toEqual(['first', 'second']);
	});

	it('merges publisher sheets into first-encounter precedence groups', async () => {
		const snapshots: ExternalSnapshot[] = [];
		const Boundary = boundary(ResourceGroupedRemote, authority, async (request, signal) => {
			const snapshot = await transport(request, signal, ResourceGroupedRemote);
			snapshots.push(snapshot);
			return snapshot;
		});
		const result = await prerender(ResourceGroupedHost, { Boundary, nonce }, options);
		const document = documentOf(result.html);
		expect(
			[...document.querySelectorAll('link[rel="stylesheet"]')].map((node) =>
				node.getAttribute('href'),
			),
		).toEqual([
			'/host-a.css',
			'/group-a-first.css',
			'/group-a-last.css',
			'/host-c.css',
			'/group-b-first.css',
		]);
		expect(document.querySelector('article')?.textContent).toBe('grouped');
		expect(snapshots.length).toBeGreaterThan(0);
		for (const snapshot of snapshots) {
			expect(snapshot.sheets.map(({ href, precedence }) => [href, precedence])).toEqual([
				['/group-a-first.css', 'a'],
				['/group-b-first.css', 'b'],
				['/group-a-last.css', 'a'],
			]);
		}
	});

	it('projects only accepted sheets after suspended content and its pending arm are discarded', async () => {
		const gate = deferred<void>();
		const attempted = deferred<void>();
		const pendingArms: string[] = [];
		const snapshots: ExternalSnapshot[] = [];
		const Remote = createPendingResourceRemote(
			gate.promise,
			() => attempted.resolve(),
			() => pendingArms.push('pending'),
		);
		const Boundary = boundary(Remote, authority, async (request, signal) => {
			const snapshot = await transport(request, signal, Remote);
			snapshots.push(snapshot);
			return snapshot;
		});
		const rendering = prerender(ResourceHost, { Boundary, nonce }, options);
		try {
			await attempted.promise;
			gate.resolve();
			const result = await rendering;
			expect(pendingArms).toContain('pending');
			const document = documentOf(result.html);
			for (const href of ['/shared.css', '/remote.css', '/inline.css']) oneResource(document, href);
			expect(document.querySelector('article')?.textContent).toContain('remote');
			expect(result.html).not.toContain('/abandoned-');
			expect(snapshots.length).toBeGreaterThan(0);
			for (const snapshot of snapshots) {
				expect(snapshot.sheets.map((sheet) => sheet.href)).toEqual([
					'/shared.css',
					'/remote.css',
					'/inline.css',
				]);
				expect(snapshot.head).not.toContain('/abandoned-');
				expect(snapshot.html).not.toContain('Publisher pending');
			}
		} finally {
			gate.resolve();
			await rendering;
		}
	});

	it('streams new sheets before the publisher reveal without repeating a shell stylesheet', async () => {
		const publisherNonce = 'authored-publisher-sheet-nonce';
		const gate = deferred<void>();
		const Boundary = boundary(ResourceRemote, authority, async (request, signal) => {
			await gate.promise;
			return transport(request, signal);
		});
		const stream = await Server.renderToReadableStream(
			ResourceStreamingHost,
			{ Boundary, nonce, publisherNonce },
			options,
		);
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			const first = await reader.read();
			const shell = decoder.decode(first.value);
			expect(shell).toContain('Waiting for resource publisher');
			expect(shell).toContain('href="/shared.css"');
			gate.resolve();
			let tail = '';
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				tail += decoder.decode(chunk.value);
			}
			await stream.allReady;
			expect(tail).not.toContain('href="/shared.css"');
			const resource = tail.indexOf('href="/remote.css"');
			const reveal = tail.indexOf('<script');
			expect(resource).toBeGreaterThanOrEqual(0);
			expect(reveal).toBeGreaterThan(resource);
			expect(tail.slice(resource, tail.indexOf('>', resource))).toContain(
				`nonce="${publisherNonce}"`,
			);
			const inline = tail.indexOf('data-href="/inline.css"');
			expect(inline).toBeGreaterThanOrEqual(0);
			expect(inline).toBeLessThan(reveal);
			const parsed = documentOf(tail);
			expect(oneResource(parsed, '/inline.css').getAttribute('nonce')).toBe(publisherNonce);
			const carriers = [...parsed.querySelectorAll('script:not([type="application/json"])')];
			expect(carriers.length).toBeGreaterThan(0);
			for (const carrier of carriers) expect(carrier.getAttribute('nonce')).toBe(nonce);
			const container = document.createElement('div');
			container.innerHTML = shell + tail;
			document.body.append(container);
			try {
				activateStreamedMarkup(container);
				expect(container.querySelector('article')?.getAttribute('data-resource')).toBe('remote');
			} finally {
				container.remove();
				resetStreamRuntimeGlobals();
			}
		} finally {
			gate.resolve();
			await reader.cancel();
			reader.releaseLock();
		}
	});
});
