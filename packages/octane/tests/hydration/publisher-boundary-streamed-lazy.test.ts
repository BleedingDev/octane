import { expect, it } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { bootstrapStreamedSignalHydration } from 'octane/hydration/streamed-signals';
import * as ClientSignals from 'octane/signals/client';
import * as ServerSignals from 'octane/signals/server';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import {
	activateStreamedMarkup,
	createPipeableCollector,
	deferred,
	resetStreamRuntimeGlobals,
} from '../_server-stream.js';

const serverTheme = Server.createContext('missing host context');
const clientTheme = Client.createContext('missing host context');
const remoteSource = `import {useContext,useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
export function Remote(props) {
 const count$ = useSignal$(props.initial);
 const id = useId();
 const theme = useContext(Theme);
 return <section data-publisher="remote" data-context-key={theme} data-empty={theme==='server theme'?null:''} data-remove={theme==='server theme'?'':null} className={theme} style={theme==='server theme'?{color:'red',backgroundColor:'black'}:{color:'blue'}}><input id={id} defaultValue="server draft"/><button onClick={()=>count$.set(value=>value+1)}>{props.label+':'+count$.get()+':'+theme}</button><iframe title="publisher resource" src={props.resourceUrl}/></section>;
}`;
const suspendedRemoteSource = `import {Suspense,useContext,useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
import {Wait} from './wait';
function Values(props) {
 const id = useId();
 const theme = props.theme;
 return <section data-publisher="remote" data-context-key={theme} data-empty={theme==='server theme'?null:''} data-remove={theme==='server theme'?'':null} className={theme} style={theme==='server theme'?{color:'red',backgroundColor:'black'}:{color:'blue'}}><input id={id} defaultValue="server draft"/><button onClick={()=>props.count$.set(value=>value+1)}>{props.label+':'+props.count$.get()+':'+theme}</button></section>;
}
export function Remote(props) {
 const count$ = useSignal$(props.initial);
 const theme = useContext(Theme);
 return <Suspense fallback={<aside data-fallback="inner">waiting inside publisher</aside>}><Values theme={theme} label={props.label} count$={count$}/><Wait/></Suspense>;
}`;
const hiddenSuspendedRemoteSource = `import {Activity} from 'octane';
${suspendedRemoteSource}
export function ActivityRemote(props) {
 return <Activity mode={props.activityMode}><Remote {...props}/></Activity>;
}`;
const nativeSuspendedRemoteSource = `import {Suspense,useContext,useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
import {Wait} from './wait';
function Values(props) @{
 const id = useId();
 const theme = props.theme;
 <section data-publisher="remote" data-context-key={theme} data-empty={theme==='server theme'?null:''} data-remove={theme==='server theme'?'':null} className={theme} style={theme==='server theme'?{color:'red',backgroundColor:'black'}:{color:'blue'}}><input id={id} defaultValue="server draft"/><button onClick={()=>props.count$.set(value=>value+1)}>{props.label+':'+props.count$.get()+':'+theme}</button></section>
}
export function Remote(props) @{
 const count$ = useSignal$(props.initial);
 const theme = useContext(Theme);
 <Suspense fallback={<aside data-fallback="inner">waiting inside publisher</aside>}><Values theme={theme} label={props.label} count$={count$}/><Wait/></Suspense>
}`;
const hostSource = `import {Suspense} from 'octane';
import {Theme} from './context';
import {Remote} from './remote';
export function App(props) {
 return <Theme value={props.theme}><main><header data-host="before">host before</header><Suspense fallback={<aside data-fallback="remote">waiting</aside>}><Remote label={props.label} initial={props.initial} resourceUrl={props.resourceUrl} activityMode={props.activityMode}/></Suspense><footer data-host="after">host after</footer></main></Theme>;
}`;

it.each([null, false] as const)(
	'removes an empty server class for live publisher context %s',
	async (theme) => {
		const source = `import {useContext,useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
export function Remote() {
 const count$ = useSignal$(7);
 const id = useId();
 const theme = useContext(Theme);
 return <section data-publisher="nullable-class" className={theme}><input id={id} defaultValue="server draft"/><button onClick={()=>count$.set(value=>value+1)}>{String(count$.get())}</button></section>;
}`;
		const ServerTheme = Server.createContext<string | null | false>('');
		const ClientTheme = Client.createContext<string | null | false>('');
		const compile = (mode: 'server' | 'client') =>
			loadCompiledFixtureSource(source, {
				id: '/publisher/NullableClass.tsx',
				mode,
				compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod', hmr: false },
				runtimeModules: {
					'./context': { Theme: mode === 'server' ? ServerTheme : ClientTheme },
					'octane/signals/client': ClientSignals,
					'octane/signals/server': ServerSignals,
				},
			});
		const server = Server.publisherBoundary(compile('server').Remote, {
			publisherKey: 'remote/NullableClass',
		});
		const client = Client.publisherBoundary(compile('client').Remote, {
			publisherKey: 'remote/NullableClass',
		});
		const serverApp = () =>
			Server.createElement(ServerTheme, { value: '', children: Server.createElement(server, {}) });
		const clientApp = (props: { theme: string | null | false }) =>
			Client.createElement(ClientTheme, {
				value: props.theme,
				children: Client.createElement(client, {}),
			});
		const container = document.createElement('div');
		document.body.append(container);
		const errors: unknown[] = [];
		let root: ReturnType<typeof Client.hydrateRoot> | undefined;
		try {
			container.innerHTML = Server.renderToString(serverApp).html;
			activateStreamedMarkup(container);
			const publisher = container.querySelector('section')!;
			const input = publisher.querySelector('input')!;
			const button = publisher.querySelector('button')!;
			const id = input.id;
			expect(publisher.getAttribute('class')).toBe('');
			input.value = 'typed before hydration';
			await Client.act(() => {
				root = Client.hydrateRoot(
					container,
					clientApp,
					{ theme },
					{
						onRecoverableError: (error) => errors.push(error),
						onUncaughtError: (error) => errors.push(error),
					},
				);
			});
			expect(container.querySelector('section')).toBe(publisher);
			expect(publisher.hasAttribute('class')).toBe(false);
			await Client.act(() => button.click());
			expect(button.textContent).toBe('8');
			await Client.act(() => root!.render(clientApp, { theme: 'live class' }));
			expect(publisher.getAttribute('class')).toBe('live class');
			await Client.act(() => root!.render(clientApp, { theme }));
			expect(publisher.hasAttribute('class')).toBe(false);
			expect(container.querySelector('section')).toBe(publisher);
			expect(publisher.querySelector('input')).toBe(input);
			expect(input.id).toBe(id);
			expect(input.value).toBe('typed before hydration');
			expect(button.textContent).toBe('8');
			expect(errors).toEqual([]);
		} finally {
			root?.unmount();
			container.remove();
			resetStreamRuntimeGlobals();
		}
	},
);

it.each(
	(['direct', 'settled lazy', 'pending lazy'] as const)
		.flatMap((mode) =>
			(['same', 'different'] as const).map((context) => ({
				mode,
				context,
				scenario: 'ordinary' as
					| 'ordinary'
					| 'suspending descendant'
					| 'hidden suspending descendant'
					| 'native template suspending descendant'
					| 'structural mismatch',
			})),
		)
		.concat([
			{ mode: 'direct', context: 'different', scenario: 'suspending descendant' },
			{ mode: 'direct', context: 'different', scenario: 'hidden suspending descendant' },
			{ mode: 'direct', context: 'different', scenario: 'native template suspending descendant' },
			{ mode: 'direct', context: 'different', scenario: 'structural mismatch' },
		]),
)(
	'adopts a streamed publisher with a $mode client module and $context initial context ($scenario)',
	async ({ mode, context, scenario }) => {
		const gate = deferred<void>();
		const hidden = scenario === 'hidden suspending descendant';
		const nativeTemplate = scenario === 'native template suspending descendant';
		const suspends = hidden || nativeTemplate || scenario === 'suspending descendant';
		const compile = (source: string, id: string, environment: 'client' | 'server', modules = {}) =>
			loadCompiledFixtureSource(source, {
				id,
				mode: environment,
				compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod', hmr: false },
				runtimeModules: {
					'./context': { Theme: environment === 'server' ? serverTheme : clientTheme },
					'./wait': {
						Wait: environment === 'server' ? () => null : () => Client.use(gate.promise),
					},
					'octane/signals/client': ClientSignals,
					'octane/signals/server': ServerSignals,
					...modules,
				},
			});
		const source = nativeTemplate
			? nativeSuspendedRemoteSource
			: hidden
				? hiddenSuspendedRemoteSource
				: suspends
					? suspendedRemoteSource
					: remoteSource;
		const id = nativeTemplate ? '/publisher/StreamedRemote.tsrx' : '/publisher/StreamedRemote.tsx';
		const serverRemote = compile(source, id, 'server');
		const clientRemote = compile(source, id, 'client');
		const serverPublisher = Server.publisherBoundary(
			hidden ? serverRemote.ActivityRemote : serverRemote.Remote,
			{ publisherKey: 'remote/StreamedWidget' },
		);
		const clientPublisher = Client.publisherBoundary(
			hidden ? clientRemote.ActivityRemote : clientRemote.Remote,
			{ publisherKey: 'remote/StreamedWidget' },
		);
		// Match a federation adapter's ordinary loaded-component wrapper on both sides.
		const ServerLoaded = (props: { label: string; initial: number; resourceUrl: string }) =>
			Server.createElement(serverPublisher, props);
		const ClientLoaded = (props: { label: string; initial: number; resourceUrl: string }) =>
			Client.createElement(clientPublisher, props);
		const serverModule = deferred<{ default: typeof ServerLoaded }>();
		const clientModule = deferred<{ default: typeof ClientLoaded }>();
		const serverLazy = Server.lazy(() => serverModule.promise);
		const clientComponent =
			mode === 'direct' ? ClientLoaded : Client.lazy(() => clientModule.promise);
		if (mode === 'settled lazy') {
			clientModule.resolve({ default: ClientLoaded });
			await clientModule.promise;
		}
		const serverHost = compile(hostSource, '/host/StreamedPublisher.tsx', 'server', {
			'./remote': { Remote: serverLazy },
		});
		const clientHost = compile(hostSource, '/host/StreamedPublisher.tsx', 'client', {
			'./remote': { Remote: clientComponent },
		});
		const props = {
			theme: 'server theme',
			label: 'remote',
			initial: 7,
			resourceUrl: 'about:blank',
			activityMode: 'visible',
		};
		const clientProps = {
			...props,
			theme: context === 'same' ? props.theme : 'client theme',
			activityMode: hidden ? 'hidden' : 'visible',
		};
		const identity = { buildId: 'streamed-publisher-build', documentId: 'streamed-publisher-doc' };
		const collector = createPipeableCollector();
		const shell = deferred<void>();
		const serverErrors: unknown[] = [];
		const recoverable: unknown[] = [];
		const uncaught: unknown[] = [];
		const stream = Server.renderToPipeableStream(serverHost.App, props, {
			streamedSignals: identity,
			earlySignalBootstrap: 'external',
			timeoutMs: 1000,
			onShellReady: () => shell.resolve(undefined),
			onShellError: (error) => shell.reject(error),
			onError: (error) => serverErrors.push(error),
		});
		stream.pipe(collector.destination);
		const container = document.createElement('div');
		document.body.append(container);
		let root: ReturnType<typeof Client.hydrateRoot> | undefined;
		let hydration: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			await shell.promise;
			expect(collector.chunks.join('')).toContain('waiting');
			serverModule.resolve({ default: ServerLoaded });
			container.innerHTML = Server.earlySignalBootstrapScript() + (await collector.ended);
			activateStreamedMarkup(container);
			expect(serverErrors).toEqual([]);
			const publisher = container.querySelector<HTMLElement>('section[data-publisher="remote"]');
			expect(publisher).not.toBeNull();
			const input = publisher!.querySelector('input')!;
			const button = publisher!.querySelector('button')!;
			const inputId = input.id;
			const frame = publisher!.querySelector('iframe');
			const frameDocument = frame?.contentDocument;
			if (frame !== null) expect(frameDocument).not.toBeNull();
			const serverStyle = publisher!.getAttribute('style');
			const hostNodes = [...container.querySelectorAll('[data-host]')];
			expect(button.textContent).toBe('remote:7:server theme');
			expect(publisher!.getAttribute('data-context-key')).toBe('server theme');
			expect(container.querySelector('[data-fallback]')).toBeNull();
			input.value = 'typed before hydration';
			if (scenario === 'structural mismatch')
				publisher!.replaceWith(document.createElement('article'));
			hydration = bootstrapStreamedSignalHydration(identity);
			await Client.act(() => {
				root = Client.hydrateRoot(container, clientHost.App, clientProps, {
					signalOwner: hydration!.signalOwner,
					onRecoverableError: (error) => recoverable.push(error),
					onUncaughtError: (error) => uncaught.push(error),
				});
			});
			if (scenario === 'structural mismatch') {
				const replacement = container.querySelector('[data-publisher="remote"]');
				expect(replacement).not.toBeNull();
				expect(replacement).not.toBe(publisher);
				expect(input.isConnected).toBe(false);
				expect(replacement!.querySelector('input')).not.toBe(input);
				expect(replacement!.querySelector('button')!.textContent).toBe('remote:7:client theme');
				expect([...container.querySelectorAll('[data-host]')]).toEqual(hostNodes);
				expect(uncaught).toEqual([]);
				return;
			}
			const assertRetained = () => {
				if (container.querySelector('[data-publisher="remote"]') !== publisher) {
					console.error('Streamed publisher adoption failed', {
						mode,
						context,
						html: container.innerHTML,
						recoverable,
						uncaught,
					});
				}
				expect(container.querySelector('[data-publisher="remote"]')).toBe(publisher);
				expect(publisher!.querySelector('input')).toBe(input);
				expect(publisher!.querySelector('button')).toBe(button);
				expect(input.id).toBe(inputId);
				expect(input.value).toBe('typed before hydration');
				if (frame !== null) {
					expect(publisher!.querySelector('iframe')).toBe(frame);
					// Rewriting an unchanged src reloads the iframe's document.
					expect(frame.contentDocument).toBe(frameDocument);
				}
				expect([...container.querySelectorAll('[data-host]')]).toEqual(hostNodes);
				expect(container.querySelector('[data-fallback]')).toBeNull();
				expect(recoverable).toEqual([]);
				expect(uncaught).toEqual([]);
			};
			assertRetained();
			if (suspends) {
				expect(publisher!.getAttribute('data-context-key')).toBe('server theme');
				expect(publisher!.hasAttribute('data-empty')).toBe(false);
				expect(publisher!.getAttribute('data-remove')).toBe('');
				expect(publisher!.getAttribute('class')).toBe('server theme');
				if (hidden) {
					expect(publisher!.style.display).toBe('none');
					expect(publisher!.style.color).toBe('red');
					expect(publisher!.style.backgroundColor).toBe('black');
				} else expect(publisher!.getAttribute('style')).toBe(serverStyle);
				expect(button.textContent).toBe('remote:7:server theme');
				await Client.act(() => gate.resolve());
				assertRetained();
			}
			if (mode === 'pending lazy') {
				expect(publisher!.getAttribute('data-context-key')).toBe('server theme');
				await Client.act(() => clientModule.resolve({ default: ClientLoaded }));
				assertRetained();
			}
			expect(publisher!.getAttribute('data-context-key')).toBe(clientProps.theme);
			expect(publisher!.getAttribute('data-empty')).toBe(context === 'same' ? null : '');
			expect(publisher!.getAttribute('data-remove')).toBe(context === 'same' ? '' : null);
			expect(publisher!.getAttribute('class')).toBe(clientProps.theme);
			expect(publisher!.style.color).toBe(context === 'same' ? 'red' : 'blue');
			expect(publisher!.style.backgroundColor).toBe(context === 'same' ? 'black' : '');
			if (hidden) expect(publisher!.style.display).toBe('none');
			expect(button.textContent).toBe(`remote:7:${clientProps.theme}`);
			await Client.act(() => button.click());
			expect(button.textContent).toBe(`remote:8:${clientProps.theme}`);
			await Client.act(() =>
				root!.render(clientHost.App, {
					...clientProps,
					theme: 'live theme',
					activityMode: 'visible',
				}),
			);
			expect(button.textContent).toBe('remote:8:live theme');
			expect(publisher!.getAttribute('data-context-key')).toBe('live theme');
			if (hidden) {
				expect(publisher!.style.display).toBe('');
				expect(publisher!.style.color).toBe('blue');
			}
			assertRetained();
		} finally {
			root?.unmount();
			hydration?.dispose();
			stream.abort();
			container.remove();
			resetStreamRuntimeGlobals();
			Reflect.deleteProperty(globalThis, '__octaneStreamedSignalSelections');
			Reflect.deleteProperty(globalThis, '__octaneStreamedRenderer');
		}
	},
);
