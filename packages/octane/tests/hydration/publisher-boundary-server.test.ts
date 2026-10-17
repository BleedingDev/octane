import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Server from 'octane/server';
import * as Signals from 'octane/signals';
import { prerender } from '../../src/runtime.server.js';
import { createContext } from '../../src/universal-native.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import {
	activateStreamedMarkup,
	collectPipeableStream,
	deferred,
	resetStreamRuntimeGlobals,
} from '../_server-stream.js';
import {
	PUBLISHER_BOUNDARY_ATTR,
	decodePublisherBoundaryDescriptor,
} from '../../src/publisher-boundary-protocol.js';

afterEach(resetStreamRuntimeGlobals);
const Theme = createContext('default');

function fixture(source: string, id: string, dev: boolean, runtimeModules = {}) {
	return loadCompiledFixtureSource(source, {
		id,
		mode: 'server',
		compileOptions: { dev },
		runtimeModules,
	});
}

function markup(html: string) {
	const container = document.createElement('div');
	container.innerHTML = html;
	return container;
}

function descriptors(container: HTMLElement) {
	return [...container.querySelectorAll(`script[${PUBLISHER_BOUNDARY_ATTR}]`)].map((script) =>
		decodePublisherBoundaryDescriptor(script.textContent),
	);
}

describe.each([false, true])('native local publisher SSR, dev=%s', (dev) => {
	it('keeps live ancestor context and private IDs without requiring streamed authority', () => {
		const remote = fixture(
			`import {useContext,useId} from 'octane'; import {Theme} from './contexts'; function Field(){const id=useId();return <input id={id}/>;} export function Remote(props){const theme=useContext(Theme);return <section data-publisher={props.label}><label>{theme}</label><Field/>{props.extra?<Field/>:null}</section>;}`,
			'/publisher/Fields.tsx',
			dev,
			{ './contexts': { Theme } },
		);
		const Boundary = Server.publisherBoundary(remote.Remote, { publisherKey: 'local-publisher' });
		const host = fixture(
			`import {useId} from 'octane';import {Theme} from './contexts';import {Boundary} from './publisher';function Field(props){const id=useId();return <span data-host={props.label} id={id}/>;}export function App(props){return <Theme value={props.theme}><main><Field label="before"/><Boundary label="a" extra={props.extra}/><Boundary label="b"/><Field label="after"/></main></Theme>;}`,
			'/host/PublisherFields.tsx',
			dev,
			{ './contexts': { Theme }, './publisher': { Boundary } },
		);
		const outputs = [false, true].map((extra) =>
			markup(
				Server.renderToString(
					host.App,
					{ theme: 'live ancestor', extra },
					{ externalSnapshots: { documentId: 'external-config-is-not-authority' } },
				).html,
			),
		);
		const hostIds = outputs.map((container) =>
			[...container.querySelectorAll('[data-host]')].map((node) => node.id),
		);
		expect(hostIds[0]).toEqual(hostIds[1]);
		for (const container of outputs) {
			expect([...container.querySelectorAll('label')].map((node) => node.textContent)).toEqual([
				'live ancestor',
				'live ancestor',
			]);
			const entries = descriptors(container);
			expect(entries).toHaveLength(2);
			expect(
				entries.every((entry) => entry.documentId === null && entry.streamBuildId === null),
			).toBe(true);
			expect(new Set(entries.map((entry) => entry.ownerKey)).size).toBe(2);
			const ids = [...container.querySelectorAll('[id]')].map((node) => node.id);
			expect(new Set(ids).size).toBe(ids.length);
		}
	});

	it('uses native streamed authority and rejects conflicting document configuration', () => {
		const Boundary = Server.publisherBoundary(
			() => Server.createElement('p', { children: 'publisher' }),
			{ publisherKey: '</script><publisher>' },
		);
		const streamedSignals = { buildId: 'native-build', documentId: 'native-document' };
		const result = Server.renderToString(Boundary, {}, { streamedSignals });
		const entry = descriptors(markup(result.html))[0]!;
		expect(entry.publisherKey).toBe('</script><publisher>');
		expect(entry.documentId).toBe('native-document');
		expect(entry.streamBuildId).toBe('native-build');
		expect(markup(result.html).querySelector('p')!.textContent).toBe('publisher');
		expect(() =>
			Server.renderToString(
				Boundary,
				{},
				{ streamedSignals, externalSnapshots: { documentId: 'different-document' } },
			),
		).toThrow();
	});

	it('keeps genuine global queries private through deferred discovery and retires publisher streams', async () => {
		const requests: { owner: string; signal: AbortSignal; stage: string }[] = [];
		const reads: { label: string; owner: string | null; document?: string; instance?: string }[] =
			[];
		const recordRead = (label: string) => {
			const owner = Signals.currentSignalOwner();
			reads.push({
				label,
				owner: owner?.scopeKey ?? null,
				...(owner !== null && 'documentOwner' in owner
					? { document: owner.documentOwner.scopeKey, instance: owner.instanceKey }
					: {}),
			});
		};
		const first = vi.fn(async (_value, context) => {
			const owner = Signals.currentSignalOwner()!.scopeKey;
			requests.push({ owner, signal: context.signal, stage: 'first' });
			return owner + ':first';
		});
		const second = vi.fn((value, context) => {
			const owner = value.slice(0, -':first'.length);
			requests.push({ owner, signal: context.signal, stage: 'second' });
			return (async function* () {
				yield value + ':second';
				if (!context.signal.aborted)
					await new Promise<void>((resolve) =>
						context.signal.addEventListener('abort', () => resolve(), { once: true }),
					);
			})();
		});
		const remote = fixture(
			`import {query$} from 'octane/signals';import {first,second,recordRead} from './loads';export const first$=query$(()=>1,first);export const result$=query$(()=>first$.get(),second,{kind:'stream'});export function Remote(props){recordRead(props.label);return <output data-query={props.label}>{result$.get()}</output>;}`,
			'/publisher/Queries.tsx',
			dev,
			{ 'octane/signals': Signals, './loads': { first, second, recordRead } },
		);
		const A = Server.publisherBoundary(remote.Remote, { publisherKey: 'publisher-a' });
		const B = Server.publisherBoundary(remote.Remote, { publisherKey: 'publisher-b' });
		const host = fixture(
			`import {Local,A,B} from './publisher';export function App(){return <main><Local label="before"/><A label="a"/><B label="b"/><Local label="after"/></main>;}`,
			'/host/PublisherQueries.tsx',
			dev,
			{ './publisher': { Local: remote.Remote, A, B } },
		);
		const owner = Signals.createScope({ scopeKey: 'publisher-host-' + dev });
		try {
			const result = await prerender(host.App, {}, { signalOwner: owner });
			const container = markup(result.html);
			const entries = descriptors(container);
			expect(entries).toHaveLength(2);
			const expected = [
				owner.scopeKey,
				entries[0]!.ownerKey,
				entries[1]!.ownerKey,
				owner.scopeKey,
			].map((key) => key + ':first:second');
			expect([...container.querySelectorAll('output')].map((node) => node.textContent)).toEqual(
				expected,
			);
			for (const [index, entry] of entries.entries()) {
				const ownedReads = reads.filter((read) => read.label === (index === 0 ? 'a' : 'b'));
				expect(ownedReads.length).toBeGreaterThan(0);
				expect(
					ownedReads.every(
						(read) => read.owner === entry.ownerKey && read.document === entry.ownerKey,
					),
				).toBe(true);
				expect(
					requests
						.filter((request) => request.owner === entry.ownerKey)
						.map((request) => request.stage)
						.sort(),
				).toEqual(['first', 'second']);
				expect(
					requests
						.filter((request) => request.owner === entry.ownerKey && request.stage === 'second')
						.every((request) => request.signal.aborted),
				).toBe(true);
			}
			expect(
				requests.filter(
					(request) => request.owner === owner.scopeKey && request.stage === 'second',
				)[0]!.signal.aborted,
			).toBe(false);
		} finally {
			owner.dispose();
		}
	});

	it('retires provisional publisher work when an ancestor acquires a streamed namespace', async () => {
		const requests: { owner: string; signal: AbortSignal }[] = [];
		const load = (_value, context) => {
			const owner = Signals.currentSignalOwner()!.scopeKey;
			requests.push({ owner, signal: context.signal });
			return (async function* () {
				yield owner;
				if (!context.signal.aborted)
					await new Promise<void>((resolve) =>
						context.signal.addEventListener('abort', () => resolve(), { once: true }),
					);
			})();
		};
		const remote = fixture(
			`import {query$} from 'octane/signals';import {load} from './load';const result$=query$(()=>1,load,{kind:'stream'});export function Remote(){return <output>{result$.get()}</output>;}`,
			'/publisher/Ancestor.tsx',
			dev,
			{ 'octane/signals': Signals, './load': { load } },
		);
		const Boundary = Server.publisherBoundary(remote.Remote, {
			publisherKey: 'ancestor-publisher',
		});
		const gate = deferred<string>();
		const host = fixture(
			`import {Suspense,use} from 'octane';import {Boundary} from './publisher';function Gate(props){return <span>{use(props.promise)}</span>;}export function App(props){return <Suspense fallback={<aside>waiting</aside>}><Boundary/><Gate promise={props.promise}/></Suspense>;}`,
			'/host/PublisherAncestor.tsx',
			dev,
			{ './publisher': { Boundary } },
		);
		const collecting = collectPipeableStream(host.App, { promise: gate.promise });
		gate.resolve('ready');
		const result = await collecting;
		expect(result.errors).toEqual([]);
		const container = markup(result.html);
		document.body.append(container);
		try {
			activateStreamedMarkup(container);
			const finalEntries = descriptors(container);
			expect(finalEntries.length).toBeGreaterThan(0);
			const finalOwners = new Set(finalEntries.map((entry) => entry.ownerKey));
			expect(requests.some((request) => !finalOwners.has(request.owner))).toBe(true);
			expect(requests.every((request) => request.signal.aborted)).toBe(true);
		} finally {
			container.remove();
		}
	});
});
