import { expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { prerender } from '../../src/runtime.server.js';
import { installSignalDocumentLifecycle } from '../../src/hydration/document-lifecycle.js';
import { nativeStreamedSignalBootstrap } from '../../src/hydration/native-streamed-authority.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, resetStreamRuntimeGlobals } from '../_server-stream.js';

it('does not load stream ingress while a fresh nonstream publisher waits for its document', async () => {
	expect(nativeStreamedSignalBootstrap).toBeUndefined();
	const execute = vi.fn();
	const component = loadCompiledFixtureSource(
		`import {onExecute} from './callbacks';export function Remote(){onExecute();return <button>fresh publisher</button>;}`,
		{
			id: '/remote/FreshFrozenPublisher.tsx',
			mode: 'client',
			compileOptions: { dev: false },
			runtimeModules: { './callbacks': { onExecute: execute } },
		},
	);
	const documentId = 'fresh-frozen-publisher';
	const owner = Object.freeze({ scopeKey: 'fresh-frozen-host' });
	const lifecycle = installSignalDocumentLifecycle({
		document,
		buildId: 'fresh-host',
		documentId,
		signalOwner: owner,
		readIdentity: () => ({ buildId: 'fresh-host', documentId }),
	});
	const hide = new Event('pagehide');
	Object.defineProperty(hide, 'persisted', { value: true });
	window.dispatchEvent(hide);
	const container = document.createElement('div');
	document.body.append(container);
	const boundary = Client.externalSnapshotBoundary({
		authority: { publisherBuildId: 'fresh-publisher', runtimeABI: 1 },
		component: component['Remote'],
		snapshot: vi.fn(),
	});
	const root = Client.createRoot(container, {
		externalSnapshots: { documentId },
		signalOwner: owner,
	});
	try {
		Client.flushSync(() => root.render(boundary));
		await vi.dynamicImportSettled();
		expect(nativeStreamedSignalBootstrap).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
		root.unmount();
		await Client.act(async () => {});
		expect(execute).not.toHaveBeenCalled();
	} finally {
		root.unmount();
		lifecycle.dispose();
		container.remove();
		resetStreamRuntimeGlobals();
	}
});

it('loads native ingress only for committed external adoption and cancels an unmounted cold boundary', async () => {
	expect(nativeStreamedSignalBootstrap).toBeUndefined();
	const execute = vi.fn();
	const source = `import {useState} from 'octane';import {onExecute} from './callbacks';
 export function Remote(props){onExecute(props.label);const [count,setCount]=useState(0);return <button onClick={()=>setCount(count+1)}>{props.label+':'+count}</button>;}`;
	const common = { id: '/remote/ColdSnapshot.tsx', compileOptions: { dev: false } };
	const server = loadCompiledFixtureSource(source, {
		...common,
		mode: 'server',
		runtimeModules: { './callbacks': { onExecute() {} } },
	});
	const client = loadCompiledFixtureSource(source, {
		...common,
		mode: 'client',
		runtimeModules: { './callbacks': { onExecute: execute } },
	});
	const authority = { publisherBuildId: 'cold-publisher', runtimeABI: 1 as const };
	const snapshot = async (request: Server.ExternalSnapshotRequest) => {
		const prepared = await Server.prepareExternalSnapshotRequest(
			Server.serializeExternalSnapshotRequest(request),
			{ authority },
		);
		try {
			return await Server.renderExternalSnapshot(server['Remote'], prepared);
		} finally {
			await Server.releasePreparedExternalSnapshotRequest(prepared);
		}
	};
	const S = Server.externalSnapshotBoundary({ authority, component: server['Remote'], snapshot });
	const C = Client.externalSnapshotBoundary({ authority, component: client['Remote'], snapshot });
	const containers: HTMLElement[] = [];
	const roots: Client.Root[] = [];
	const errors: unknown[] = [];
	try {
		for (const label of ['cancelled', 'retained']) {
			const documentId = 'cold-' + label;
			const container = document.createElement('div');
			containers.push(container);
			container.innerHTML = (
				await prerender(S, { label }, { externalSnapshots: { documentId } })
			).html;
			activateStreamedMarkup(container);
			document.body.append(container);
		}
		expect(nativeStreamedSignalBootstrap).toBeUndefined();
		const original = containers[1]!.querySelector('button');
		for (const [index, label] of ['cancelled', 'retained'].entries()) {
			roots.push(
				Client.hydrateRoot(
					containers[index]!,
					C,
					{ label },
					{
						externalSnapshots: { documentId: 'cold-' + label },
						onUncaughtError: (error) => errors.push(error),
						onRecoverableError: (error) => errors.push(error),
					},
				),
			);
		}
		Client.flushSync(() => {});
		expect(execute).not.toHaveBeenCalled();
		roots[0]!.unmount();
		await Client.act(async () => {
			await vi.waitFor(() => expect(nativeStreamedSignalBootstrap).toBeTypeOf('function'));
		});
		expect(execute.mock.calls.map(([label]) => label)).toEqual(['retained']);
		expect(containers[1]!.querySelector('button')).toBe(original);
		await Client.act(() => original!.click());
		expect(original!.textContent).toBe('retained:1');
		expect(execute.mock.calls.every(([label]) => label === 'retained')).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		for (const root of roots) root.unmount();
		for (const container of containers) container.remove();
		resetStreamRuntimeGlobals();
		document.head.innerHTML = '';
	}
});
