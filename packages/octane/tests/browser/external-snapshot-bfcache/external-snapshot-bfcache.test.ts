import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as Server from 'octane/server';
import * as Signals from 'octane/signals';
import { prerender } from 'octane/static';
import { create_client_entry_source } from '../../../../app-core/src/codegen.js';
import { launchBrowser } from '../../../../../test-utils/playwright-browser.js';
import { compile } from '../../../src/compiler/index.js';
import { loadCompiledFixtureSource } from '../../_server-fixture.js';

const authority = { publisherBuildId: 'bfcache-publisher', runtimeABI: 1 as const };
const buildId = 'bfcache-host';
const documentId = 'external-snapshot-bfcache';
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageExports = JSON.parse(
	readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).exports as Record<string, string | { default?: string }>;

const remoteSource = `
import { query$, signal$, skip } from 'octane/signals';
const reads: { signal: AbortSignal; resolve: (value: string) => void }[] = [];
export function readState() {
	return reads.map(({ signal }) => ({ aborted: signal.aborted }));
}
export function finishRead(index: number, value: string) { reads[index].resolve(value); }
export function Remote() @{
	const active$ = signal$(false);
	const result$ = query$(() => active$.get() ? 'record' : skip,
		(_key, { signal }) => new Promise<string>(resolve => reads.push({ signal, resolve })));
	const result = result$.snapshot();
	<section>
		<input id="publisher-draft" defaultValue="server draft" />
		<button id="read" onClick={() => active$.set(true)}>{'Read'}</button>
		<output id="result">{result.status === 'ready' ? result.value : result.status}</output>
	</section>
}
`;
const hostSource = `
import { useLayoutEffect, useState } from 'octane';
import { Boundary } from '@fixture/boundary';
export function Host() @{
	const [ready, setReady] = useState(false);
	const [count, setCount] = useState(0);
	useLayoutEffect(() => setReady(true), []);
	<main>
		<button id="host-count" disabled={!ready} onClick={() => setCount(count + 1)}>{String(count)}</button>
		<Boundary />
		<a href="/away">{'Away'}</a>
	</main>
}
export default Host;
`;

declare global {
	interface Window {
		externalSnapshotBfcache: {
			readState(): { aborted: boolean }[];
			finishRead(index: number, value: string): void;
			events: { type: string; persisted: boolean }[];
			input?: HTMLInputElement;
		};
	}
}

let browser: Browser | undefined;
let server: HttpServer | undefined;
let origin: string;

beforeAll(async () => {
	const remote = loadCompiledFixtureSource(remoteSource, {
		id: '/external-snapshot-bfcache/remote.tsrx',
		mode: 'server',
		compileOptions: { dev: false, hmr: false },
		runtimeModules: { 'octane/signals': Signals },
	});
	const Boundary = Server.externalSnapshotBoundary({
		authority,
		component: remote.Remote,
		async snapshot(request, signal) {
			const prepared = await Server.prepareExternalSnapshotRequest(
				Server.serializeExternalSnapshotRequest(request),
				{ authority, signal },
			);
			try {
				return Server.decodeExternalSnapshot(
					Server.serializeExternalSnapshot(
						await Server.renderExternalSnapshot(remote.Remote, prepared),
					),
				);
			} finally {
				await Server.releasePreparedExternalSnapshotRequest(prepared);
			}
		},
	});
	const host = loadCompiledFixtureSource(hostSource, {
		id: '/external-snapshot-bfcache/host.tsrx',
		mode: 'server',
		compileOptions: { dev: false, hmr: false },
		runtimeModules: { '@fixture/boundary': { Boundary } },
	});
	const rendered = await prerender(
		host.default,
		{},
		{
			externalSnapshots: { documentId },
			streamedSignals: { buildId, documentId },
		},
	);
	const fixtures = new Map<string, string>();
	for (const [name, source] of [
		['remote', remoteSource],
		['page', hostSource],
	] as const) {
		const compiled = compile(
			source,
			`/external-snapshot-bfcache/${name === 'page' ? 'host' : name}.tsrx`,
			{
				mode: 'client',
				dev: false,
				hmr: false,
			},
		);
		expect(compiled.diagnostics).toEqual([]);
		fixtures.set(`@fixture/${name}`, compiled.code);
	}
	fixtures.set(
		'@fixture/boundary',
		`
		import { externalSnapshotBoundary } from 'octane';
		import { Remote } from '@fixture/remote';
		export const Boundary = externalSnapshotBoundary({
			authority: ${JSON.stringify(authority)}, component: Remote,
			snapshot() { throw new Error('A retained publisher must not request replacement HTML.'); }
		});
	`,
	);
	// Execute the production generator verbatim, including its real runtime imports.
	fixtures.set(
		'@fixture/generated-host',
		create_client_entry_source({
			clientBuildId: buildId,
			staticEntries: [{ id: 'page', specifier: '@fixture/page' }],
		}),
	);
	const bundle = await build({
		nodePaths: (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean),
		stdin: {
			contents: `
				import '@fixture/generated-host';
				import { readState, finishRead } from '@fixture/remote';
				window.externalSnapshotBfcache = { readState, finishRead, events: [] };
				for (const type of ['pagehide', 'pageshow']) {
					addEventListener(type, event => window.externalSnapshotBfcache.events.push({ type, persisted: event.persisted }));
				}
			`,
			resolveDir: packageRoot,
			loader: 'js',
		},
		plugins: [
			{
				name: 'external-snapshot-bfcache-fixtures',
				setup(builder) {
					builder.onResolve({ filter: /^octane(?:\/|$)/ }, ({ path }) => {
						const entry = packageExports[path === 'octane' ? '.' : `./${path.slice(7)}`];
						const target = typeof entry === 'string' ? entry : entry?.default;
						if (!target) throw new Error(`Unknown Octane export: ${path}`);
						return { path: resolve(packageRoot, target) };
					});
					builder.onResolve({ filter: /^@fixture\// }, ({ path }) => ({
						path,
						namespace: 'fixture',
					}));
					builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
						contents: fixtures.get(path),
						loader: 'js',
						resolveDir: packageRoot,
					}));
				},
			},
		],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		define: {
			'process.env.NODE_ENV': '"production"',
			__OCTANE_PROFILE_ENABLED__: 'false',
			'import.meta.hot': 'undefined',
		},
	});
	const data = JSON.stringify({
		entry: 'page',
		params: {},
		url: '/',
		clientBuild: {
			version: 1,
			buildId,
			mode: 'production',
			capabilities: { independentHydration: false },
		},
		streamedSignals: { buildId, documentId },
	}).replaceAll('<', '\\u003c');
	const html = `<!doctype html><html><head><meta charset="utf-8">${rendered.css}</head><body>
		<div id="root">${rendered.html}</div><script id="__octane_data" type="application/json">${data}</script>
		<script type="module" src="/entry.js"></script></body></html>`;
	server = createServer((request, response) => {
		if (request.url === '/favicon.ico') {
			response.writeHead(204).end();
			return;
		}
		response.setHeader(
			'Content-Type',
			request.url === '/entry.js' ? 'text/javascript' : 'text/html',
		);
		response.end(
			request.url === '/entry.js'
				? bundle.outputFiles[0].text
				: request.url === '/away'
					? '<!doctype html><title>Away</title><p>Away</p>'
					: html,
		);
	});
	await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
	origin = `http://127.0.0.1:${address.port}`;
	// Playwright disables BFCache by default. This suite requires a genuine restore.
	browser = await launchBrowser({
		channel: 'chromium',
		headless: true,
		ignoreDefaultArgs: ['--disable-back-forward-cache'],
	});
});

afterAll(async () => {
	await browser?.close();
	if (server)
		await new Promise<void>((resolve, reject) =>
			server!.close((error) => (error ? reject(error) : resolve())),
		);
});

it('restores a generated host and publisher draft while restarting the frozen publisher read', async () => {
	const page = await browser!.newPage();
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') failures.push(message.text());
	});
	try {
		await page.goto(origin);
		await expect
			.poll(async () => {
				if (failures.length) throw new Error(failures.join('\n'));
				return page.locator('#host-count').isEnabled();
			})
			.toBe(true);
		await page.locator('#host-count').click();
		await expect.poll(() => page.locator('#host-count').textContent()).toBe('1');
		await page.locator('#publisher-draft').fill('draft retained by the browser');
		await page.evaluate(() => {
			window.externalSnapshotBfcache.input = document.querySelector('#publisher-draft')!;
		});
		await page.locator('#read').click();
		await expect
			.poll(() => page.evaluate(() => window.externalSnapshotBfcache.readState()))
			.toEqual([{ aborted: false }]);
		await page.locator('a[href="/away"]').click();
		await page.waitForURL(`${origin}/away`);
		await page.goBack({ waitUntil: 'commit' });
		await page.waitForFunction(() =>
			window.externalSnapshotBfcache?.events.some(
				(event) => event.type === 'pageshow' && event.persisted,
			),
		);
		expect(
			await page.evaluate(() =>
				window.externalSnapshotBfcache.events.filter((event) => event.persisted),
			),
		).toEqual([
			{ type: 'pagehide', persisted: true },
			{ type: 'pageshow', persisted: true },
		]);
		expect(
			await page.evaluate(
				() => window.externalSnapshotBfcache.input === document.querySelector('#publisher-draft'),
			),
		).toBe(true);
		expect(await page.locator('#publisher-draft').inputValue()).toBe(
			'draft retained by the browser',
		);
		await expect
			.poll(() => page.evaluate(() => window.externalSnapshotBfcache.readState()))
			.toEqual([{ aborted: true }, { aborted: false }]);
		await page.evaluate(() => window.externalSnapshotBfcache.finishRead(1, 'fresh result'));
		await expect.poll(() => page.locator('#result').textContent()).toBe('fresh result');
		await page.evaluate(() => window.externalSnapshotBfcache.finishRead(0, 'stale result'));
		await page.locator('#host-count').click();
		await expect.poll(() => page.locator('#host-count').textContent()).toBe('2');
		expect(await page.locator('#result').textContent()).toBe('fresh result');
		expect(failures).toEqual([]);
	} finally {
		await page.close();
	}
});
