import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../../../../../test-utils/playwright-browser.js';
import { compile } from '../../../src/compiler/index.js';
import type {
	createRoot,
	flushSync,
	OctaneNode,
	__serverRpc,
	__serverRpcStream,
} from '../../../src/index.js';

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageRequire = createRequire(new URL('../../../package.json', import.meta.url));
const fixtureSource = `
export function DynamicFrame(props: { src: string }) @{
	<iframe sandbox="allow-scripts allow-same-origin" src={props.src} />
}

export function SpreadFrame(props: { src: string }) @{
	<iframe {...{ sandbox: 'allow-scripts allow-same-origin', src: props.src }} />
}
`;
type FixtureName = 'DynamicFrame' | 'SpreadFrame';
type FrameComponent = (props: { src: string }) => OctaneNode;

declare global {
	interface Window {
		OctaneIframeNavigation: {
			createRoot: typeof createRoot;
			flushSync: typeof flushSync;
			__serverRpc: typeof __serverRpc;
			__serverRpcStream: typeof __serverRpcStream;
			ordinary: Record<FixtureName, FrameComponent>;
			native: Record<FixtureName, FrameComponent>;
		};
		iframeRpc: {
			abort(): void;
			outcome: Promise<{ code?: string; name: string; aborted: boolean }>;
		};
		iframeNavigation: {
			messages: string[];
			update(src: string): boolean;
		};
	}
}

let browser: Browser;
const sources = new Map<boolean, string>();

beforeAll(async () => {
	for (const dev of [false, true]) {
		const compiled = new Map<string, string>(
			(['ordinary', 'native'] as const).map((kind) => {
				const result = compile(
					(kind === 'native' ? "import 'octane/signals';\n" : '') + fixtureSource,
					`/iframe-navigation-${kind}.tsrx`,
					{ mode: 'client', dev, hmr: false },
				);
				expect(result.diagnostics).toEqual([]);
				return [`${kind}-iframe-fixture`, result.code] as const;
			}),
		);
		const result = await build({
			stdin: {
				contents: `import { createRoot, flushSync, __serverRpc, __serverRpcStream } from 'octane';
import * as ordinary from 'ordinary-iframe-fixture';
import * as native from 'native-iframe-fixture';
export { createRoot, flushSync, __serverRpc, __serverRpcStream, ordinary, native };`,
				resolveDir: packageRoot,
				sourcefile: 'iframe-navigation-entry.js',
				loader: 'js',
			},
			bundle: true,
			write: false,
			format: 'iife',
			platform: 'browser',
			globalName: 'OctaneIframeNavigation',
			define: {
				'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
				__OCTANE_PROFILE_ENABLED__: 'false',
			},
			plugins: [
				{
					name: 'iframe-navigation-fixtures',
					setup(plugin) {
						plugin.onResolve({ filter: /^octane(?:\/|$)/ }, ({ path }) => ({
							path: packageRequire.resolve(path),
						}));
						plugin.onResolve({ filter: /^(ordinary|native)-iframe-fixture$/ }, ({ path }) => ({
							path,
							namespace: 'compiled-fixture',
						}));
						plugin.onLoad({ filter: /.*/, namespace: 'compiled-fixture' }, ({ path }) => ({
							contents: compiled.get(path)!,
							loader: 'js',
							resolveDir: packageRoot,
						}));
					},
				},
			],
		});
		sources.set(dev, result.outputFiles[0].text);
	}
	browser = await launchBrowser({ headless: true });
});

afterAll(async () => {
	await browser?.close();
});

describe.sequential('compiled iframe navigation in Chromium', () => {
	for (const dev of [false, true]) {
		for (const kind of ['ordinary', 'native'] as const) {
			it.each(['DynamicFrame', 'SpreadFrame'] as const)(
				`%s starts with its foreign sandbox URL and navigates updates (${kind}, dev=${dev})`,
				async (name) => {
					const page = await browser.newPage();
					const failures: string[] = [];
					page.on('pageerror', (error) => failures.push(error.message));
					page.on('console', (message) => {
						if (message.type() === 'warning' || message.type() === 'error') {
							failures.push(message.text());
						}
					});
					try {
						await page.route('http://parent.test/**', (route) =>
							route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }),
						);
						await page.route('https://foreign.test/**', (route) =>
							route.fulfill({
								contentType: 'text/html',
								body: `<script>parent.postMessage({token:'iframe-navigation',path:${JSON.stringify(new URL(route.request().url()).pathname)}},'*')</script>`,
							}),
						);
						await page.goto('http://parent.test/');
						await page.addScriptTag({ content: sources.get(dev)! });
						const initial = await page.evaluate(
							({ kind, name }) => {
								const { createRoot, flushSync } = window.OctaneIframeNavigation;
								const container = document.createElement('div');
								document.body.appendChild(container);
								const root = createRoot(container);
								const Component = window.OctaneIframeNavigation[kind][name];
								const messages: string[] = [];
								window.addEventListener('message', (event) => {
									if (
										event.origin === 'https://foreign.test' &&
										event.data?.token === 'iframe-navigation'
									) {
										messages.push(event.data.path);
									}
								});
								root.render(Component, { src: 'https://foreign.test/initial' });
								const iframe = container.querySelector('iframe')!;
								window.iframeNavigation = {
									messages,
									update(src) {
										flushSync(() => root.render(Component, { src }));
										return iframe === container.querySelector('iframe');
									},
								};
								return iframe.getAttribute('src');
							},
							{ kind, name },
						);
						await page.waitForFunction(() => window.iframeNavigation.messages.includes('/initial'));
						expect(initial).toBe('https://foreign.test/initial');
						expect(
							await page.evaluate(() =>
								window.iframeNavigation.update('https://foreign.test/updated'),
							),
						).toBe(true);
						await page.waitForFunction(() => window.iframeNavigation.messages.includes('/updated'));
						expect(await page.locator('iframe').getAttribute('src')).toBe(
							'https://foreign.test/updated',
						);
						expect(await page.evaluate(() => window.iframeNavigation.messages)).toEqual([
							'/initial',
							'/updated',
						]);
						// Connecting without src first creates an inherited-origin about:blank
						// document and makes Chromium warn about this otherwise foreign sandbox.
						expect(failures).toEqual([]);
					} finally {
						await page.close();
					}
				},
			);
		}
	}
});

describe.sequential('RPC cancellation across same-origin iframe realms in Chromium', () => {
	for (const dev of [false, true]) {
		it.each(['legacy', 'generic', 'contextual'] as const)(
			`accepts genuine iframe signals and rejects lookalikes for %s calls (dev=${dev})`,
			async (target) => {
				const page = await browser.newPage();
				const pendingRequested = Promise.withResolvers<void>();
				const finishPending = Promise.withResolvers<void>();
				const dispatched: string[] = [];
				try {
					await page.route('http://parent.test/**', async (route) => {
						const path = new URL(route.request().url()).pathname;
						if (path === '/') {
							await route.fulfill({
								contentType: 'text/html',
								body: '<!doctype html><body></body>',
							});
							return;
						}
						dispatched.push(path);
						if (path.endsWith('/pending')) {
							pendingRequested.resolve();
							await finishPending.promise;
						}
						const stream =
							route.request().headers()['accept'] === 'application/x-octane-rpc+ndjson';
						await route
							.fulfill({
								contentType: stream ? 'application/x-octane-rpc+ndjson' : 'application/json',
								body: stream
									? '[1,0,"value",["string","ready"]]\n[1,1,"complete",null]\n'
									: '[{"value":1},"ready"]',
							})
							.catch(() => {});
					});
					await page.goto('http://parent.test/');
					await page.addScriptTag({ content: sources.get(dev)! });
					const result = await page.evaluate(async (target) => {
						const iframe = document.createElement('iframe');
						document.body.appendChild(iframe);
						const realm = iframe.contentWindow as Window & typeof globalThis;
						const { __serverRpc, __serverRpcStream } = window.OctaneIframeNavigation;
						const invoke = target === 'contextual' ? __serverRpcStream : __serverRpc;
						const call = (hash: string, options: unknown): Promise<unknown> =>
							Reflect.apply(invoke, undefined, [
								hash,
								[],
								options,
								...(target === 'generic' ? [true] : []),
							]);
						const ready = new realm.AbortController();
						const ownRealm = ready.signal instanceof AbortSignal;
						const value = await call('ready', { signal: ready.signal });
						const aborted = new realm.AbortController();
						aborted.abort();
						let preAbort = '';
						try {
							await call('pre-aborted', { signal: aborted.signal });
						} catch (error) {
							if (error instanceof realm.DOMException) preAbort = error.name;
						}
						let spoofMethodCalls = 0;
						const lookalike = {
							[Symbol.toStringTag]: 'AbortSignal',
							aborted: false,
							throwIfAborted() {
								spoofMethodCalls++;
							},
							addEventListener() {
								spoofMethodCalls++;
							},
							removeEventListener() {
								spoofMethodCalls++;
							},
						};
						const invalidOptions = [
							{ signal: lookalike },
							{ signal: Object.create(AbortSignal.prototype) },
							{ signal: ready.signal, viewer: 'untrusted' },
						];
						const rejected = [];
						for (const options of invalidOptions) {
							try {
								await call('invalid', options);
								rejected.push({ name: 'resolved', message: '' });
							} catch (error) {
								if (!(error instanceof Error)) throw error;
								rejected.push({ name: error.name, message: error.message });
							}
						}
						const pending = new realm.AbortController();
						window.iframeRpc = {
							abort: () => pending.abort(),
							outcome: call('pending', { signal: pending.signal }).then(
								() => ({ name: 'resolved', aborted: pending.signal.aborted }),
								(error) => ({
									name: error.name,
									code: error.code,
									aborted: pending.signal.aborted,
								}),
							),
						};
						return { ownRealm, value, preAbort, rejected, spoofMethodCalls };
					}, target);
					expect(result.ownRealm).toBe(false);
					expect(result.value).toBe('ready');
					expect(result.preAbort).toBe('AbortError');
					expect(result.spoofMethodCalls).toBe(0);
					expect(result.rejected).toEqual(
						Array.from({ length: 3 }, () => ({
							name: 'TypeError',
							message: dev
								? 'Server function options accept only a local AbortSignal'
								: expect.stringContaining('Minified Octane error #364'),
						})),
					);
					await pendingRequested.promise;
					expect(
						await page.evaluate(async () => {
							window.iframeRpc.abort();
							return await window.iframeRpc.outcome;
						}),
					).toEqual({
						name: 'ServerCallUncertainError',
						code: 'OCTANE_RPC_UNCERTAIN',
						aborted: true,
					});
					expect(dispatched).toEqual(['/_$_ripple_rpc_$_/ready', '/_$_ripple_rpc_$_/pending']);
				} finally {
					finishPending.resolve();
					await page.close();
				}
			},
		);
	}
});
