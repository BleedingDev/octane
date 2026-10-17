import { afterEach, describe, expect, it } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import * as ClientSignals from 'octane/signals/client';
import * as ServerSignals from 'octane/signals/server';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, resetStreamRuntimeGlobals } from '../_server-stream.js';

const Theme = createContext('default');
const source = `import {memo, useContext, useId} from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
export function Remote(props) {
 const count$ = useSignal$(props.initial);
 const id = useId();
 const theme = useContext(Theme);
 return <section><output data-label>{String(props.label)}</output><span data-theme>{theme}</span><input id={id} defaultValue="draft"/><button onClick={() => count$.set(value => value + 1)}>{count$.get()}</button></section>;
}
Remote.defaultProps = {label: 'factory default'};
export const MemoRemote = memo(Remote, (previous, incoming) => previous.memoKey === incoming.memoKey);`;

interface HostProps {
	label: string | undefined;
	initial: number;
	theme: string;
	memoKey: number;
	epoch: number;
}

function pair() {
	const common = {
		id: '/publisher/ComponentContract.tsx',
		compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod' },
		runtimeModules: {
			'./context': { Theme },
			'octane/signals/client': ClientSignals,
			'octane/signals/server': ServerSignals,
		},
	};
	return {
		server: loadCompiledFixtureSource(source, { ...common, mode: 'server' }),
		client: loadCompiledFixtureSource(source, { ...common, mode: 'client' }),
	};
}

function fixture(kind: string, memoized: boolean) {
	const modules = pair();
	const serverComponent = memoized ? modules.server.MemoRemote : modules.server.Remote;
	const clientComponent = memoized ? modules.client.MemoRemote : modules.client.Remote;
	const serverEntry =
		kind === 'publisher'
			? Server.publisherBoundary(serverComponent, { publisherKey: 'component-contract' })
			: serverComponent;
	const clientEntry =
		kind === 'publisher'
			? Client.publisherBoundary(clientComponent, { publisherKey: 'component-contract' })
			: clientComponent;
	const serverApp = (props: HostProps) =>
		Server.createElement(Theme, {
			value: props.theme,
			children: Server.createElement(serverEntry, {
				label: props.label,
				initial: props.initial,
				memoKey: props.memoKey,
				epoch: props.epoch,
			}),
		});
	const clientApp = (props: HostProps) =>
		Client.createElement(Theme, {
			value: props.theme,
			children: Client.createElement(clientEntry, {
				label: props.label,
				initial: props.initial,
				memoKey: props.memoKey,
				epoch: props.epoch,
			}),
		});
	return { modules, serverApp, clientApp };
}

afterEach(() => {
	resetStreamRuntimeGlobals();
	document.head.innerHTML = '';
});

describe.each(['ordinary component', 'publisher'])('native %s contract', (kind) => {
	it('resolves undefined props from the original component live defaults', () => {
		const { modules, serverApp, clientApp } = fixture(kind, false);
		// Change the original after creating its publisher wrapper. The wrapper
		// must enter the native component boundary, which resolves current defaults.
		modules.server.Remote.defaultProps = { label: 'live server default' };
		modules.client.Remote.defaultProps = { label: 'live server default' };
		const props: HostProps = {
			label: undefined,
			initial: 7,
			theme: 'server context',
			memoKey: 0,
			epoch: 0,
		};
		const container = document.createElement('div');
		document.body.append(container);
		container.innerHTML = Server.renderToString(serverApp, props).html;
		activateStreamedMarkup(container);
		const section = container.querySelector('section')!;
		const output = container.querySelector('output')!;
		expect(output.textContent).toBe('live server default');
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(container, clientApp, props, {
			onUncaughtError: (error) => errors.push(error),
			onRecoverableError: (error) => errors.push(error),
		});
		try {
			Client.flushSync(() => {});
			expect(container.querySelector('section')).toBe(section);
			expect(container.querySelector('output')).toBe(output);
			expect(output.textContent).toBe('live server default');

			modules.client.Remote.defaultProps = { label: 'live client default' };
			Client.flushSync(() => root.render(clientApp, { ...props, epoch: 1 }));
			expect(container.querySelector('section')).toBe(section);
			expect(container.querySelector('output')).toBe(output);
			expect(output.textContent).toBe('live client default');
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('keeps memo comparisons, live context, and adopted native state', () => {
		const { serverApp, clientApp } = fixture(kind, true);
		const props: HostProps = {
			label: 'accepted label',
			initial: 7,
			theme: 'server context',
			memoKey: 0,
			epoch: 0,
		};
		const container = document.createElement('div');
		document.body.append(container);
		container.innerHTML = Server.renderToString(serverApp, props).html;
		activateStreamedMarkup(container);
		const section = container.querySelector('section')!;
		const output = container.querySelector('output')!;
		const theme = container.querySelector('[data-theme]')!;
		const input = container.querySelector('input')!;
		const button = container.querySelector('button')!;
		const inputId = input.id;
		input.value = 'typed before hydration';
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(container, clientApp, props, {
			onUncaughtError: (error) => errors.push(error),
			onRecoverableError: (error) => errors.push(error),
		});
		try {
			Client.flushSync(() => {});
			expect(container.querySelector('section')).toBe(section);
			expect(container.querySelector('input')).toBe(input);
			expect(container.querySelector('button')).toBe(button);
			expect(input.value).toBe('typed before hydration');
			Client.flushSync(() => button.click());
			expect(button.textContent).toBe('8');

			// The comparator accepts the earlier props when memoKey stays equal.
			Client.flushSync(() =>
				root.render(clientApp, { ...props, label: 'ignored label', initial: 99, epoch: 1 }),
			);
			expect(output.textContent).toBe('accepted label');
			expect(theme.textContent).toBe('server context');
			expect(button.textContent).toBe('8');

			// Keep the accepted child props stable while only the ancestor context
			// changes, so context refresh is independent of comparator acceptance.
			Client.flushSync(() => root.render(clientApp, { ...props, theme: 'live context' }));
			expect(output.textContent).toBe('accepted label');
			expect(theme.textContent).toBe('live context');
			expect(button.textContent).toBe('8');
			expect(container.querySelector('section')).toBe(section);
			expect(container.querySelector('output')).toBe(output);
			expect(container.querySelector('[data-theme]')).toBe(theme);
			expect(container.querySelector('input')).toBe(input);
			expect(container.querySelector('button')).toBe(button);
			expect(input.id).toBe(inputId);
			expect(input.value).toBe('typed before hydration');

			Client.flushSync(() =>
				root.render(clientApp, {
					...props,
					label: 'new accepted label',
					memoKey: 1,
					theme: 'live context',
				}),
			);
			expect(output.textContent).toBe('new accepted label');
			expect(theme.textContent).toBe('live context');
			Client.flushSync(() => button.click());
			expect(button.textContent).toBe('9');
			expect(container.querySelector('input')).toBe(input);
			expect(input.value).toBe('typed before hydration');
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});
});
