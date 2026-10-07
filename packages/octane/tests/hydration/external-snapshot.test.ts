import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { prerender } from '../../src/runtime.server.js';
import * as ClientSignals from '../../src/signals/client.js';
import * as ServerSignals from '../../src/signals/server.js';
import * as Signals from '../../src/signals/index.js';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, deferred, resetStreamRuntimeGlobals } from '../_server-stream.js';
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
	return async (request, signal?: AbortSignal) => {
		const prepared = await Server.prepareExternalSnapshotRequest(
			Server.serializeExternalSnapshotRequest(request),
			{ authority, signal },
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
	it('transfers only the publisher keys and owns codec registration until disposal', async () => {
		const decode = vi.fn((value) => ({ title: String(value) }));
		const codec = { key: 'theme', encode: (value: { title: string }) => value.title, decode };
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
				encode: (value) => value,
				decode: (value) => value,
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
					? Server.renderExternalSnapshot(component, request, { authority, signal })
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

function fixtures(dev: boolean) {
	const modules = { './contexts': { Theme, Other } };
	const server = loadCompiledFixtureSource(remoteSource, {
		id: '/remote/Widget.tsx',
		mode: 'server',
		compileOptions: { dev },
		runtimeModules: { ...modules, 'octane/signals/server': ServerSignals },
	});
	const client = loadCompiledFixtureSource(remoteSource, {
		id: '/remote/Widget.tsx',
		mode: 'client',
		compileOptions: { dev },
		runtimeModules: { ...modules, 'octane/signals/client': ClientSignals },
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
	it('retains compiled signal and ID adoption with publisher-local native providers', async () => {
		const { server, client } = pair(
			`import {useContext,useId} from 'octane';import {useSignal$} from 'octane/signals/client';import {Other} from './contexts';export function Remote(props){const value$=useSignal$(props.initial);const id=useId();const context=useContext(Other);return <section><input id={id} defaultValue="draft"/><button onClick={()=>value$.set(value=>value+1)}>{props.label+':'+value$.get()+':'+context}</button></section>;}`,
			'/remote/LocalProvider.tsx',
			dev,
			{
				'./contexts': { Other },
				'octane/signals/server': ServerSignals,
				'octane/signals/client': ClientSignals,
			},
		);
		const snapshot = async (request, signal) => {
			const prepared = await Server.prepareExternalSnapshotRequest(request, {
				authority,
				signal,
				initializeContexts: (provide) => provide(Other, 'publisher local'),
			});
			try {
				return await Server.renderExternalSnapshot(server.Remote, prepared);
			} finally {
				await Server.releasePreparedExternalSnapshotRequest(prepared);
			}
		};
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
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
		const app = (props) =>
			Client.createElement(Other, {
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
		registerTheme();
		const { server, client } = fixtures(dev);
		const pending = deferred<{ default: typeof client.Remote }>();
		const snapshot = vi.fn(async (request) =>
			Server.decodeExternalSnapshot(
				Server.serializeExternalSnapshot(
					await Server.renderExternalSnapshot(
						server.Remote,
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
			component: server.Remote,
			snapshot,
			contextKeys: ['theme'],
		});
		const ClientBoundary = Client.externalSnapshotBoundary({
			authority,
			component: Client.lazy(() => pending.promise),
			snapshot,
			contextKeys: ['theme'],
		});
		const serverApp = (props) =>
			Server.createElement(Theme, {
				value: { title: props.title },
				children: Server.createElement(ServerBoundary, { label: 'Count', initial: 3 }),
			});
		const clientApp = (props) =>
			Client.createElement(Theme, {
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
			pending.resolve({ default: client.Remote });
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

	it('isolates same compiled signal sites and useId between boundaries', async () => {
		const { server, client } = fixtures(dev);
		const snapshot = async (request) =>
			Server.decodeExternalSnapshot(
				Server.serializeExternalSnapshot(
					await Server.renderExternalSnapshot(
						server.Remote,
						Server.decodeExternalSnapshotRequest(
							Server.serializeExternalSnapshotRequest(request),
							authority,
						),
						{ authority },
					),
				),
			);
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
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
		const snapshot = transport(server.Remote);
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
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
		const snapshot = transport(server.Remote);
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const invoke = vi.fn(client.Remote);
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
		const snapshot = transport(server.Remote);
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
		const hostSource = `import {useId} from 'octane';import {Boundary} from './remote';function HostId(props){const id=useId();return <span id={id} data-host={props.label}>{props.label}</span>;}export function App(){return <main><HostId label="before"/><Boundary label="a" extra={true}/><Boundary label="b" extra={false}/><HostId label="after"/></main>;}`;
		const sHost = pair(hostSource, '/host/Ids.tsx', dev, { './remote': { Boundary: S } }).server;
		const cHost = pair(hostSource, '/host/Ids.tsx', dev, { './remote': { Boundary: C } }).client;
		for (const fresh of [false, true]) {
			const result = await prerender(
				sHost.App,
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
				cHost.App,
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
			const pending = deferred<{ default: typeof client.Remote }>();
			const invoke = vi.fn(client.Remote);
			const make = (label: string, mode: 'client' | 'server') => {
				const selectedAuthority = label === 'a' ? authority : secondAuthority;
				return (mode === 'client' ? Client : Server).externalSnapshotBoundary({
					authority: selectedAuthority,
					component:
						mode === 'server'
							? server.Remote
							: label === removed
								? Client.lazy(() => pending.promise)
								: client.Remote,
					contextKeys: ['theme'],
					snapshot: (request, signal) =>
						Server.renderExternalSnapshot(server.Remote, request, {
							authority: selectedAuthority,
							signal,
						}),
				});
			};
			const hostSource = `import {Theme} from './contexts';import {Local,A,B} from './remote';export function App(props){return <Theme value={{title:props.title}}><main><Local label="host"/>{props.a ? <A label="a"/> : null}{props.b ? <B label="b"/> : null}</main></Theme>;}`;
			const sHost = pair(hostSource, '/host/Global.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Local: server.Remote, A: make('a', 'server'), B: make('b', 'server') },
			}).server;
			const cHost = pair(hostSource, '/host/Global.tsx', dev, {
				'./contexts': { Theme },
				'./remote': { Local: client.Remote, A: make('a', 'client'), B: make('b', 'client') },
			}).client;
			const options = { externalSnapshots: { documentId: 'globals-' + removed } };
			const html = (await prerender(sHost.App, { a: true, b: true, title: 'server' }, options))
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
				cHost.App,
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
				expect(survivorButton.dataset.hydrated).toBe('true');
				await Client.act(() => survivorButton.click());
				expect(survivorButton.textContent).toBe(survivor + ':1:server');
				expect(container.querySelector('[data-global="host"]')!.textContent).toBe('host:0:server');
				await Client.act(() =>
					root.render(cHost.App, { a: removed !== 'a', b: removed !== 'b', title: 'live' }),
				);
				pending.resolve({ default: invoke });
				await Client.act(async () => {});
				expect(invoke).not.toHaveBeenCalled();
				expect(container.querySelector(`[data-global="${removed}"]`)).toBeNull();
				expect(container.querySelector(`[data-global="${survivor}"]`)).toBe(survivorButton);
				expect(survivorButton.dataset.hydrated).toBe('true');
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
		const snapshot = transport(server.Remote);
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
		const hostSource = `import {Boundary, Local} from './remote'; export function App(props) @{ <><Local label="host" title="host title" /><Boundary label="a" title={props.title} />@if(props.second) {<Boundary label="b" title="b title" />}</> }`;
		const hostServer = pair(hostSource, '/host/Head.tsrx', dev, {
			'./remote': { Boundary: S, Local: server.Remote },
		}).server;
		const hostClient = pair(hostSource, '/host/Head.tsrx', dev, {
			'./remote': { Boundary: C, Local: client.Remote },
		}).client;
		const result = await prerender(
			hostServer.App,
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
			hostClient.App,
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
			await Client.act(() => root.render(hostClient.App, { title: 'live title', second: false }));
			expect(heads[1]!.getAttribute('content')).toBe('live title');
			expect(heads[2]!.isConnected).toBe(false);
			expect(heads[0]!.isConnected).toBe(true);
		} finally {
			root.unmount();
			container.remove();
		}
		expect(heads.some((node) => node.isConnected)).toBe(false);
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
				return Server.renderExternalSnapshot(server.Remote, request, { authority, signal });
			}
			captured = request;
			return pending.promise;
		};
		const S = Server.externalSnapshotBoundary({ authority, component: server.Remote, snapshot });
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
		pending.resolve(await Server.renderExternalSnapshot(server.Remote, captured!, { authority }));
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
		const C = Client.externalSnapshotBoundary({ authority, component: client.Remote, snapshot });
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
