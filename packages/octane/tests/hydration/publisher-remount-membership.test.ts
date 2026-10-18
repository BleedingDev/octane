import { expect, it } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import * as Signals from 'octane/signals';
import * as ClientSignals from 'octane/signals/client';
import * as ServerSignals from 'octane/signals/server';
import { compile } from 'octane/compiler';
import type {
	HotSignalExecutionFrame,
	HotSignalRuntime,
} from '../../src/signals/hot-declarations.js';
import { bootstrapStreamedSignalHydration } from 'octane/hydration/streamed-signals';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup } from '../_server-stream.js';

it.each([
	{ removeChild: false, multipleDescriptors: false, hidden: false },
	{ removeChild: true, multipleDescriptors: false, hidden: false },
	{ removeChild: true, multipleDescriptors: true, hidden: false },
	{ removeChild: true, multipleDescriptors: false, hidden: true },
	{ removeChild: false, multipleDescriptors: false, hidden: false, hot: true },
	{ removeChild: true, multipleDescriptors: false, hidden: false, hot: true },
	{ removeChild: true, multipleDescriptors: false, hidden: false, hot: true, abort: true },
	{ removeChild: false, multipleDescriptors: false, hidden: false, hot: true, sameModule: true },
	{ removeChild: true, multipleDescriptors: false, hidden: false, hot: true, sameModule: true },
	{
		removeChild: false,
		multipleDescriptors: false,
		hidden: false,
		hot: true,
		sameModule: true,
		suspense: true,
	},
	{
		removeChild: true,
		multipleDescriptors: false,
		hidden: false,
		hot: true,
		sameModule: true,
		suspense: true,
	},
	{
		removeChild: true,
		multipleDescriptors: false,
		hidden: false,
		hot: true,
		sameModule: true,
		abort: true,
	},
])(
	'accepts a further replacement after a remount: removed=$removeChild, multiple=$multipleDescriptors, hidden=$hidden, hot=$hot, abort=$abort, sameModule=$sameModule, suspense=$suspense',
	async ({
		removeChild,
		multipleDescriptors,
		hidden,
		hot = false,
		abort = false,
		sameModule = false,
		suspense = false,
	}) => {
		const id = '/remote/RemountedMembership.tsrx';
		const childId = '/remote/MembershipChild.tsrx';
		const childSource = `export function Child() @{ <span>optional child</span> }`;
		const source = (version: number) => `import {useSignal$} from 'octane/signals/client';
${suspense ? "import {Suspense} from 'octane';" : ''}
${sameModule ? "import {useState} from 'octane'; export function Child() @{ useState(0); <span>optional child</span> }" : "import {Child} from './child';"}
export function Remote(props) @{
 const count$=useSignal$(0);
 ${version > 1 && !sameModule ? 'const extra$=useSignal$(99);' : ''}
 ${version === 1 || sameModule ? 'return ' : ''}<section ${version > 1 && !sameModule ? 'data-extra={extra$.get()}' : ''}>${version > 1 && !sameModule ? '@if(props.extra){<i>expanded</i>}' : ''}${suspense ? '<Suspense fallback={<i>waiting</i>}>' : ''}${version === 1 || !removeChild ? '<Child/>' : ''}${suspense ? '</Suspense>' : ''}<button onClick={()=>count$.set(count$.get()+1)}>{'v${version}:'+count$.get() as string}</button></section>${version === 1 || sameModule ? ';' : ''}
}`;
		const globals = globalThis as Record<symbol, any>;
		const executionKey = Symbol.for('octane.hot-signals.execution');
		const bridgeKey = Symbol.for('octane.hot-signals.bridge');
		const previous = globals[executionKey];
		const disposeCallbacks = new Map<string, (data: Record<string, unknown>) => void>();
		let previousRuntime: HotSignalRuntime | undefined;
		const load = (version: number, hot = false, abort = false) => {
			const definitions = [
				...(sameModule ? [] : [{ executableId: 'child', id: childId, source: childSource }]),
				{ executableId: 'publisher', id, source: source(version) },
			].map((definition) => ({
				...definition,
				manifest: compile(definition.source, definition.id, { hmr: 'webpack', dev: true })
					.hotSignalModule!,
			}));
			const runtime: HotSignalRuntime = hot
				? previousRuntime!
				: {
						modules: new Map(
							definitions.map(({ executableId, manifest }) => [executableId, [manifest]]),
						),
						features: new Set(definitions.map(({ executableId }) => executableId)),
						executed: new Set(),
						buildId: 'membership-build:' + version,
						generationChanged: false,
					};
			previousRuntime = runtime;
			runtime.buildId = 'membership-build:' + version;
			for (const definition of definitions)
				runtime.modules.set(definition.executableId, [definition.manifest]);
			let namespace: Record<string, any> = {};
			for (const definition of definitions) {
				const execution: HotSignalExecutionFrame = {
					runtime,
					executableId: definition.executableId,
					buildId: runtime.buildId,
					manifests: [definition.manifest],
					hot,
					requiresAdmission: true,
				};
				globals[executionKey] = execution;
				try {
					execution.transaction = globals[bridgeKey]?.beforeFactory(execution);
					const data: Record<string, unknown> = {};
					if (hot) disposeCallbacks.get(definition.executableId)?.(data);
					namespace = loadCompiledFixtureSource(definition.source, {
						id: definition.id,
						mode: 'client',
						compileOptions: { hmr: 'webpack', dev: true },
						runtimeModules: {
							'octane/signals': Signals,
							'octane/signals/client': ClientSignals,
							'./child': namespace,
						},
						importMeta: {
							webpackHot: {
								data,
								dispose(callback: (data: Record<string, unknown>) => void) {
									disposeCallbacks.set(definition.executableId, callback);
								},
								accept() {},
								invalidate() {
									throw new Error('Unexpected document reload');
								},
							},
						},
					});
					if (abort && definition.executableId === 'publisher')
						throw new Error('Publisher factory rejected');
					globals[bridgeKey].afterFactory(execution);
					runtime.executed.add(definition.executableId);
				} catch (error) {
					globals[bridgeKey]?.abortFactory(execution);
					throw error;
				} finally {
					if (previous === undefined) delete globals[executionKey];
					else globals[executionKey] = previous;
				}
			}
			return namespace;
		};
		const serverChild = loadCompiledFixtureSource(childSource, { id: childId, mode: 'server' });
		const server = loadCompiledFixtureSource(source(1), {
			id,
			mode: 'server',
			runtimeModules: {
				'octane/signals/client': ServerSignals,
				'octane/signals/server': ServerSignals,
				'./child': serverChild,
			},
		});
		const initial = load(1);
		const serverBoundary = Server.publisherBoundary(server.Remote, { publisherKey: id });
		const boundary = Client.publisherBoundary(initial.Remote, { publisherKey: id });
		const otherServerBoundary = multipleDescriptors
			? Server.publisherBoundary(server.Remote, { publisherKey: id })
			: undefined;
		const otherBoundary = multipleDescriptors
			? Client.publisherBoundary(initial.Remote, { publisherKey: id })
			: undefined;
		const serverApp = hidden
			? () =>
					Server.createElement(Server.Activity, {
						mode: 'visible',
						children: Server.createElement(serverBoundary, {}),
					})
			: otherServerBoundary
				? () => [
						Server.createElement(serverBoundary, {}),
						Server.createElement(otherServerBoundary, {}),
					]
				: serverBoundary;
		const clientApp = hidden
			? (props: { mode: 'visible' | 'hidden' }) =>
					Client.createElement(Client.Activity, {
						mode: props.mode,
						children: Client.createElement(boundary, {}),
					})
			: otherBoundary
				? () => [Client.createElement(boundary, {}), Client.createElement(otherBoundary, {})]
				: boundary;
		const frame = document.createElement('iframe');
		document.body.append(frame);
		const ownerDocument = frame.contentDocument!;
		const container = ownerDocument.createElement('div');
		ownerDocument.body.append(container);
		const stream = { buildId: 'membership-host', documentId: 'membership-' + removeChild };
		let root: Client.Root | undefined;
		let bridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		const errors: unknown[] = [];
		try {
			container.innerHTML = Server.renderToString(
				serverApp,
				{},
				{ streamedSignals: stream, earlySignalBootstrap: 'external' },
			).html;
			ownerDocument.head.innerHTML = Server.earlySignalBootstrapScript();
			activateStreamedMarkup(ownerDocument.head);
			activateStreamedMarkup(container);
			bridge = bootstrapStreamedSignalHydration({ ...stream, document: ownerDocument });
			root = Client.hydrateRoot(
				container,
				clientApp,
				{ mode: 'visible' },
				{
					signalOwner: bridge.signalOwner,
					onUncaughtError: (error) => errors.push(error),
					onRecoverableError: (error) => errors.push(error),
				},
			);
			await Client.act(async () => {});
			expect(container.querySelector('button')!.textContent).toBe('v1:0');
			await Client.act(() => container.querySelector('button')!.click());
			expect(container.querySelector('button')!.textContent).toBe('v1:1');
			const rejectedReplacement = Client.preparePublisherBoundaryReplacement(boundary);
			expect(() =>
				rejectedReplacement.execute(() => {
					throw new Error('Publisher factory unavailable');
				}),
			).toThrow('Publisher factory unavailable');
			expect(rejectedReplacement.commitStarted).toBe(false);
			expect(container.querySelector('button')!.textContent).toBe('v1:1');
			if (hidden) await Client.act(() => root!.render(clientApp, { mode: 'hidden' }));
			if (hot) {
				await Client.act(() => {
					if (abort) expect(() => load(2, true, true)).toThrow('Publisher factory rejected');
					else load(2, true);
				});
			} else {
				const firstReplacement = Client.preparePublisherBoundaryReplacement(boundary);
				await Client.act(() => firstReplacement.execute(() => load(2)));
				const retainedButton = container.querySelector('button');
				let replayed = false;
				expect(() =>
					firstReplacement.execute(() => {
						replayed = true;
					}),
				).toThrow();
				await Client.act(async () => {});
				expect(replayed).toBe(false);
				expect(container.querySelector('button')).toBe(retainedButton);
			}
			const currentVersion = abort ? 1 : 2;
			const currentCount = sameModule && !abort ? 1 : 0;
			expect(container.querySelector('button')!.textContent).toBe(
				'v' + currentVersion + ':' + currentCount,
			);
			expect(container.querySelector('span')?.textContent ?? null).toBe(
				removeChild && !abort ? null : 'optional child',
			);
			await Client.act(() => container.querySelector('button')!.click());
			expect(container.querySelector('button')!.textContent).toBe(
				'v' + currentVersion + ':' + (currentCount + 1),
			);
			const secondReplacement = Client.preparePublisherBoundaryReplacement(boundary);
			await Client.act(() => secondReplacement.execute(() => load(3)));
			if (hidden) await Client.act(() => root!.render(clientApp, { mode: 'visible' }));
			const replacementCount = abort && !sameModule ? 0 : currentCount + 1;
			expect(container.querySelector('button')!.textContent).toBe('v3:' + replacementCount);
			if (multipleDescriptors)
				expect(
					[...container.querySelectorAll('button')].map((button) => button.textContent),
				).toEqual(['v3:1', 'v3:0']);
			await Client.act(() => container.querySelector('button')!.click());
			expect(container.querySelector('button')!.textContent).toBe('v3:' + (replacementCount + 1));
			expect(errors).toEqual([]);
		} finally {
			root?.unmount();
			bridge?.dispose();
			frame.remove();
		}
	},
);
