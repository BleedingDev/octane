import { afterEach, describe, expect, it } from 'vitest';
import * as Client from 'octane';
import * as Server from 'octane/server';
import { prerender } from '../../src/runtime.server.js';
import * as ClientSignals from '../../src/signals/client.js';
import * as ServerSignals from '../../src/signals/server.js';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { activateStreamedMarkup, resetStreamRuntimeGlobals } from '../_server-stream.js';

const Theme = createContext('default');
afterEach(() => {
	resetStreamRuntimeGlobals();
	document.head.innerHTML = '';
});

function pair(source: string, dev: boolean, id = '/shared/Publisher.tsx', modules = {}) {
	const common = {
		id,
		compileOptions: { dev },
		runtimeModules: {
			'./context': { Theme },
			'octane/signals/client': ClientSignals,
			'octane/signals/server': ServerSignals,
			...modules,
		},
	};
	return {
		server: loadCompiledFixtureSource(source, { ...common, mode: 'server' }),
		client: loadCompiledFixtureSource(source, { ...common, mode: 'client' }),
	};
}

const source = `import { useContext, useId } from 'octane';
import {useSignal$} from 'octane/signals/client';
import {Theme} from './context';
export function Remote(props) {
 const value$ = useSignal$(props.initial);
 const id = useId();
 const theme = useContext(Theme);
 return <section data-publisher={props.label}><input id={id} defaultValue="draft"/><button onClick={() => value$.set(v=>v+1)}>{props.label+':'+value$.get()+':'+theme}</button></section>;
}`;

describe.each([false, true])('native local publisher boundaries dev=%s', (dev) => {
	it('adopts the original native signal/ID nodes and keeps live ancestor context with isolated siblings', async () => {
		const first = pair(source, dev);
		const second = pair(source, dev);
		const serverA = Server.publisherBoundary(first.server.Remote, { publisherKey: 'remote/a' });
		const serverB = Server.publisherBoundary(second.server.Remote, { publisherKey: 'remote/b' });
		const serverApp = (props) =>
			Server.createElement(Theme, {
				value: props.theme,
				children: [
					Server.createElement(serverA, { key: 'a', label: 'a', initial: 11 }),
					Server.createElement(serverB, { key: 'b', label: 'b', initial: 19 }),
				],
			});
		const result = await prerender(serverApp, { theme: 'server' });
		const container = document.createElement('div');
		document.body.append(container);
		container.innerHTML = result.html;
		activateStreamedMarkup(container);
		const nodes = ['a', 'b'].map((label) =>
			container.querySelector(`[data-publisher="${label}"]`)!,
		);
		const inputs = nodes.map((node) => node.querySelector('input')!);
		const buttons = nodes.map((node) => node.querySelector('button')!);
		inputs[0].value = 'typed';
		const clientA = Client.publisherBoundary(first.client.Remote, { publisherKey: 'remote/a' });
		const clientB = Client.publisherBoundary(second.client.Remote, { publisherKey: 'remote/b' });
		const clientApp = (props) =>
			Client.createElement(Theme, {
				value: props.theme,
				children: [
					Client.createElement(clientA, { key: 'a', label: 'a', initial: 11 }),
					Client.createElement(clientB, { key: 'b', label: 'b', initial: 19 }),
				],
			});
		const errors: unknown[] = [];
		const root = Client.hydrateRoot(
			container,
			clientApp,
			{ theme: 'server' },
			{ onUncaughtError: (error) => errors.push(error) },
		);
		try {
			Client.flushSync(() => {});
			expect(
				['a', 'b'].map((label) => container.querySelector(`[data-publisher="${label}"]`)),
			).toEqual(nodes);
			expect(inputs[0].value).toBe('typed');
			expect(inputs[0].id).not.toBe(inputs[1].id);
			Client.flushSync(() => buttons[0].click());
			expect(buttons.map((node) => node.textContent)).toEqual(['a:12:server', 'b:19:server']);
			Client.flushSync(() => root.render(clientApp, { theme: 'live' }));
			expect(buttons.map((node) => node.textContent)).toEqual(['a:12:live', 'b:19:live']);
			expect(errors).toEqual([]);
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('keeps host IDs and exact head ownership when a publisher adopts or recovers fresh', async () => {
		const remoteSource = `import {useId} from 'octane';function Field(){const id=useId();return <input id={id} defaultValue="draft"/>;}export function Remote(props) @{ <><meta name={props.label} content={props.title}/><style>.publisher {color: rebeccapurple;}</style><section class="publisher" data-publisher={props.label}><Field/>@if(props.extra){<Field/>}</section></> }`;
		const remote = pair(remoteSource, dev, '/shared/PublisherHead.tsrx');
		const serverBoundary = Server.publisherBoundary(remote.server.Remote, {
			publisherKey: 'remote/head',
		});
		const clientBoundary = Client.publisherBoundary(remote.client.Remote, {
			publisherKey: 'remote/head',
		});
		const hostSource = `import {useId} from 'octane';import {Boundary,Local} from './remote';function HostId(props){const id=useId();return <span id={id} data-host={props.label}/>;}export function App(props) @{ <><Local label="host" title="host title"/><HostId label="before"/><Boundary label="a" title={props.title} extra={true}/>@if(props.second){<Boundary label="b" title="b title"/>}<HostId label="after"/></> }`;
		const serverHost = pair(hostSource, dev, '/host/PublisherHead.tsrx', {
			'./remote': { Boundary: serverBoundary, Local: remote.server.Remote },
		}).server;
		const clientHost = pair(hostSource, dev, '/host/PublisherHead.tsrx', {
			'./remote': { Boundary: clientBoundary, Local: remote.client.Remote },
		}).client;
		for (const fresh of [false, true]) {
			const result = await prerender(
				serverHost.App,
				{ title: 'a title', second: true },
				{ headChannel: 'separate' },
			);
			document.head.innerHTML = result.css + result.head;
			const container = document.createElement('div');
			container.innerHTML = result.html;
			activateStreamedMarkup(container);
			document.body.append(container);
			const hostNodes = [...container.querySelectorAll('[data-host]')];
			const hostIds = hostNodes.map((node) => node.id);
			const sibling = container.querySelector('[data-publisher="b"]')!;
			const siblingInput = sibling.querySelector('input')!;
			siblingInput.value = 'typed sibling';
			const heads = ['host', 'a', 'b'].map((name) =>
				document.head.querySelector(`meta[name="${name}"]`)!,
			);
			expect(heads.every(Boolean)).toBe(true);
			if (fresh) {
				const wrapper = container.querySelector('[data-octane-hydrate-id]')!;
				expect(wrapper.firstChild!.nodeType).toBe(8);
				wrapper.firstChild!.remove();
			}
			const errors: unknown[] = [];
			const root = Client.hydrateRoot(
				container,
				clientHost.App,
				{ title: 'a title', second: true },
				{ onUncaughtError: (error) => errors.push(error) },
			);
			try {
				await Client.act(async () => {});
				expect([...container.querySelectorAll('[data-host]')]).toEqual(hostNodes);
				expect(hostNodes.map((node) => node.id)).toEqual(hostIds);
				const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
				expect(new Set(ids).size).toBe(ids.length);
				expect(container.querySelector('[data-publisher="b"]')).toBe(sibling);
				expect(sibling.querySelector('input')).toBe(siblingInput);
				expect(siblingInput.value).toBe('typed sibling');
				expect(
					['host', 'a', 'b'].map((name) => document.head.querySelector(`meta[name="${name}"]`)),
				).toEqual(heads);
				expect(document.head.querySelectorAll('meta')).toHaveLength(3);
				expect(document.head.querySelectorAll('style')).toHaveLength(1);
				await Client.act(() => root.render(clientHost.App, { title: 'live title', second: false }));
				expect(heads[1]!.getAttribute('content')).toBe('live title');
				expect(heads[2]!.isConnected).toBe(false);
				expect(heads[0]!.isConnected).toBe(true);
				expect(errors).toEqual([]);
			} finally {
				root.unmount();
				container.remove();
			}
			expect(heads.some((node) => node.isConnected)).toBe(false);
		}
	});
});
