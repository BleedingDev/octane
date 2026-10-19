import { expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { prerender } from 'octane/static';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup } from '../_server-stream.js';

it.each(['replacement', 'non-function', 'throwing getter'] as const)(
	'keeps the admitted external component after options changes to %s',
	async (mutation) => {
		const source = `import {useState,useLayoutEffect} from 'octane'; import {onReady} from './observer'; export function Remote(){const [count,setCount]=useState(3);useLayoutEffect(()=>onReady(),[]);return <button onClick={()=>setCount(count+1)}>{'admitted:'+count}</button>;} export function Other(){return <p>unadmitted replacement</p>;}`;
		const fixture = {
			id: '/remote/CapturedComponent.tsx',
			compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod' },
		};
		const onReady = vi.fn();
		const server = loadCompiledFixtureSource(source, {
			...fixture,
			mode: 'server',
			runtimeModules: { './observer': { onReady() {} } },
		});
		const client = loadCompiledFixtureSource(source, {
			...fixture,
			mode: 'client',
			runtimeModules: { './observer': { onReady } },
		});
		const authority = { publisherBuildId: 'captured-component', runtimeABI: 1 as const };
		const snapshot = async (request: Server.ExternalSnapshotRequest) => {
			const prepared = await Server.prepareExternalSnapshotRequest(request, { authority });
			try {
				return await Server.renderExternalSnapshot(server.Remote, prepared);
			} finally {
				await Server.releasePreparedExternalSnapshotRequest(prepared);
			}
		};
		const serverBoundary = Server.externalSnapshotBoundary({
			authority,
			component: server.Remote,
			snapshot,
		});
		let read = false;
		const options = {
			authority,
			get component() {
				if (mutation === 'throwing getter' && read) throw new Error('component was reread');
				read = true;
				return client.Remote;
			},
			snapshot,
		};
		const clientBoundary = Client.externalSnapshotBoundary(options);
		if (mutation !== 'throwing getter')
			Object.defineProperty(options, 'component', {
				value: mutation === 'replacement' ? client.Other : null,
			});
		const frame = document.createElement('iframe');
		document.body.append(frame);
		const ownerDocument = frame.contentDocument!;
		const container = ownerDocument.createElement('div');
		ownerDocument.body.append(container);
		const renderOptions = { externalSnapshots: { documentId: 'captured-component-' + mutation } };
		const errors: unknown[] = [];
		let root: Client.Root | undefined;
		try {
			container.innerHTML = (await prerender(serverBoundary, {}, renderOptions)).html;
			activateStreamedMarkup(container);
			const button = container.querySelector('button')!;
			expect(button.textContent).toBe('admitted:3');
			root = Client.hydrateRoot(
				container,
				clientBoundary,
				{},
				{
					...renderOptions,
					onUncaughtError: (error) => errors.push(error),
					onRecoverableError: (error) => errors.push(error),
				},
			);
			await Client.act(async () => {});
			await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
			expect(container.querySelector('button')).toBe(button);
			await Client.act(() => button.click());
			expect(button.textContent).toBe('admitted:4');
			expect(container.querySelector('p')).toBeNull();
			expect(errors).toEqual([]);
		} finally {
			root?.unmount();
			frame.remove();
		}
	},
);
