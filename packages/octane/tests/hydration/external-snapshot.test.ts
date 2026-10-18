import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { prerender } from '../../src/runtime.server.js';
import * as ClientSignals from '../../src/signals/client.js';
import * as ServerSignals from '../../src/signals/server.js';
import * as Signals from '../../src/signals/index.js';
import {
	bootstrapStreamedSignalHydration,
	installSignalDocumentLifecycle,
} from '../../src/hydration/streamed-signals.js';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import {
	activateStreamedMarkup,
	createPipeableCollector,
	deferred,
	resetStreamRuntimeGlobals,
} from '../_server-stream.js';
import {
	captureExternalSnapshotContexts,
	createExternalSnapshotRequest,
	registerExternalSnapshotContext,
} from '../../src/external-snapshot-protocol.js';

const Theme = createContext({ title: 'default' });
const Other = createContext('other default');
const authority = { publisherBuildId: 'remote-build', runtimeABI: 1 as const };
const releases: (() => void)[] = [];

afterEach(() => {
	for (const release of releases.splice(0)) release();
	resetStreamRuntimeGlobals();
	document.head.innerHTML = '';
});

function pair(source: string, id: string, dev: boolean, modules = {}) {
	const options = { id, compileOptions: { dev }, runtimeModules: modules };
	return {
		server: loadCompiledFixtureSource(source, { ...options, mode: 'server' }),
		client: loadCompiledFixtureSource(source, { ...options, mode: 'client' }),
	};
}

function transport(
	component: typeof Server.renderExternalSnapshot extends (
		component: infer C,
		...rest: any[]
	) => any
		? C
		: never,
) {
	return async (request: Server.ExternalSnapshotRequest, signal?: AbortSignal) => {
		const prepared = await Server.prepareExternalSnapshotRequest(
			Server.serializeExternalSnapshotRequest(request),
			{ authority, ...(signal === undefined ? {} : { signal }) },
		);
		try {
			return Server.decodeExternalSnapshot(
				Server.serializeExternalSnapshot(await Server.renderExternalSnapshot(component, prepared)),
			);
		} finally {
			await Server.releasePreparedExternalSnapshotRequest(prepared);
		}
	};
}

describe('external snapshot admission and selected context codecs', () => {
	it.each([NaN, Infinity, -1, 0, 2147483648, Number.MAX_SAFE_INTEGER])(
		'rejects unsupported boundary timeout %s in both public runtimes',
		(timeoutMs) => {
			const component = vi.fn();
			const snapshot = vi.fn();
			expect(() =>
				Client.externalSnapshotBoundary({ authority, component, snapshot, timeoutMs }),
			).toThrow(/External snapshot timeout|Minified Octane error #358/);
			expect(() =>
				Server.externalSnapshotBoundary({ authority, component, snapshot, timeoutMs }),
			).toThrow(/External snapshot timeout|Minified Octane error #358/);
			expect(component).not.toHaveBeenCalled();
			expect(snapshot).not.toHaveBeenCalled();
		},
	);

	it('accepts the maximum supported boundary deadline without starting publisher work', () => {
		const component = vi.fn();
		const snapshot = vi.fn();
		const options = { authority, component, snapshot, timeoutMs: 2147483647 };
		expect(typeof Client.externalSnapshotBoundary(options)).toBe('function');
		expect(typeof Server.externalSnapshotBoundary(options)).toBe('function');
		expect(component).not.toHaveBeenCalled();
		expect(snapshot).not.toHaveBeenCalled();
	});

	it('transfers only the publisher keys and owns codec registration until disposal', async () => {
		const Theme = Server.createContext({ title: 'default' });
		const decode = vi.fn((value) => ({ title: String(value) }));
		const codec: {
			key: string;
			encode: (value: { title: string }) => unknown;
			decode: (value: unknown) => { title: string };
		} = { key: 'theme', encode: (value) => value.title, decode };
		const release = registerExternalSnapshotContext(Theme, codec);
		releases.push(release);
		releases.push(
			registerExternalSnapshotContext(Other, {
				key: 'other',
				encode: (value: string) => value,
				decode: (value) => String(value),
			}),
		);
		codec.key = 'changed';
		codec.encode = () => 'changed';
		codec.decode = () => ({ title: 'changed' });
		const values = new Map<Function, unknown>([
			[Theme, { title: 'theme value' }],
			[Other, 'other value'],
		]);
		const request = createExternalSnapshotRequest(
			authority,
			'admission',
			'one',
			{},
			captureExternalSnapshotContexts(values, ['theme']),
		);
		expect(request.contexts.map(({ key }) => key)).toEqual(['theme']);
		const prepared = await Server.prepareExternalSnapshotRequest(request, { authority });
		try {
			expect(
				(
					await Server.renderExternalSnapshot(
						() =>
							Server.createElement('p', {
								children: Server.useContext(Theme).title,
							}),
						prepared,
					)
				).html,
			).toContain('theme value');
		} finally {
			await Server.releasePreparedExternalSnapshotRequest(prepared);
		}
		expect(captureExternalSnapshotContexts(values, ['other']).map(({ key }) => key)).toEqual([
			'other',
		]);
		expect(captureExternalSnapshotContexts(values, undefined)).toEqual([]);
		release();
		expect(() => captureExternalSnapshotContexts(values, ['theme'])).toThrow();
		releases.push(
			registerExternalSnapshotContext(Theme, {
				key: 'theme',
				encode: (value) => value.title,
				decode: (value) => ({ title: String(value) }),
			}),
		);
	});

	it('rejects a foreign publisher before codecs and native component execution', async () => {
		const decode = vi.fn(() => ({ title: 'decoded' }));
		releases.push(
			registerExternalSnapshotContext(Theme, { key: 'theme', encode: (value) => value, decode }),
		);
		const component = vi.fn(() => Server.createElement('p', { children: 'executed' }));
		const request = createExternalSnapshotRequest(
			authority,
			'admission',
			'one',
			{ message: 'owned props' },
			captureExternalSnapshotContexts(new Map([[Theme, { title: 'host' }]]), ['theme']),
		);
		await expect(
			Server.renderExternalSnapshot(component, request, {
				authority: { ...authority, publisherBuildId: 'foreign' },
			}),
		).rejects.toThrow();
		await expect(
			Server.renderExternalSnapshot(component, request, { authority: undefined! }),
		).rejects.toThrow();
		expect(decode).not.toHaveBeenCalled();
		expect(component).not.toHaveBeenCalled();
		expect(() =>
			Server.decodeExternalSnapshotRequest(
				{ ...request, authority: { ...authority, runtimeABI: 2 } },
				authority,
			),
		).toThrow();
		expect(decode).not.toHaveBeenCalled();
		expect(component).not.toHaveBeenCalled();
	});

	it('awaits selected context reconstruction before invoking the native publisher', async () => {
		const Theme = Server.createContext({ title: 'default' });
		const pending = deferred<{ title: string }>();
		const decode = vi.fn(() => pending.promise);
		releases.push(
			registerExternalSnapshotContext(Theme, {
				key: 'async-theme',
				encode: (value) => value.title,
				decode,
			}),
		);
		const request = createExternalSnapshotRequest(
			authority,
			'async-context',
			'one',
			{},
			captureExternalSnapshotContexts(new Map([[Theme, { title: 'host' }]]), ['async-theme']),
		);
		const component = vi.fn(() =>
			Server.createElement('p', { children: Server.useContext(Theme).title }),
		);
		const result = Server.renderExternalSnapshot(component, request, { authority });
		await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
		expect(component).not.toHaveBeenCalled();
		pending.resolve({ title: 'restored context' });
		expect((await result).html).toContain('restored context');
	});

	it.each(['caller', 'deadline'])(
		'cancels %s during context reconstruction before component execution',
		async (mode) => {
			const pending = deferred<{ title: string }>();
			let decoderSignal: AbortSignal | undefined;
			const decode = vi.fn((_value, signal?: AbortSignal) => {
				decoderSignal = signal;
				return pending.promise;
			});
			releases.push(
				registerExternalSnapshotContext(Theme, {
					key: 'async-theme',
					encode: (value) => value.title,
					decode,
				}),
			);
			const request = createExternalSnapshotRequest(
				authority,
				'cancel-context',
				'one',
				{},
				captureExternalSnapshotContexts(new Map([[Theme, { title: 'host' }]]), ['async-theme']),
			);
			const controller = new AbortController();
			const component = vi.fn(() => Server.createElement('p', { children: 'must not execute' }));
			const result = Server.renderExternalSnapshot(component, request, {
				authority,
				signal: controller.signal,
				timeoutMs: mode === 'deadline' ? 15 : 1000,
			});
			await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(1));
			if (mode === 'caller') controller.abort(new Error('request canceled'));
			await expect(result).rejects.toThrow();
			expect(decoderSignal?.aborted).toBe(true);
			pending.resolve({ title: 'late context' });
			await Promise.resolve();
			expect(component).not.toHaveBeenCalled();
		},
	);

	it('owns endpoint-local provider initialization and rejects overrides before execution', async () => {
		const Other = Server.createContext('other default');
		registerTheme();
		const request = createExternalSnapshotRequest(
			authority,
			'local-context',
			'one',
			{},
			captureExternalSnapshotContexts(new Map([[Theme, { title: 'host' }]]), ['theme']),
		);
		const component = vi.fn(() =>
			Server.createElement('p', { children: Server.useContext(Other) }),
		);
		await expect(
			Server.renderExternalSnapshot(component, request, {
				authority,
				initializeContexts: (provide) => provide(Theme, { title: 'override' }),
			}),
		).rejects.toThrow();
		await expect(
			Server.renderExternalSnapshot(component, request, {
				authority,
				initializeContexts: (provide) =>
					provide(
						Object.assign(() => {}, { defaultValue: 'invalid' }),
						'invalid',
					),
			}),
		).rejects.toThrow();
		await expect(
			Server.renderExternalSnapshot(component, request, {
				authority,
				initializeContexts: async () => {},
			}),
		).rejects.toThrow();
		expect(component).not.toHaveBeenCalled();
		let provideLater: ((context: typeof Other, value: string) => void) | undefined;
		const result = await Server.renderExternalSnapshot(component, request, {
			authority,
			initializeContexts: (provide) => {
				provideLater = provide;
				provide(Other, 'endpoint');
			},
		});
		expect(result.html).toContain('endpoint');
		expect(() => provideLater!(Other, 'late')).toThrow();
	});

	it('aborts a timed out snapshot waiter and permits a later request on the same factory', async () => {
		const signals: AbortSignal[] = [];
		let healthy = false;
		const component = () => Server.createElement('p', { children: 'healthy publisher' });
		const boundary = Server.externalSnapshotBoundary({
			authority,
			component,
			timeoutMs: 15,
			snapshot: (request, signal) => {
				signals.push(signal!);
				return healthy
					? Server.renderExternalSnapshot(component, request, {
							authority,
							...(signal === undefined ? {} : { signal }),
						})
					: new Promise(() => {});
			},
		});
		const app = () =>
			Server.createElement(Server.Suspense, {
				fallback: Server.createElement('p', { children: 'publisher pending' }),
				children: Server.createElement(boundary, {}),
			});
		const failed = await prerender(
			app,
			{},
			{ externalSnapshots: { documentId: 'first' }, timeoutMs: 1000 },
		);
		expect(failed.html).toContain('publisher pending');
		expect(signals[0]!.aborted).toBe(true);
		healthy = true;
		const recovered = await prerender(
			app,
			{},
			{ externalSnapshots: { documentId: 'second' }, timeoutMs: 1000 },
		);
		expect(recovered.html).toContain('healthy publisher');
		expect(signals).toHaveLength(2);
		expect(signals[1]!.aborted).toBe(true);
	});
});

const remoteSource = `import { useContext, useId } from 'octane';
import { useSignal$ } from 'octane/signals/client';
import { Theme } from './contexts';
export function Remote(props) {
  const value$ = useSignal$(props.initial);
  const theme = useContext(Theme);
  const id = useId();
  return <section><label htmlFor={id}>{theme.title}<input id={id} defaultValue="draft" /></label><button onClick={() => value$.set(value => value + 1)}>{props.label + ':' + value$.get()}</button></section>;
}`;

function fixtures(
	dev: boolean,
	contexts: { server: Record<string, unknown>; client: Record<string, unknown> } = {
		server: { Theme, Other },
		client: { Theme, Other },
	},
) {
	const server = loadCompiledFixtureSource(remoteSource, {
		id: '/remote/Widget.tsx',
		mode: 'server',
		compileOptions: { dev },
		runtimeModules: { './contexts': contexts.server, 'octane/signals/server': ServerSignals },
	});
	const client = loadCompiledFixtureSource(remoteSource, {
		id: '/remote/Widget.tsx',
		mode: 'client',
		compileOptions: { dev },
		runtimeModules: { './contexts': contexts.client, 'octane/signals/client': ClientSignals },
	});
	return { server, client };
}

function registerTheme() {
	releases.push(
		registerExternalSnapshotContext(Theme, {
			key: 'theme',
			encode: (value: { title: string }) => value.title,
			decode: (value) => ({ title: String(value) }),
		}),
	);
}

describe.each([false, true])('native external snapshots, dev=%s', (dev) => {
	it.each([false, true])(
		'retries a suspended host without losing publisher adoption or stream history, host lease=%s',
		async (hostLease) => {
			const source = `import {use,useState,useLayoutEffect} from 'octane';import {load,onReady} from './data';export function Remote(){const value=use(load());const [count,setCount]=useState(0);useLayoutEffect(()=>onReady(),[]);return <button onClick={()=>setCount(count+1)}>{value+':'+count}</button>;}`;
			const server = pair(source, '/remote/RetryHistory.tsx', dev, {
				'./data': { load: () => Promise.resolve('publisher history'), onReady() {} },
			}).server;
			const browserData = deferred<string>();
			const clientLoad = vi.fn(() => browserData.promise);
			const onReady = vi.fn();
			const client = pair(source, '/remote/RetryHistory.tsx', dev, {
				'./data': { load: clientLoad, onReady },
			}).client;
			const snapshot = transport(server['Remote']);
			const S = Server.externalSnapshotBoundary({
				authority,
				component: server['Remote'],
				snapshot,
			});
			const C = Client.externalSnapshotBoundary({
				authority,
				component: client['Remote'],
				snapshot,
			});
			const host = `import {Boundary} from './remote';function read(value){if(value!==undefined)throw value;return 'host ready';}function Sibling(props){return <span>{read(props.gate.pending)}</span>;}export function App(props){return <main><Boundary/><Sibling gate={props.gate}/></main>;}`;
			const sHost = pair(host, '/host/RetryHistory.tsx', dev, {
				'./remote': { Boundary: S },
			}).server;
			const cHost = pair(host, '/host/RetryHistory.tsx', dev, {
				'./remote': { Boundary: C },
			}).client;
			const documentId = 'retry-history-' + hostLease;
			const options = { externalSnapshots: { documentId } };
			const container = document.createElement('div');
			container.innerHTML = (await prerender(sHost['App'], { gate: {} }, options)).html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const button = container.querySelector('button')!;
			const pending = deferred<void>();
			const gate = { pending: pending.promise as Promise<void> | undefined };
			const errors: unknown[] = [];
			const bridge = hostLease
				? bootstrapStreamedSignalHydration({ buildId: 'host-build', documentId })
				: undefined;
			const root = Client.hydrateRoot(
				container,
				cHost['App'],
				{ gate },
				{
					...options,
					...(bridge === undefined ? {} : { signalOwner: bridge.signalOwner }),
					onRecoverableError: (error) => errors.push(error),
					onUncaughtError: (error) => errors.push(error),
				},
			);
			try {
				await Client.act(async () => {});
				expect(container.querySelector('button')).toBe(button);
				expect(onReady).not.toHaveBeenCalled();
				gate.pending = undefined;
				pending.resolve();
				await Client.act(async () => {});
				expect(container.querySelector('button')).toBe(button);
				expect(button.textContent).toBe('publisher history:0');
				expect(onReady).toHaveBeenCalled();
				browserData.resolve('publisher history');
				await Client.act(async () => {});
				await Client.act(() => button.click());
				expect(button.textContent).toBe('publisher history:1');
				expect(clientLoad).toHaveBeenCalled();
				expect(errors).toEqual([]);
			} finally {
				pending.resolve();
				root.unmount();
				bridge?.dispose();
				container.remove();
			}
		},
	);

	it.each(['suspense', 'activity'] as const)(
		'keeps a committed publisher lease across host %s hide and reveal',
		async (mode) => {
			const source = `import {use,useState} from 'octane';import {load} from './data';export function Remote(){const value=use(load());const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{value+':'+count}</button>;}`;
			const serverData = Promise.resolve('publisher history');
			const server = pair(source, '/remote/CommittedHistory.tsx', dev, {
				'./data': { load: () => serverData },
			}).server;
			const browserData = deferred<string>();
			const client = pair(source, '/remote/CommittedHistory.tsx', dev, {
				'./data': { load: () => browserData.promise },
			}).client;
			const snapshot = transport(server['Remote']);
			const S = Server.externalSnapshotBoundary({
				authority,
				component: server['Remote'],
				snapshot,
			});
			const C = Client.externalSnapshotBoundary({
				authority,
				component: client['Remote'],
				snapshot,
			});
			const host =
				mode === 'suspense'
					? `import {Suspense} from 'octane';import {Boundary} from './remote';function read(value){if(value!==undefined)throw value;return 'host ready';}function Sibling(props){return <span>{read(props.gate.pending)}</span>;}export function App(props){return <Suspense fallback={<p data-pending="">host pending</p>}><section data-host=""><Boundary/><Sibling gate={props.gate}/></section></Suspense>;}`
					: `import {Activity,Suspense} from 'octane';import {Boundary} from './remote';export function App(props) @{ <Suspense fallback={<p>loading snapshot</p>}><Activity mode={props.mode}><section data-host=""><Boundary/></section></Activity></Suspense> }`;
			const hostId =
				mode === 'activity' ? '/host/CommittedHistory.tsrx' : '/host/CommittedHistory.tsx';
			const sHost = pair(host, hostId, dev, {
				'./remote': { Boundary: S },
			}).server;
			const cHost = pair(host, hostId, dev, {
				'./remote': { Boundary: C },
			}).client;
			const documentId = 'committed-history-' + mode;
			const options = { externalSnapshots: { documentId } };
			const gate = { pending: undefined as Promise<void> | undefined };
			const container = document.createElement('div');
			container.innerHTML = (
				await prerender(sHost['App'], { mode: 'visible', gate }, options)
			).html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const section = container.querySelector<HTMLElement>('[data-host]')!;
			const button = container.querySelector('button')!;
			const pending = deferred<void>();
			const errors: unknown[] = [];
			const bridge = bootstrapStreamedSignalHydration({ buildId: 'host-build', documentId });
			const root = Client.hydrateRoot(
				container,
				cHost['App'],
				{ mode: 'visible', gate },
				{
					...options,
					signalOwner: bridge.signalOwner,
					onRecoverableError: (error) => errors.push(error),
					onUncaughtError: (error) => errors.push(error),
				},
			);
			try {
				await Client.act(async () => {});
				expect(container.querySelector('button')).toBe(button);
				await Client.act(() => button.click());
				expect(button.textContent).toBe('publisher history:1');

				if (mode === 'suspense') gate.pending = pending.promise;
				await Client.act(() => {
					Client.flushSync(() =>
						root.render(cHost['App'], { mode: mode === 'activity' ? 'hidden' : 'visible', gate }),
					);
				});
				expect(container.querySelector('[data-host]')).toBe(section);
				expect(section.style.display).toBe('none');
				if (mode === 'suspense') {
					expect(container.querySelector('[data-pending]')?.textContent).toBe('host pending');
				}
				expect(errors).toEqual([]);

				// Settle the browser's data while the publisher is hidden; its adopted server
				// history and local state must remain usable when the host shows it again.
				browserData.resolve('publisher history');
				await Client.act(async () => {});
				expect(section.style.display).toBe('none');
				gate.pending = undefined;
				pending.resolve();
				await Client.act(() => root.render(cHost['App'], { mode: 'visible', gate }));
				expect(container.querySelector('[data-host]')).toBe(section);
				expect(section.style.display).not.toBe('none');
				expect(container.querySelector('[data-pending]')).toBeNull();
				expect(container.querySelector('button')).toBe(button);
				expect(button.textContent).toBe('publisher history:1');
				await Client.act(() => button.click());
				expect(button.textContent).toBe('publisher history:2');
				expect(errors).toEqual([]);
			} finally {
				gate.pending = undefined;
				pending.resolve();
				browserData.resolve('publisher history');
				root.unmount();
				bridge.dispose();
				container.remove();
			}
		},
	);

	it('keeps ordinary JSX snapshot retries and sibling requests distinct', async () => {
		const serverData = Promise.resolve('publisher history');
		const server = pair(
			`import {use,useState} from 'octane';import {load} from './data';export function Remote(props){const value=use(load());const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{props.label+':'+value+':'+count}</button>;}`,
			'/remote/ActivityHistory.tsx',
			dev,
			{ './data': { load: () => serverData } },
		).server;
		const Boundary = Server.externalSnapshotBoundary({
			authority,
			component: server['Remote'],
			snapshot: transport(server['Remote']),
		});
		const host = pair(
			`import {Activity,Suspense} from 'octane';import {Boundary} from './remote';export function App(props){return <Suspense fallback={<p>loading snapshot</p>}><Activity mode={props.mode}><section data-host=""><Boundary label="first"/><Boundary label="second"/></section></Activity></Suspense>;}`,
			'/host/ActivityHistory.tsx',
			dev,
			{ './remote': { Boundary } },
		).server;
		const result = await prerender(
			host['App'],
			{ mode: 'visible' },
			{ externalSnapshots: { documentId: 'jsx-activity-history' } },
		);
		const container = document.createElement('div');
		container.innerHTML = result.html;
		expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
			'first:publisher history:0',
			'second:publisher history:0',
		]);
	});

	it('retains compiled signal and ID adoption with publisher-local native providers', async () => {
		const serverOther = Server.createContext('other default');
		const clientOther = Client.createContext('other default');
		const source = `import {useContext,useId} from 'octane';import {useSignal$} from 'octane/signals/client';import {Other} from './contexts';export function Remote(props){const value$=useSignal$(props.initial);const id=useId();const context=useContext(Other);return <section><input id={id} defaultValue="draft"/><button onClick={()=>value$.set(value=>value+1)}>{props.label+':'+value$.get()+':'+context}</button></section>;}`;
		const fixture = { id: '/remote/LocalProvider.tsx', compileOptions: { dev } };
		const server = loadCompiledFixtureSource(source, {
			...fixture,
			mode: 'server',
			runtimeModules: {
				'./contexts': { Other: serverOther },
				'octane/signals/server': ServerSignals,
			},
		});
		const client = loadCompiledFixtureSource(source, {
			...fixture,
			mode: 'client',
			runtimeModules: {
				'./contexts': { Other: clientOther },
				'octane/signals/client': ClientSignals,
			},
		});
		const snapshot = async (request: Server.ExternalSnapshotRequest, signal?: AbortSignal) => {
			const prepared = await Server.prepareExternalSnapshotRequest(request, {
				authority,
				...(signal === undefined ? {} : { signal }),
				initializeContexts: (provide) => provide(serverOther, 'publisher local'),
			});
			try {
				return await Server.renderExternalSnapshot(server['Remote'], prepared);
			} finally {
				await Server.releasePreparedExternalSnapshotRequest(prepared);
			}
		};
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const container = document.createElement('div');
		container.innerHTML = (
			await prerender(
				S,
				{ label: 'Wrapped', initial: 4 },
				{ externalSnapshots: { documentId: 'publisher-provider' } },
			)
		).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const button = container.querySelector('button')!;
		const input = container.querySelector('input')!;
		const errors: unknown[] = [];
		const app = (props: { context: string }) =>
			Client.createElement(clientOther, {
				value: props.context,
				children: Client.createElement(C, { label: 'Wrapped', initial: 4 }),
			});
		const root = Client.hydrateRoot(
			container,
			app,
			{ context: 'publisher local' },
			{
				externalSnapshots: { documentId: 'publisher-provider' },
				onRecoverableError: (error) => errors.push(error),
				onUncaughtError: (error) => errors.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(container.querySelector('button')).toBe(button);
			expect(container.querySelector('input')).toBe(input);
			await Client.act(() => button.click());
			expect(button.textContent).toBe('Wrapped:5:publisher local');
			await Client.act(() => root.render(app, { context: 'live host' }));
			expect(button.textContent).toBe('Wrapped:5:live host');
			expect(container.querySelector('button')).toBe(button);
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('retains real SSR nodes through lazy activation and follows live host context', async () => {
		const serverTheme = Server.createContext({ title: 'default' });
		const clientTheme = Client.createContext({ title: 'default' });
		releases.push(
			registerExternalSnapshotContext(serverTheme, {
				key: 'theme',
				encode: (value) => value.title,
				decode: (value) => ({ title: String(value) }),
			}),
		);
		const { server, client } = fixtures(dev, {
			server: { Theme: serverTheme },
			client: { Theme: clientTheme },
		});
		const pending = deferred<{ default: (typeof client)['Remote'] }>();
		const snapshot = vi.fn(async (request: Server.ExternalSnapshotRequest) =>
			Server.decodeExternalSnapshot(
				Server.serializeExternalSnapshot(
					await Server.renderExternalSnapshot(
						server['Remote'],
						Server.decodeExternalSnapshotRequest(
							Server.serializeExternalSnapshotRequest(request),
							authority,
						),
						{ authority },
					),
				),
			),
		);
		const ServerBoundary = Server.externalSnapshotBoundary({
			authority,
			component: server['Remote'],
			snapshot,
			contextKeys: ['theme'],
		});
		const ClientBoundary = Client.externalSnapshotBoundary({
			authority,
			component: Client.lazy(() => pending.promise),
			snapshot,
			contextKeys: ['theme'],
		});
		const serverApp = (props: { title: string }) =>
			Server.createElement(serverTheme, {
				value: { title: props.title },
				children: Server.createElement(ServerBoundary, { label: 'Count', initial: 3 }),
			});
		const clientApp = (props: { title: string }) =>
			Client.createElement(clientTheme, {
				value: { title: props.title },
				children: Client.createElement(ClientBoundary, { label: 'Count', initial: 3 }),
			});
		const rendered = await prerender(
			serverApp,
			{ title: 'server' },
			{ externalSnapshots: { documentId: 'document-a' } },
		);
		const container = document.createElement('div');
		container.innerHTML = rendered.html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const button = container.querySelector('button')!;
		const input = container.querySelector('input')!;
		input.value = 'typed before hydration';
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			clientApp,
			{ title: 'server' },
			{
				externalSnapshots: { documentId: 'document-a' },
				onRecoverableError: (error) => errors.push(error),
				onUncaughtError: (error) => errors.push(error),
			},
		);
		try {
			Client.flushSync(() => {});
			expect(container.querySelector('button')).toBe(button);
			pending.resolve({ default: client['Remote'] });
			await Client.act(async () => {});
			expect(container.querySelector('button')).toBe(button);
			expect(container.querySelector('input')).toBe(input);
			expect(input.value).toBe('typed before hydration');
			await Client.act(() => button.click());
			expect(button.textContent).toBe('Count:4');
			await Client.act(() => root.render(clientApp, { title: 'live host' }));
			expect(container.querySelector('label')!.textContent).toBe('live host');
			expect(container.querySelector('button')).toBe(button);
			expect(button.textContent).toBe('Count:4');
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('silently reconciles non-context text within an authenticated external snapshot shape', async () => {
		const { server, client } = fixtures(dev);
		const snapshot = vi.fn(transport(server['Remote']));
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const options = { externalSnapshots: { documentId: 'external-text-value' } };
		const props = { label: 'Count', initial: 3 };
		const container = document.createElement('div');
		container.innerHTML = (await prerender(S, props, options)).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const section = container.querySelector('section')!;
		const input = container.querySelector('input')!;
		const button = container.querySelector('button')!;
		const id = input.id;
		input.value = 'typed before hydration';
		const serverText = [...button.childNodes].find((node): node is Text => node instanceof Text);
		if (serverText === undefined) throw new Error('Publisher counter text is required.');
		expect(serverText.data).toBe('Count:3');
		serverText.data = 'different server text';
		expect(container.querySelector('label')!.textContent).toBe('default');
		expect(button.textContent).toBe('different server text');
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(container, C, props, {
			...options,
			onRecoverableError: (error) => errors.push(error),
			onUncaughtError: (error) => errors.push(error),
		});
		try {
			await Client.act(async () => {});
			expect(container.querySelector('section')).toBe(section);
			expect(container.querySelector('input')).toBe(input);
			expect(container.querySelector('button')).toBe(button);
			expect(input.id).toBe(id);
			expect(input.value).toBe('typed before hydration');
			expect(container.querySelector('label')!.textContent).toBe('default');
			expect(button.textContent).toBe('Count:3');
			await Client.act(() => button.click());
			expect(button.textContent).toBe('Count:4');
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it.each(['same', 'different'] as const)(
		'retains external SSR nodes through deferred outer and inner lazy loading, initial context=%s',
		async (context) => {
			registerTheme();
			const { server, client } = fixtures(dev);
			const admitted = deferred<void>();
			const loaded = deferred<{ default: (typeof client)['Remote'] }>();
			const loadInner = vi.fn(() => loaded.promise);
			const snapshot = vi.fn(transport(server['Remote']));
			const serverRemote = Server.lazy(async () => ({
				default: Server.externalSnapshotBoundary({
					authority,
					component: server['Remote'],
					snapshot,
					contextKeys: ['theme'],
				}),
			}));
			const clientRemote = Client.lazy(async () => {
				await admitted.promise;
				return {
					default: Client.externalSnapshotBoundary({
						authority,
						component: Client.lazy(loadInner),
						snapshot,
						contextKeys: ['theme'],
					}),
				};
			});
			const source = `import {Suspense} from 'octane';import {Theme} from './contexts';import {Remote} from './remote';export function App(props){return <Theme value={{title:props.title}}><Suspense fallback={<p>loading publisher</p>}><Remote label="Count" initial={3}/></Suspense></Theme>;}`;
			const serverApp = pair(source, '/host/OuterLazy.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Remote: serverRemote },
			}).server;
			const clientApp = pair(source, '/host/OuterLazy.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Remote: clientRemote },
			}).client;
			const options = { externalSnapshots: { documentId: 'outer-lazy-' + context } };
			const container = document.createElement('div');
			container.innerHTML = (await prerender(serverApp['App'], { title: 'server' }, options)).html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const section = container.querySelector('section')!;
			const input = container.querySelector('input')!;
			const button = container.querySelector('button')!;
			const id = input.id;
			input.value = 'typed before hydration';
			const errors: unknown[] = [];
			const title = context === 'same' ? 'server' : 'browser';
			const root = Client.hydrateRoot(
				container,
				clientApp['App'],
				{ title },
				{
					...options,
					onRecoverableError: (error) => errors.push(error),
					onUncaughtError: (error) => errors.push(error),
				},
			);
			const assertRetained = (phase: string) => {
				expect.soft(errors, phase + ': renderer errors').toEqual([]);
				expect.soft(container.querySelector('section'), phase + ': section').toBe(section);
				expect.soft(container.querySelector('input'), phase + ': input').toBe(input);
				expect.soft(container.querySelector('button'), phase + ': counter').toBe(button);
				expect
					.soft(container.querySelector('input')?.value, phase + ': draft')
					.toBe('typed before hydration');
				expect.soft(container.querySelector('input')?.id, phase + ': ID').toBe(id);
			};
			try {
				await Client.act(async () => {});
				assertRetained('before admission');
				expect(loadInner).not.toHaveBeenCalled();
				await Client.act(() => admitted.resolve());
				await vi.waitFor(() => expect(loadInner).toHaveBeenCalled());
				assertRetained('after admission');
				await Client.act(() => loaded.resolve({ default: client['Remote'] }));
				assertRetained('after module load');
				expect(container.querySelector('label')!.textContent).toBe(title);
				await Client.act(() => container.querySelector('button')!.click());
				expect(container.querySelector('button')!.textContent).toBe('Count:4');
				await Client.act(() => root.render(clientApp['App'], { title: 'live host' }));
				assertRetained('after live host update');
				expect(container.querySelector('label')!.textContent).toBe('live host');
				expect(container.querySelector('button')!.textContent).toBe('Count:4');
				expect(snapshot).toHaveBeenCalledTimes(1);
				expect(errors).toEqual([]);
			} finally {
				admitted.resolve();
				loaded.resolve({ default: client['Remote'] });
				root.unmount();
				container.remove();
			}
		},
	);

	it('retains external SSR nodes when host context commits during the admission-to-module gap', async () => {
		registerTheme();
		const { server, client } = fixtures(dev);
		const admitted = deferred<void>();
		const loaded = deferred<{ default: (typeof client)['Remote'] }>();
		const loadInner = vi.fn(() => loaded.promise);
		const snapshot = vi.fn(transport(server['Remote']));
		const serverRemote = Server.lazy(async () => ({
			default: Server.externalSnapshotBoundary({
				authority,
				component: server['Remote'],
				snapshot,
				contextKeys: ['theme'],
			}),
		}));
		const clientRemote = Client.lazy(async () => {
			await admitted.promise;
			return {
				default: Client.externalSnapshotBoundary({
					authority,
					component: Client.lazy(loadInner),
					snapshot,
					contextKeys: ['theme'],
				}),
			};
		});
		const source = `import {Suspense} from 'octane';import {Theme} from './contexts';import {Remote} from './remote';export function App(props){return <Theme value={{title:props.title}}><output data-host-context="">{props.title}</output><Suspense fallback={<p>loading publisher</p>}><Remote label="Count" initial={3}/></Suspense></Theme>;}`;
		const serverApp = pair(source, '/host/OuterLazy.tsx', dev, {
			'./contexts': { Theme },
			'./remote': { Remote: serverRemote },
		}).server;
		const clientApp = pair(source, '/host/OuterLazy.tsx', dev, {
			'./contexts': { Theme },
			'./remote': { Remote: clientRemote },
		}).client;
		const options = { externalSnapshots: { documentId: 'outer-lazy-context-gap' } };
		const container = document.createElement('div');
		container.innerHTML = (await prerender(serverApp['App'], { title: 'server' }, options)).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const section = container.querySelector('section')!;
		const input = container.querySelector('input')!;
		const button = container.querySelector('button')!;
		const id = input.id;
		input.value = 'typed before hydration';
		const errors: unknown[] = [];
		const title = 'server';
		const root = Client.hydrateRoot(
			container,
			clientApp['App'],
			{ title },
			{
				...options,
				onRecoverableError: (error) => errors.push(error),
				onUncaughtError: (error) => errors.push(error),
			},
		);
		const assertRetained = (phase: string) => {
			expect.soft(errors, phase + ': renderer errors').toEqual([]);
			expect.soft(container.querySelector('section'), phase + ': section').toBe(section);
			expect.soft(container.querySelector('input'), phase + ': input').toBe(input);
			expect.soft(container.querySelector('button'), phase + ': counter').toBe(button);
			expect
				.soft(container.querySelector('input')?.value, phase + ': draft')
				.toBe('typed before hydration');
			expect.soft(container.querySelector('input')?.id, phase + ': ID').toBe(id);
		};
		try {
			await Client.act(async () => {});
			assertRetained('before admission');
			expect(loadInner).not.toHaveBeenCalled();
			await Client.act(() => admitted.resolve());
			await vi.waitFor(() => expect(loadInner).toHaveBeenCalled());
			assertRetained('after admission');
			await Client.act(() => {
				Client.flushSync(() =>
					root.render(clientApp['App'], { title: 'updated during module gap' }),
				);
			});
			await Client.act(async () => {});
			expect(container.querySelector('[data-host-context]')!.textContent).toBe(
				'updated during module gap',
			);
			expect(loadInner).toHaveBeenCalledTimes(1);
			assertRetained('after committed host update while module is pending');
			await Client.act(() => loaded.resolve({ default: client['Remote'] }));
			assertRetained('after module load');
			expect(container.querySelector('label')!.textContent).toBe('updated during module gap');
			await Client.act(() => container.querySelector('button')!.click());
			expect(container.querySelector('button')!.textContent).toBe('Count:4');
			await Client.act(() => root.render(clientApp['App'], { title: 'live host' }));
			assertRetained('after live host update');
			expect(container.querySelector('label')!.textContent).toBe('live host');
			expect(container.querySelector('button')!.textContent).toBe('Count:4');
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(errors).toEqual([]);
		} finally {
			admitted.resolve();
			loaded.resolve({ default: client['Remote'] });
			root.unmount();
			container.remove();
		}
	});

	it('isolates same compiled signal sites and useId between boundaries', async () => {
		const { server, client } = fixtures(dev);
		const snapshot = async (request: Server.ExternalSnapshotRequest) =>
			Server.decodeExternalSnapshot(
				Server.serializeExternalSnapshot(
					await Server.renderExternalSnapshot(
						server['Remote'],
						Server.decodeExternalSnapshotRequest(
							Server.serializeExternalSnapshotRequest(request),
							authority,
						),
						{ authority },
					),
				),
			);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const sApp = () => [
			Server.createElement(S, { label: 'A', initial: 1 }),
			Server.createElement(S, { label: 'B', initial: 7 }),
		];
		const cApp = () => [
			Client.createElement(C, { label: 'A', initial: 1 }),
			Client.createElement(C, { label: 'B', initial: 7 }),
		];
		const html = (await prerender(sApp, {}, { externalSnapshots: { documentId: 'siblings' } }))
			.html;
		const container = document.createElement('div');
		container.innerHTML = html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const buttons = [...container.querySelectorAll('button')];
		const ids = [...container.querySelectorAll('input')].map((node) => node.id);
		const root = Client.hydrateRoot(
			container,
			cApp,
			{},
			{ externalSnapshots: { documentId: 'siblings' } },
		);
		try {
			await Client.act(async () => {});
			expect([...container.querySelectorAll('button')]).toEqual(buttons);
			expect(new Set(ids).size).toBe(2);
			await Client.act(() => buttons[0]!.click());
			expect(buttons.map((node) => node.textContent)).toEqual(['A:2', 'B:7']);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('consumes native use() history before an unresolved browser data loader', async () => {
		const source = `import {use,useId} from 'octane';import {load} from './data';export function Remote(){const value=use(load());const id=useId();return <output id={id}>{value}</output>;}`;
		const serverLoad = vi.fn(() => Promise.resolve('publisher data'));
		const clientLoad = vi.fn(() => new Promise<string>(() => {}));
		const server = pair(source, '/remote/History.tsx', dev, {
			'./data': { load: serverLoad },
		}).server;
		const client = pair(source, '/remote/History.tsx', dev, {
			'./data': { load: clientLoad },
		}).client;
		const snapshot = transport(server['Remote']);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const container = document.createElement('div');
		container.innerHTML = (
			await prerender(S, {}, { externalSnapshots: { documentId: 'history' } })
		).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const output = container.querySelector('output')!;
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			C,
			{},
			{
				externalSnapshots: { documentId: 'history' },
				onRecoverableError: (error) => errors.push(error),
				onUncaughtError: (error) => errors.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(container.querySelector('output')).toBe(output);
			expect(output.textContent).toBe('publisher data');
			expect(clientLoad).toHaveBeenCalled();
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('rejects mismatched browser authority before invoking the native component', async () => {
		const { server, client } = fixtures(dev);
		const snapshot = transport(server['Remote']);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const invoke = vi.fn<Client.ComponentBody<{ label: string; initial: number }>>(
			client['Remote'],
		);
		const C = Client.externalSnapshotBoundary({
			authority: { ...authority, publisherBuildId: 'foreign-build' },
			component: invoke,
			snapshot,
		});
		const container = document.createElement('div');
		container.innerHTML = (
			await prerender(
				S,
				{ label: 'admitted', initial: 1 },
				{ externalSnapshots: { documentId: 'browser-admission' } },
			)
		).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			C,
			{ label: 'admitted', initial: 1 },
			{
				externalSnapshots: { documentId: 'browser-admission' },
				onUncaughtError: (error) => errors.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(invoke).not.toHaveBeenCalled();
			expect(errors).toHaveLength(1);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('keeps host sibling IDs stable when external ID counts differ and one boundary mounts fresh', async () => {
		const source = `import {useId} from 'octane'; function Field() {const id=useId();return <input id={id} />;} export function Remote(props){return <section data-remote={props.label}><Field />{props.extra ? <Field /> : null}</section>;}`;
		const { server, client } = pair(source, '/remote/Ids.tsx', dev);
		const snapshot = transport(server['Remote']);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const hostSource = `import {useId} from 'octane';import {Boundary} from './remote';function HostId(props){const id=useId();return <span id={id} data-host={props.label}>{props.label}</span>;}export function App(){return <main><HostId label="before"/><Boundary label="a" extra={true}/><Boundary label="b" extra={false}/><HostId label="after"/></main>;}`;
		const sHost = pair(hostSource, '/host/Ids.tsx', dev, { './remote': { Boundary: S } }).server;
		const cHost = pair(hostSource, '/host/Ids.tsx', dev, { './remote': { Boundary: C } }).client;
		for (const fresh of [false, true]) {
			const result = await prerender(
				sHost['App'],
				{},
				{ externalSnapshots: { documentId: 'ids-' + fresh } },
			);
			const container = document.createElement('div');
			container.innerHTML = result.html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const hosts = [...container.querySelectorAll('[data-host]')];
			const hostIds = hosts.map((node) => node.id);
			const inputs = [...container.querySelectorAll('input')];
			if (fresh) {
				const wrapper = container.querySelector('[data-octane-hydrate-id]')!;
				expect(wrapper.firstChild!.nodeType).toBe(8);
				wrapper.firstChild!.remove();
			}
			const root = Client.hydrateRoot(
				container,
				cHost['App'],
				{},
				{ externalSnapshots: { documentId: 'ids-' + fresh } },
			);
			try {
				await Client.act(async () => {});
				expect([...container.querySelectorAll('[data-host]')]).toEqual(hosts);
				expect(hosts.map((node) => node.id)).toEqual(hostIds);
				expect(
					new Set([...hostIds, ...[...container.querySelectorAll('input')].map((node) => node.id)])
						.size,
				).toBe(5);
				expect(container.querySelector('[data-remote="b"] input')).toBe(inputs[2]);
			} finally {
				root.unmount();
				container.remove();
			}
		}
	});

	it('isolates a host global signal and two publishers while removing a pending sibling in either order', async () => {
		const source = `import {useContext,useState,useLayoutEffect} from 'octane';import {signal$} from 'octane/signals';import {Theme} from './contexts';export const value$=signal$(0);export function Remote(props){const theme=useContext(Theme);const [hydrated,setHydrated]=useState(false);useLayoutEffect(()=>setHydrated(true),[]);return <button data-hydrated={hydrated} data-global={props.label} onClick={()=>value$.set(value=>value+1)}>{props.label + ':' + value$.get() + ':' + theme.title}</button>;}`;
		const { server, client } = pair(source, '/shared/Global.tsx', dev, {
			'./contexts': { Theme },
			'octane/signals': Signals,
		});
		registerTheme();
		const secondAuthority = { ...authority, publisherBuildId: 'second-publisher' };
		for (const removed of ['a', 'b']) {
			const pending = deferred<{ default: (typeof client)['Remote'] }>();
			const invoke = vi.fn(client['Remote']);
			const make = (label: string, mode: 'client' | 'server') => {
				const selectedAuthority = label === 'a' ? authority : secondAuthority;
				const options = {
					authority: selectedAuthority,
					contextKeys: ['theme'],
					snapshot: (request: Server.ExternalSnapshotRequest, signal?: AbortSignal) =>
						Server.renderExternalSnapshot(server['Remote'], request, {
							authority: selectedAuthority,
							...(signal === undefined ? {} : { signal }),
						}),
				};
				return mode === 'server'
					? Server.externalSnapshotBoundary({ ...options, component: server['Remote'] })
					: Client.externalSnapshotBoundary({
							...options,
							component: label === removed ? Client.lazy(() => pending.promise) : client['Remote'],
						});
			};
			const hostSource = `import {Theme} from './contexts';import {Local,A,B} from './remote';export function App(props){return <Theme value={{title:props.title}}><main><Local label="host"/>{props.a ? <A label="a"/> : null}{props.b ? <B label="b"/> : null}</main></Theme>;}`;
			const sHost = pair(hostSource, '/host/Global.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Local: server['Remote'], A: make('a', 'server'), B: make('b', 'server') },
			}).server;
			const cHost = pair(hostSource, '/host/Global.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Local: client['Remote'], A: make('a', 'client'), B: make('b', 'client') },
			}).client;
			const options = { externalSnapshots: { documentId: 'globals-' + removed } };
			const html = (await prerender(sHost['App'], { a: true, b: true, title: 'server' }, options))
				.html;
			const container = document.createElement('div');
			container.innerHTML = html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const survivor = removed === 'a' ? 'b' : 'a';
			const survivorButton = container.querySelector(
				`[data-global="${survivor}"]`,
			) as HTMLButtonElement;
			const errors: unknown[] = [];
			const root = Client.hydrateRoot(
				container,
				cHost['App'],
				{ a: true, b: true, title: 'server' },
				{
					...options,
					onRecoverableError: (error) => errors.push(error),
					onUncaughtError: (error) => errors.push(error),
				},
			);
			try {
				await Client.act(async () => {});
				expect(errors).toEqual([]);
				expect(container.querySelector(`[data-global="${survivor}"]`)).toBe(survivorButton);
				expect(survivorButton.dataset['hydrated']).toBe('true');
				await Client.act(() => survivorButton.click());
				expect(survivorButton.textContent).toBe(survivor + ':1:server');
				expect(container.querySelector('[data-global="host"]')!.textContent).toBe('host:0:server');
				await Client.act(() =>
					root.render(cHost['App'], { a: removed !== 'a', b: removed !== 'b', title: 'live' }),
				);
				pending.resolve({ default: invoke });
				await Client.act(async () => {});
				expect(invoke).not.toHaveBeenCalled();
				expect(container.querySelector(`[data-global="${removed}"]`)).toBeNull();
				expect(container.querySelector(`[data-global="${survivor}"]`)).toBe(survivorButton);
				expect(survivorButton.dataset['hydrated']).toBe('true');
				await Client.act(() => survivorButton.click());
				expect(survivorButton.textContent).toBe(survivor + ':2:live');
				expect(container.querySelector('[data-global="host"]')!.textContent).toBe('host:0:live');
				expect(errors).toEqual([]);
			} finally {
				root.unmount();
				container.remove();
			}
		}
	});

	it('adopts each publisher head node and deduplicates native styles against the host', async () => {
		const source = `export function Remote(props) @{ <><meta name={props.label} content={props.title} /><style>.external {color: rebeccapurple;}</style><section class="external">{props.label as string}</section></> }`;
		const { server, client } = pair(source, '/remote/Head.tsrx', dev);
		const snapshot = transport(server['Remote']);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const hostSource = `import {Boundary, Local} from './remote'; export function App(props) @{ <><Local label="host" title="host title" /><Boundary label="a" title={props.title} />@if(props.second) {<Boundary label="b" title="b title" />}</> }`;
		const hostServer = pair(hostSource, '/host/Head.tsrx', dev, {
			'./remote': { Boundary: S, Local: server['Remote'] },
		}).server;
		const hostClient = pair(hostSource, '/host/Head.tsrx', dev, {
			'./remote': { Boundary: C, Local: client['Remote'] },
		}).client;
		const result = await prerender(
			hostServer['App'],
			{ title: 'a title', second: true },
			{ externalSnapshots: { documentId: 'head-doc' }, headChannel: 'separate' },
		);
		document.head.innerHTML = result.css + result.head;
		const container = document.createElement('div');
		container.innerHTML = result.html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const heads = ['host', 'a', 'b'].map((name) =>
			document.head.querySelector(`meta[name="${name}"]`)!,
		);
		expect(heads.every(Boolean)).toBe(true);
		expect(document.head.querySelectorAll('style')).toHaveLength(1);
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			hostClient['App'],
			{ title: 'a title', second: true },
			{
				externalSnapshots: { documentId: 'head-doc' },
				onRecoverableError: (error) => errors.push(error),
				onUncaughtError: (error) => errors.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(
				['host', 'a', 'b'].map((name) => document.head.querySelector(`meta[name="${name}"]`)),
			).toEqual(heads);
			expect(document.head.querySelectorAll('meta')).toHaveLength(3);
			expect(errors).toEqual([]);
			await Client.act(() =>
				root.render(hostClient['App'], { title: 'live title', second: false }),
			);
			expect(heads[1]!.getAttribute('content')).toBe('live title');
			expect(heads[2]!.isConnected).toBe(false);
			expect(heads[0]!.isConnected).toBe(true);
		} finally {
			root.unmount();
			container.remove();
		}
		expect(heads.some((node) => node.isConnected)).toBe(false);
	});

	it('adopts publisher head nodes when its body recovers with a fresh ID namespace', async () => {
		const source = `export function Remote() @{ <><p>publisher body</p><meta name="recovered-publisher" content="owned" /></> }`;
		const { server, client } = pair(source, '/remote/RecoverHead.tsrx', dev);
		const snapshot = transport(server['Remote']);
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const options = { externalSnapshots: { documentId: 'recover-head' } };
		const result = await prerender(S, {}, { ...options, headChannel: 'separate' });
		if (result.head === undefined) throw new Error('Separate head output is required.');
		document.head.innerHTML = result.head;
		const head = document.head.querySelector('meta[name="recovered-publisher"]')!;
		expect(head).not.toBeNull();
		const container = document.createElement('div');
		container.innerHTML = result.html;
		const changed = document.createElement('section');
		changed.textContent = 'replaced server body';
		const serverBody = container.querySelector('p')!;
		serverBody.replaceWith(changed);
		activateStreamedMarkup(container);
		document.body.append(container);
		const uncaught: unknown[] = [];
		const recoverable = vi.fn<(error: unknown) => void>();
		const root = Client.hydrateRoot(
			container,
			C,
			{},
			{
				...options,
				onRecoverableError: recoverable,
				onUncaughtError: (error) => uncaught.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(container.querySelector('p')?.textContent).toBe('publisher body');
			expect(container.querySelector('p')).not.toBe(serverBody);
			expect(changed.isConnected).toBe(false);
			expect(container.querySelector('section')).toBeNull();
			expect(document.head.querySelectorAll('meta[name="recovered-publisher"]')).toHaveLength(1);
			expect(document.head.querySelector('meta[name="recovered-publisher"]')).toBe(head);
			expect(uncaught).toEqual([]);
			// Joining the publisher recreates its descriptor children before activation.
			// Uncertified changed captures mark this recovery stale, which reports nothing.
			expect(recoverable).not.toHaveBeenCalled();
		} finally {
			root.unmount();
			container.remove();
		}
		expect(head.isConnected).toBe(false);
	});

	it('reports unchanged host island structural recovery while preserving its external publisher sibling', async () => {
		const remote = pair(
			`export function Remote() @{ <section data-publisher="">publisher body</section> }`,
			'/remote/RecoveryControl.tsrx',
			dev,
		);
		const snapshot = transport(remote.server['Remote']);
		const S = Server.externalSnapshotBoundary({
			authority,
			component: remote.server['Remote'],
			snapshot,
		});
		const C = Client.externalSnapshotBoundary({
			authority,
			component: remote.client['Remote'],
			snapshot,
		});
		const source = `import {Hydrate} from 'octane';import {load} from 'octane/hydration';import {Boundary} from './remote';export function App() @{ <main><Hydrate split={false} when={load()}><p data-host="stable">unchanged host</p></Hydrate><Boundary /></main> }`;
		const server = pair(source, '/host/RecoveryControl.tsrx', dev, {
			'./remote': { Boundary: S },
		}).server;
		const client = pair(source, '/host/RecoveryControl.tsrx', dev, {
			'./remote': { Boundary: C },
		}).client;
		const options = { externalSnapshots: { documentId: 'structural-recovery-control' } };
		const container = document.createElement('div');
		container.innerHTML = (await prerender(server['App'], {}, options)).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const host = container.querySelector('[data-host]')!;
		const publisher = container.querySelector('[data-publisher]')!;
		const changed = document.createElement('section');
		changed.textContent = 'corrupted host island';
		host.replaceWith(changed);
		const recoverable = vi.fn<(error: unknown) => void>();
		const uncaught: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			client['App'],
			{},
			{
				...options,
				onRecoverableError: recoverable,
				onUncaughtError: (error) => uncaught.push(error),
			},
		);
		try {
			await Client.act(async () => {});
			expect(container.querySelector('[data-host]')?.textContent).toBe('unchanged host');
			expect(container.querySelector('[data-host]')).not.toBe(host);
			expect(changed.isConnected).toBe(false);
			expect(container.querySelector('[data-publisher]')).toBe(publisher);
			expect(publisher.textContent).toBe('publisher body');
			expect(uncaught).toEqual([]);
			expect(recoverable).toHaveBeenCalledTimes(1);
			expect(recoverable).toHaveBeenCalledWith(
				expect.objectContaining({
					message: expect.stringMatching(
						/^Hydration failed because the server rendered HTML didn't match the client\./,
					),
				}),
			);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('delivers external native CSS before a late streamed content segment', async () => {
		const source = `export function Remote() @{ <><style>.publisher {color: rebeccapurple;}</style><section class="publisher">late publisher</section></> }`;
		const fixture = { id: '/remote/LateStyle.tsrx', compileOptions: { dev } };
		const server = loadCompiledFixtureSource(source, { ...fixture, mode: 'server' });
		const pending = deferred<Server.ExternalSnapshot>();
		let captured: Server.ExternalSnapshotRequest | undefined;
		const signals: AbortSignal[] = [];
		const snapshot = (request: Server.ExternalSnapshotRequest, signal?: AbortSignal) => {
			signals.push(signal!);
			if (captured !== undefined) {
				expect(signals[0]!.aborted).toBe(true);
				return Server.renderExternalSnapshot(server['Remote'], request, {
					authority,
					...(signal === undefined ? {} : { signal }),
				});
			}
			captured = request;
			return pending.promise;
		};
		const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
		const sApp = () =>
			Server.createElement(Server.Suspense, {
				fallback: Server.createElement('p', { children: 'waiting' }),
				children: Server.createElement(S, {}),
			});
		const heads: string[] = [];
		const serverErrors: unknown[] = [];
		const stream = await Server.renderToReadableStream(
			sApp,
			{},
			{
				externalSnapshots: { documentId: 'late-style' },
				headChannel: 'separate',
				onHeadReady: (head) => heads.push(head),
				onError: (error) => serverErrors.push(error),
			},
		);
		const html = new Response(stream).text();
		await vi.waitFor(() => expect(captured).toBeDefined());
		pending.resolve(
			await Server.renderExternalSnapshot(server['Remote'], captured!, { authority }),
		);
		const text = await html;
		expect(serverErrors).toEqual([]);
		expect(heads).toEqual(['']);
		expect(text.indexOf('<style data-octane=')).toBeGreaterThan(-1);
		expect(text.indexOf('<style data-octane=')).toBeLessThan(
			text.indexOf('<div hidden data-oct-s='),
		);
		const container = document.createElement('div');
		container.innerHTML = text;
		document.body.append(container);
		activateStreamedMarkup(container);
		await vi.waitFor(() => expect(container.querySelector('section')).not.toBeNull());
		const section = container.querySelector('section')!;
		expect(document.querySelectorAll('style[data-octane]')).toHaveLength(1);
		expect(getComputedStyle(section).color).toBe('rgb(102, 51, 153)');
		const client = loadCompiledFixtureSource(source, { ...fixture, mode: 'client' });
		const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
		const cApp = () =>
			Client.createElement(Client.Suspense, {
				fallback: Client.createElement('p', { children: 'waiting' }),
				children: Client.createElement(C, {}),
			});
		const root = Client.hydrateRoot(
			container,
			cApp,
			{},
			{ externalSnapshots: { documentId: 'late-style' } },
		);
		try {
			await Client.act(async () => {});
			expect(container.querySelector('section')).toBe(section);
			expect(document.querySelectorAll('style[data-octane]')).toHaveLength(1);
		} finally {
			root.unmount();
			container.remove();
		}
	});
});

// Keep the adapter's descriptor/wrapper shape separate from the compiled JSX
// regression above. The controls vary only native ownership and SSR delivery;
// explicit development-mode coverage remains in the original four-case test.
it.each([
	{ boundary: 'plain', delivery: 'prerender' },
	{ boundary: 'plain', delivery: 'stream' },
	{ boundary: 'publisher', delivery: 'prerender' },
	{ boundary: 'publisher', delivery: 'stream' },
	{ boundary: 'external', delivery: 'prerender' },
	{ boundary: 'external', delivery: 'stream' },
] as const)(
	'retains adapter-shaped lazy SSR nodes with $boundary ownership and $delivery delivery',
	async ({ boundary, delivery }) => {
		const serverTheme = Server.createContext({ title: 'default' });
		const clientTheme = Client.createContext({ title: 'default' });
		releases.push(
			registerExternalSnapshotContext(serverTheme, {
				key: 'theme',
				encode: (value: { title: string }) => value.title,
				decode: (value) => ({ title: String(value) }),
			}),
		);
		const fixture = { id: '/remote/Widget.tsx', compileOptions: { dev: false } };
		const server = loadCompiledFixtureSource(remoteSource, {
			...fixture,
			mode: 'server',
			runtimeModules: {
				'./contexts': { Theme: serverTheme },
				'octane/signals/server': ServerSignals,
			},
		});
		const client = loadCompiledFixtureSource(remoteSource, {
			...fixture,
			mode: 'client',
			runtimeModules: {
				'./contexts': { Theme: clientTheme },
				'octane/signals/client': ClientSignals,
			},
		});
		type Props = { label: string; initial: number };
		const admitted = deferred<void>();
		const loaded = deferred<{ default: (typeof client)['Remote'] }>();
		const loadInner = vi.fn(() => loaded.promise);
		const inner = Client.lazy(loadInner);
		const snapshot = vi.fn(transport(server['Remote']));
		const serverBoundary =
			boundary === 'external'
				? Server.externalSnapshotBoundary({
						authority,
						component: server['Remote'],
						snapshot,
						contextKeys: ['theme'],
					})
				: boundary === 'publisher'
					? Server.publisherBoundary(server['Remote'], { publisherKey: 'adapter/Widget' })
					: server['Remote'];
		const clientBoundary =
			boundary === 'external'
				? Client.externalSnapshotBoundary({
						authority,
						component: inner,
						snapshot,
						contextKeys: ['theme'],
					})
				: boundary === 'publisher'
					? Client.publisherBoundary(inner, { publisherKey: 'adapter/Widget' })
					: inner;
		const ServerLoaded = (props: Props) => {
			Server.preinit('/adapter-publisher.css', { as: 'style', precedence: 'federated' });
			return Server.createElement(serverBoundary, props);
		};
		const ClientLoaded = (props: Props) => {
			Client.preinit('/adapter-publisher.css', { as: 'style', precedence: 'federated' });
			return Client.createElement(clientBoundary, props);
		};
		const serverModule = deferred<{ default: typeof ServerLoaded }>();
		const serverLazy = Server.lazy(() => serverModule.promise);
		const clientLazy = Client.lazy(async () => {
			await admitted.promise;
			return { default: ClientLoaded };
		});
		const serverApp = (props: { title: string }) =>
			Server.createElement(serverTheme, {
				value: { title: props.title },
				children: Server.createElement(Server.Suspense, {
					fallback: undefined,
					children: Server.createElement(serverLazy, { label: 'Count', initial: 3 }),
				}),
			});
		const clientApp = (props: { title: string }) =>
			Client.createElement(clientTheme, {
				value: { title: props.title },
				children: Client.createElement(Client.Suspense, {
					fallback: undefined,
					children: Client.createElement(clientLazy, { label: 'Count', initial: 3 }),
				}),
			});
		const identity = {
			buildId: 'adapter-lazy-build',
			documentId: 'adapter-lazy-' + boundary + '-' + delivery,
		};
		const options = {
			externalSnapshots: { documentId: identity.documentId },
			streamedSignals: identity,
			earlySignalBootstrap: 'external' as const,
		};
		const errors: unknown[] = [];
		const container = document.createElement('div');
		document.body.append(container);
		let root: ReturnType<typeof Client.hydrateRoot> | undefined;
		let bridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		let stream: ReturnType<typeof Server.renderToPipeableStream> | undefined;
		try {
			let html: string;
			if (delivery === 'stream') {
				const collector = createPipeableCollector();
				const shell = deferred<void>();
				stream = Server.renderToPipeableStream(
					serverApp,
					{ title: 'server' },
					{
						...options,
						onShellReady: () => shell.resolve(),
						onShellError: (error) => shell.reject(error),
						onError: (error) => errors.push(error),
					},
				);
				stream.pipe(collector.destination);
				await shell.promise;
				serverModule.resolve({ default: ServerLoaded });
				html = await collector.ended;
			} else {
				const rendered = prerender(serverApp, { title: 'server' }, options);
				serverModule.resolve({ default: ServerLoaded });
				html = (await rendered).html;
			}
			container.innerHTML = Server.earlySignalBootstrapScript() + html;
			activateStreamedMarkup(container);
			const section = container.querySelector('section');
			expect(section, 'resolved server section').not.toBeNull();
			const input = section!.querySelector('input')!;
			const button = section!.querySelector('button')!;
			const id = input.id;
			input.value = 'typed before hydration';
			const assertRetained = (phase: string) => {
				expect.soft(errors, phase + ': renderer errors').toEqual([]);
				expect.soft(container.querySelector('section'), phase + ': section').toBe(section);
				expect.soft(container.querySelector('input'), phase + ': input').toBe(input);
				expect.soft(container.querySelector('button'), phase + ': counter').toBe(button);
				expect.soft(container.querySelector('input')?.id, phase + ': ID').toBe(id);
				expect
					.soft(container.querySelector('input')?.value, phase + ': draft')
					.toBe('typed before hydration');
			};
			bridge = bootstrapStreamedSignalHydration(identity);
			await Client.act(() => {
				root = Client.hydrateRoot(
					container,
					clientApp,
					{ title: 'server' },
					{
						externalSnapshots: options.externalSnapshots,
						signalOwner: bridge!.signalOwner,
						onRecoverableError: (error) => errors.push(error),
						onUncaughtError: (error) => errors.push(error),
					},
				);
			});
			assertRetained('before admission');
			expect(loadInner).not.toHaveBeenCalled();
			await Client.act(() => admitted.resolve());
			await vi.waitFor(() => expect(loadInner).toHaveBeenCalled());
			assertRetained('after admission, before module');
			await Client.act(() => loaded.resolve({ default: client['Remote'] }));
			assertRetained('after module load');
			expect(container.querySelector('label')!.textContent).toBe('server');
			await Client.act(() => container.querySelector('button')!.click());
			expect(container.querySelector('button')!.textContent).toBe('Count:4');
			await Client.act(() => root!.render(clientApp, { title: 'live host' }));
			assertRetained('after live host update');
			expect(container.querySelector('label')!.textContent).toBe('live host');
			expect(container.querySelector('button')!.textContent).toBe('Count:4');
			expect(errors).toEqual([]);
		} finally {
			admitted.resolve();
			loaded.resolve({ default: client['Remote'] });
			serverModule.resolve({ default: ServerLoaded });
			root?.unmount();
			bridge?.dispose();
			stream?.abort();
			container.remove();
			Reflect.deleteProperty(globalThis, '__octaneStreamedSignalSelections');
			Reflect.deleteProperty(globalThis, '__octaneStreamedRenderer');
		}
	},
);

it.each([false, true])(
	'adopts a streamed external useState component through delayed forwarding lazy wrappers, transparent contexts=%s',
	async (contexts) => {
		type Props = { label: string };
		const source = `import { useLayoutEffect, useState } from 'octane';
import { recordCommit } from './observer';
export function Remote(props: { label: string }) {
  const [count, setCount] = useState(3);
  useLayoutEffect(() => { recordCommit(); }, []);
  return <section data-worker-adoption=""><input defaultValue="server draft" /><button data-counter="" onClick={() => setCount(value => value + 1)}>{props.label}: {count}</button></section>;
}`;
		let commits = 0;
		const fixture = { id: '/worker-adoption/Widget.tsx', compileOptions: { dev: false } };
		const server = loadCompiledFixtureSource<{
			Remote: (props: Props) => ReturnType<typeof Server.createElement>;
		}>(source, {
			...fixture,
			mode: 'server',
			runtimeModules: { './observer': { recordCommit() {} } },
		});
		const client = loadCompiledFixtureSource<{ Remote: Client.ComponentBody<Props> }>(source, {
			...fixture,
			mode: 'client',
			runtimeModules: {
				'./observer': {
					recordCommit() {
						commits++;
					},
				},
			},
		});
		const admitted = deferred<void>();
		const loaded = deferred<{ default: Client.ComponentBody<Props> }>();
		const loadInner = vi.fn(() => loaded.promise);
		const inner = Client.lazy(loadInner);
		const snapshot = transport(server.Remote);
		const serverBoundary = Server.externalSnapshotBoundary({
			authority,
			component: server.Remote,
			snapshot,
			contextKeys: [],
		});
		const clientBoundary = Client.externalSnapshotBoundary({
			authority,
			component: inner,
			snapshot,
			contextKeys: [],
		});
		const ServerLoaded = (props: Props) => Server.createElement(serverBoundary, props);
		const ClientLoaded = (props: Props) => Client.createElement(clientBoundary, props);
		const Forwarded: Client.ComponentBody<Props> = (props, scope, extra) =>
			client.Remote(props, scope, extra);
		const serverLazy = Server.lazy(async () => ({ default: ServerLoaded }));
		const clientLazy = Client.lazy(async () => {
			await admitted.promise;
			return { default: ClientLoaded };
		});
		const serverRemote = () =>
			Server.createElement(Server.Suspense, {
				fallback: undefined,
				children: Server.createElement(serverLazy, { label: 'Native' }),
			});
		const clientRemote = () =>
			Client.createElement(Client.Suspense, {
				fallback: undefined,
				children: Client.createElement(clientLazy, { label: 'Native' }),
			});
		// Server and client application adapters insert transparent return-based
		// wrappers around two real providers; component names and call ownership
		// differ while the publisher's visible output remains identical.
		type ProviderProps = { children?: unknown };
		const serverWorkerContext = Server.createContext('worker');
		const serverFederationContext = Server.createContext('federation');
		const clientWorkerContext = Client.createContext('worker');
		const clientFederationContext = Client.createContext('federation');
		const ServerWorkerRoot = (props: ProviderProps) =>
			Server.createElement(serverWorkerContext, {
				value: 'worker',
				children: props.children,
			});
		const ServerFederationRoot = (props: ProviderProps) =>
			Server.createElement(serverFederationContext, {
				value: 'federation',
				children: props.children,
			});
		const ClientWorkerRoot = (props: ProviderProps) =>
			Client.createElement(clientWorkerContext, {
				value: 'worker',
				children: props.children,
			});
		const ClientFederationRoot = (props: ProviderProps) =>
			Client.createElement(clientFederationContext, {
				value: 'federation',
				children: props.children,
			});
		const ServerInputApp = () => Server.createElement(serverRemote, {});
		const ClientInputApp = () => Client.createElement(clientRemote, {});
		const ServerApp = () =>
			Server.createElement(ServerFederationRoot, {
				children: Server.createElement(ServerInputApp, {}),
			});
		const ServerNativeApp = () =>
			Server.createElement(ServerWorkerRoot, {
				children: Server.createElement(ServerApp, {}),
			});
		const ClientFederationApplication = () =>
			Client.createElement(ClientFederationRoot, {
				children: Client.createElement(ClientInputApp, {}),
			});
		const ClientWorkerApplication = () =>
			Client.createElement(ClientWorkerRoot, {
				children: Client.createElement(ClientFederationApplication, {}),
			});
		const serverApp = contexts ? ServerNativeApp : serverRemote;
		const clientApp = contexts ? ClientWorkerApplication : clientRemote;
		const identity = {
			buildId: 'forwarded-host',
			documentId: 'forwarded-external-document-' + contexts,
		};
		const errors: unknown[] = [];
		const collector = createPipeableCollector();
		const stream = Server.renderToPipeableStream(
			serverApp,
			{},
			{
				externalSnapshots: { documentId: identity.documentId },
				streamedSignals: identity,
				earlySignalBootstrap: 'external',
				onError: (error) => errors.push(error),
			},
		);
		stream.pipe(collector.destination);
		const container = document.createElement('div');
		document.body.append(container);
		let root: ReturnType<typeof Client.hydrateRoot> | undefined;
		let bridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			container.innerHTML = Server.earlySignalBootstrapScript() + (await collector.ended);
			activateStreamedMarkup(container, { removeScripts: false });
			const section = container.querySelector('section');
			const input = section?.querySelector('input');
			const button = section?.querySelector('button');
			if (!section || !input || !button)
				throw new Error('The streamed publisher did not emit its Widget');
			input.value = 'typed before hydration';
			const assertRetained = () => {
				expect(container.querySelectorAll('section')).toHaveLength(1);
				expect(container.querySelectorAll('button')).toHaveLength(1);
				expect(container.querySelector('section')).toBe(section);
				expect(container.querySelector('input')).toBe(input);
				expect(container.querySelector('button')).toBe(button);
				expect(input.value).toBe('typed before hydration');
				expect(errors).toEqual([]);
			};
			bridge = bootstrapStreamedSignalHydration(identity);
			await Client.act(() => {
				root = Client.hydrateRoot(
					container,
					clientApp,
					{},
					{
						externalSnapshots: { documentId: identity.documentId },
						signalOwner: bridge!.signalOwner,
						onRecoverableError: (error) => errors.push(error),
						onUncaughtError: (error) => errors.push(error),
					},
				);
			});
			assertRetained();
			expect(loadInner).not.toHaveBeenCalled();
			await Client.act(() => admitted.resolve());
			await vi.waitFor(() => expect(loadInner).toHaveBeenCalledOnce());
			assertRetained();
			expect(commits).toBe(0);
			await Client.act(() => loaded.resolve({ default: Forwarded }));
			assertRetained();
			expect(commits).toBe(1);
			expect(button.textContent).toBe('Native: 3');
			await Client.act(() => button.click());
			assertRetained();
			expect(button.textContent).toBe('Native: 4');
		} finally {
			admitted.resolve();
			loaded.resolve({ default: Forwarded });
			root?.unmount();
			bridge?.dispose();
			stream.abort();
			container.remove();
		}
	},
);

it.each(['unmount', 'retire', 'resume'] as const)(
	'keeps pending publisher activation inside the frozen document lifetime: %s',
	async (ending) => {
		const execute = vi.fn();
		const modules = pair(
			`import {onExecute} from './callbacks';export function Remote(){onExecute();return <button>publisher</button>;}`,
			'/remote/PendingNativeBootstrap.tsx',
			false,
			{ './callbacks': { onExecute: execute } },
		);
		const snapshot = transport(modules.server['Remote']);
		const server = Server.externalSnapshotBoundary({
			authority,
			component: modules.server['Remote'],
			snapshot,
		});
		const client = Client.externalSnapshotBoundary({
			authority,
			component: modules.client['Remote'],
			snapshot,
		});
		const documentId = 'pending-native-' + ending;
		const container = document.createElement('div');
		container.innerHTML = (await prerender(server, {}, { externalSnapshots: { documentId } })).html;
		activateStreamedMarkup(container);
		document.body.append(container);
		const button = container.querySelector('button');
		const bridge = bootstrapStreamedSignalHydration({
			buildId: 'pending-host',
			documentId,
			signalOwner: Object.freeze({ scopeKey: 'octane:document' }),
		});
		const lifecycle = installSignalDocumentLifecycle({
			document,
			buildId: 'pending-host',
			documentId,
			signalOwner: bridge.signalOwner,
			readIdentity: () => ({ buildId: 'pending-host', documentId }),
		});
		const transition = (type: string) => {
			const event = new Event(type);
			Object.defineProperty(event, 'persisted', { value: true });
			window.dispatchEvent(event);
		};
		transition('pagehide');
		execute.mockClear();
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			client,
			{},
			{
				externalSnapshots: { documentId },
				signalOwner: bridge.signalOwner,
				onUncaughtError: (error) => errors.push(error),
				onRecoverableError: (error) => errors.push(error),
			},
		);
		try {
			Client.flushSync(() => {});
			// Captured input must not bypass the pending native preparation gate.
			button!.click();
			expect(execute).not.toHaveBeenCalled();
			if (ending === 'unmount') root.unmount();
			if (ending === 'retire') lifecycle.dispose();
			await Client.act(async () => {});
			expect(execute).not.toHaveBeenCalled();
			if (ending === 'resume') {
				transition('pageshow');
				await Client.act(async () => {});
				expect(execute).toHaveBeenCalled();
				expect(container.querySelector('button')).toBe(button);
			} else {
				transition('pageshow');
				await Client.act(async () => {});
				expect(execute).not.toHaveBeenCalled();
			}
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			lifecycle.dispose();
			bridge.dispose();
			container.remove();
		}
	},
);
