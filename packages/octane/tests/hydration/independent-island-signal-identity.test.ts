import { expect, it, onTestFinished, vi } from 'vitest';
import { compile } from 'octane/compiler';
import * as Server from 'octane/server';
import { externalSnapshotBoundary, flushSync } from '../../src/index.js';
import { prerender } from '../../src/runtime.server.js';
import { bootstrapIndependentHydration } from '../../src/hydration/independent-island.js';
import { bootstrapStreamedSignalHydration } from '../../src/hydration/streamed-signals.js';
import * as signals from '../../src/signals/index.js';
import { evaluateCompiledFixtureCode, loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, resetStreamRuntimeGlobals } from '../_server-stream.js';
import { drainProducers } from '../_fixtures/signals-async-controls.js';

const sources = {
	direct: '<Inner />',
	suspense: '@try { <Inner /> } @pending { <i>{"waiting"}</i> }',
};

const islandSource = (children: string) => `import { Hydrate } from 'octane';
import { load } from 'octane/hydration';
import { query$ } from 'octane/signals';
import { fetchValue } from './actions';
export function App() @{
  <main>
    <Hydrate independent when={load()}>
      ${children}
    </Hydrate>
  </main>
}
function Inner() @{
  const value$ = query$(() => 'inner', fetchValue);
  <output>{value$}</output>
}`;

it.each(['iframe', 'viewless'] as const)(
	'adopts external publisher state in independently activated %s documents',
	async (realm) => {
		const dev = process.env['OCTANE_TEST_COMPILE_MODE'] !== 'prod';
		const remoteSource = `import {useState,useLayoutEffect} from 'octane';
import {ready} from './observer';
export function Remote() {
 const [count,setCount] = useState(3);
 useLayoutEffect(ready, []);
 return <section><input defaultValue="draft"/><button onClick={() => setCount(count + 1)}>{count}</button></section>;
}`;
		const fixture = { id: '/project/src/ExternalIslandRemote.tsx', compileOptions: { dev } };
		const serverRemote = loadCompiledFixtureSource(remoteSource, {
			...fixture,
			mode: 'server',
			runtimeModules: { './observer': { ready() {} } },
		});
		const authority = { publisherBuildId: 'independent-external', runtimeABI: 1 as const };
		const snapshot = async (request: Server.ExternalSnapshotRequest) => {
			const prepared = await Server.prepareExternalSnapshotRequest(request, { authority });
			try {
				return await Server.renderExternalSnapshot(serverRemote['Remote'], prepared);
			} finally {
				await Server.releasePreparedExternalSnapshotRequest(prepared);
			}
		};
		const serverBoundary = Server.externalSnapshotBoundary({
			authority,
			component: serverRemote['Remote'],
			snapshot,
		});
		const source = `import {Hydrate} from 'octane';
import {load} from 'octane/hydration';
import {Boundary} from './publisher';
export function App() @{ <Hydrate independent when={load()}><Boundary/></Hydrate> }`;
		const file = '/project/src/ExternalIsland.tsrx';
		const server = evaluateCompiledFixtureCode(
			compile(source, file, { mode: 'server', dev }).code,
			file,
			'server',
			{ './publisher': { Boundary: serverBoundary } },
		);
		const identity = { buildId: 'independent-host', documentId: 'independent-' + realm };
		const { html } = await prerender(server['App'], undefined, {
			streamedSignals: identity,
			externalSnapshots: { documentId: identity.documentId },
			independentHydration: {
				buildId: identity.buildId,
				resolve: (moduleId) => ({ moduleId, styles: [] }),
			},
		});
		const cleanups: (() => void)[] = [];
		const buttons: HTMLButtonElement[] = [];
		try {
			for (const explicitOwner of [true, false]) {
				const frame = realm === 'iframe' ? document.createElement('iframe') : undefined;
				if (frame) document.body.append(frame);
				const ownerDocument =
					frame?.contentDocument ?? document.implementation.createHTMLDocument('External island');
				const target =
					(ownerDocument.defaultView as unknown as Record<string, unknown> | null) ?? {};
				const host = ownerDocument.createElement('main');
				ownerDocument.body.append(host);
				cleanups.push(() => {
					host.remove();
					frame?.remove();
				});
				host.innerHTML = html;
				activateStreamedMarkup(host, { target });
				const section = host.querySelector('section')!;
				const input = host.querySelector('input')!;
				const button = host.querySelector('button')!;
				input.value = 'edited before activation';
				const hydration = bootstrapStreamedSignalHydration({
					...identity,
					document: ownerDocument,
					target,
				});
				cleanups.push(() => hydration.dispose());
				const ready = vi.fn();
				const clientRemote = loadCompiledFixtureSource(remoteSource, {
					...fixture,
					mode: 'client',
					runtimeModules: { './observer': { ready } },
				});
				const boundary = externalSnapshotBoundary({
					authority,
					component: clientRemote['Remote'],
					snapshot,
				});
				const widget = evaluateCompiledFixtureCode(
					compile(source, file + '?octane-hydrate=0', { mode: 'client', dev }).code,
					file,
					'client',
					{ './publisher': { Boundary: boundary } },
				);
				const errors: unknown[] = [];
				cleanups.push(
					bootstrapIndependentHydration(host, {
						buildId: identity.buildId,
						...(explicitOwner ? { signalOwner: hydration.signalOwner } : {}),
						loadStyles() {},
						async loadModule() {
							return widget;
						},
						onError: (error) => errors.push(error),
					}),
				);
				await vi.waitFor(() => {
					expect(errors).toEqual([]);
					expect(ready).toHaveBeenCalled();
				});
				expect(errors).toEqual([]);
				expect(host.querySelector('section')).toBe(section);
				expect(host.querySelector('input')).toBe(input);
				expect(host.querySelector('button')).toBe(button);
				expect(input.value).toBe('edited before activation');
				buttons.push(button);
			}
			flushSync(() => buttons[0].click());
			expect(buttons.map((button) => button.textContent)).toEqual(['4', '3']);
			flushSync(() => buttons[1].click());
			expect(buttons.map((button) => button.textContent)).toEqual(['4', '4']);
		} finally {
			for (const cleanup of cleanups.reverse()) cleanup();
			resetStreamRuntimeGlobals();
		}
	},
);

// The island adapter recreates the server Hydrate frame on the client. That
// frame must not add an invocation segment to descendant signal instance keys,
// or instance-keyed server state (here a query$ result) is never adopted and
// the browser producer runs again.
it.each(Object.keys(sources) as (keyof typeof sources)[])(
	'adopts instance-keyed server query results inside an independent island (%s)',
	async (shape) => {
		const source = islandSource(sources[shape]);
		const file = '/project/src/IslandQuery.tsrx';
		const serverFetch = vi.fn(async () => 'server result');
		const browserFetch = vi.fn(async () => 'browser result');
		const runtimeModules = {
			'octane/signals': signals,
		};
		const server = evaluateCompiledFixtureCode(
			compile(source, file, { mode: 'server' }).code,
			file,
			'server',
			{ './actions': { fetchValue: serverFetch }, ...runtimeModules },
		);
		const widget = evaluateCompiledFixtureCode(
			compile(source, file + '?octane-hydrate=0', { mode: 'client' }).code,
			file,
			'client',
			{ './actions': { fetchValue: browserFetch }, ...runtimeModules },
		);
		// Each response owns a fresh Document; retired tuples stay fenced in the old one.
		const frame = document.createElement('iframe');
		document.body.append(frame);
		onTestFinished(() => frame.remove());
		const ownerDocument = frame.contentDocument!;
		const host = ownerDocument.createElement('div');
		ownerDocument.body.append(host);
		let hydration: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		let cleanup: (() => void) | undefined;
		try {
			const { html } = await prerender(server['App'], undefined, {
				streamedSignals: { buildId: 'island-query-build', documentId: 'island-query-document' },
				independentHydration: {
					buildId: 'island-query-build',
					resolve: (moduleId) => ({ moduleId, styles: [] }),
				},
			});
			host.innerHTML = html;
			activateStreamedMarkup(host);
			expect(serverFetch).toHaveBeenCalledTimes(1);
			const output = host.querySelector('output')!;
			expect(output.textContent).toBe('server result');
			hydration = bootstrapStreamedSignalHydration({
				document: ownerDocument,
				buildId: 'island-query-build',
				documentId: 'island-query-document',
			});
			const errors: unknown[] = [];
			let loaded = false;
			cleanup = bootstrapIndependentHydration(host, {
				buildId: 'island-query-build',
				signalOwner: hydration.signalOwner,
				loadStyles() {},
				async loadModule() {
					loaded = true;
					return widget;
				},
				onError: (error) => errors.push(error),
			});
			await vi.waitFor(() => expect(loaded).toBe(true));
			await drainProducers();
			flushSync(() => {});
			expect(browserFetch).not.toHaveBeenCalled();
			expect(host.querySelector('output')).toBe(output);
			expect(output.textContent).toBe('server result');
			expect(errors).toEqual([]);
		} finally {
			cleanup?.();
			hydration?.dispose();
			host.remove();
			resetStreamRuntimeGlobals();
		}
	},
);
