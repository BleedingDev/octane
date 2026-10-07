import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { load } from 'octane/hydration';
import { bootstrapStreamedSignalHydration } from 'octane/hydration/streamed-signals';
import * as ClientSignals from 'octane/signals/client';
import * as ServerSignals from 'octane/signals/server';
import { formatClientError } from '../../src/error-codes.client.generated.js';
import { PUBLISHER_BOUNDARY_ATTR } from '../../src/publisher-boundary-protocol.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, resetStreamRuntimeGlobals } from '../_server-stream.js';

const publisherKey = 'document-bound-publisher';
const streamedSignals = { buildId: 'publisher-document-build', documentId: 'publisher-document' };
const source = `import {useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
export function Remote(props) {
 props.onExecute();
 const count$ = useSignal$(props.initial);
 const id = useId();
 return <section data-publisher-authority="native"><input id={id} defaultValue="draft"/><button onClick={() => count$.set(value => value + 1)}>{count$.get()}</button></section>;
}`;

function pair() {
	const common = {
		id: '/publisher/DocumentAuthority.tsx',
		compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod' },
		runtimeModules: {
			'octane/signals/client': ClientSignals,
			'octane/signals/server': ServerSignals,
		},
	};
	return {
		server: loadCompiledFixtureSource(source, { ...common, mode: 'server' }),
		client: loadCompiledFixtureSource(source, { ...common, mode: 'client' }),
	};
}

afterEach(() => {
	resetStreamRuntimeGlobals();
	delete (globalThis as any).__octaneStreamedSignalSelections;
	delete (globalThis as any).__octaneStreamedRenderer;
	document.head.innerHTML = '';
});

describe('native publisher document authority', () => {
	it('adopts genuine native DOM only in the bootstrapped document', () => {
		const modules = pair();
		const ServerBoundary = Server.publisherBoundary(modules.server.Remote, { publisherKey });
		const ClientBoundary = Client.publisherBoundary(modules.client.Remote, { publisherKey });
		const result = Server.renderToString(
			ServerBoundary,
			{ initial: 7, onExecute() {} },
			{ streamedSignals, earlySignalBootstrap: 'external' },
		);
		const documentA = document;
		const documentB = documentA.implementation.createHTMLDocument('Copied native publisher');
		const containerA = documentA.createElement('div');
		const containerB = documentB.createElement('div');
		documentA.body.append(containerA);
		documentB.body.append(containerB);
		containerA.innerHTML = result.html;
		containerB.innerHTML = result.html;
		const descriptorScript = containerA.querySelector(`script[${PUBLISHER_BOUNDARY_ATTR}]`)!;
		const descriptor = JSON.parse(descriptorScript.textContent!);
		expect(descriptor).toMatchObject({
			publisherKey,
			documentId: streamedSignals.documentId,
			streamBuildId: streamedSignals.buildId,
		});
		expect(containerB.querySelector(`script[${PUBLISHER_BOUNDARY_ATTR}]`)!.textContent).toBe(
			descriptorScript.textContent,
		);
		const section = containerA.querySelector('section')!;
		const input = containerA.querySelector('input')!;
		const button = containerA.querySelector('button')!;
		input.value = 'edited before hydration';
		const acceptedExecution = vi.fn();
		const copiedExecution = vi.fn();
		const acceptedErrors: unknown[] = [];
		const copiedErrors: unknown[] = [];
		let rootA: Client.Root | undefined;
		let rootB: Client.Root | undefined;
		let bridge: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			documentA.head.innerHTML = Server.earlySignalBootstrapScript();
			activateStreamedMarkup(documentA.head);
			activateStreamedMarkup(containerA);
			bridge = bootstrapStreamedSignalHydration(streamedSignals);
			const authorityOptions = {
				signalOwner: bridge.signalOwner,
				externalSnapshots: { documentId: streamedSignals.documentId },
			};
			rootA = Client.hydrateRoot(
				containerA,
				ClientBoundary,
				{ initial: 7, onExecute: acceptedExecution },
				{
					...authorityOptions,
					onUncaughtError: (error) => acceptedErrors.push(error),
					onRecoverableError: (error) => acceptedErrors.push(error),
				},
			);
			Client.flushSync(() => {});
			expect(acceptedExecution).toHaveBeenCalled();
			expect(acceptedErrors).toEqual([]);
			expect(containerA.querySelector('section')).toBe(section);
			expect(containerA.querySelector('input')).toBe(input);
			expect(containerA.querySelector('button')).toBe(button);
			expect(input.value).toBe('edited before hydration');
			Client.flushSync(() => button.click());
			expect(button.textContent).toBe('8');

			// The copied response and the same caller owner/IDs cannot grant A's
			// successfully bootstrapped authority to another actual Document.
			rootB = Client.hydrateRoot(
				containerB,
				ClientBoundary,
				{ initial: 7, onExecute: copiedExecution },
				{ ...authorityOptions, onUncaughtError: (error) => copiedErrors.push(error) },
			);
			Client.flushSync(() => {});
			expect(copiedExecution).not.toHaveBeenCalled();
			expect(copiedErrors).toHaveLength(1);
			expect(copiedErrors[0]).toBeInstanceOf(TypeError);
			expect((copiedErrors[0] as Error).message).toBe(formatClientError(339));
			expect(containerA.querySelector('section')).toBe(section);
			expect(containerA.querySelector('button')).toBe(button);
			Client.flushSync(() => button.click());
			expect(button.textContent).toBe('9');
			expect(acceptedErrors).toEqual([]);
		} finally {
			rootB?.unmount();
			rootA?.unmount();
			bridge?.dispose();
			containerB.remove();
			containerA.remove();
		}
	});

	it.each(['raw field', 'forged descriptor'])(
		'rejects a public Hydrate %s before executing its child',
		(kind) => {
			const execute = vi.fn(() => Client.createElement('span', { children: 'unadmitted' }));
			const forged =
				kind === 'raw field' ? publisherKey : Object.freeze({ publisherKey, component: execute });
			const container = document.createElement('div');
			document.body.append(container);
			const errors: unknown[] = [];
			const root = Client.hydrateRoot(
				container,
				Client.Hydrate,
				{ when: load(), children: Client.createElement(execute, {}), __publisher: forged },
				{ onUncaughtError: (error) => errors.push(error) },
			);
			try {
				Client.flushSync(() => {});
				expect(execute).not.toHaveBeenCalled();
				expect(errors).toHaveLength(1);
				expect(errors[0]).toBeInstanceOf(TypeError);
				expect((errors[0] as Error).message).toBe(formatClientError(339));
			} finally {
				root.unmount();
				container.remove();
			}
		},
	);
});
