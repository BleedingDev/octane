import { afterEach, expect, it, vi } from 'vitest';
import * as Client from 'octane';
import * as Signals from 'octane/signals';
import { installSignalDocumentLifecycle } from 'octane/hydration/streamed-signals';
import { loadCompiledFixtureSource } from '../_server-fixture.js';
import { deferred } from '../_server-stream.js';
import { installViewTransitionMocks } from '../conformance/_helpers/view-transition-mocks.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	document.body.replaceChildren();
});

function reader() {
	const attempts: { signal: AbortSignal; result: ReturnType<typeof deferred<string>> }[] = [];
	return {
		attempts,
		load(_key: string, { signal }: { signal: AbortSignal }) {
			const result = deferred<string>();
			attempts.push({ signal, result });
			return result.promise;
		},
	};
}

function transition(type: 'pagehide' | 'pageshow', persisted = true) {
	window.dispatchEvent(new PageTransitionEvent(type, { persisted }));
}

function holdViewTransition() {
	const mocks = installViewTransitionMocks();
	const fontReady = deferred<void>();
	const fonts = { status: 'loaded', ready: fontReady.promise };
	const previousFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
	Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
	const handles: {
		update: () => void | Promise<void>;
		ready: ReturnType<typeof deferred<void>>;
		finished: ReturnType<typeof deferred<void>>;
	}[] = [];
	(document as unknown as Record<string, unknown>).startViewTransition = (input: {
		update: () => void | Promise<void>;
	}) => {
		const ready = deferred<void>();
		const finished = deferred<void>();
		handles.push({ update: input.update, ready, finished });
		return { ready: ready.promise, finished: finished.promise, skipTransition() {} };
	};
	const releaseFonts = () => {
		fonts.status = 'loaded';
		fontReady.resolve(undefined);
	};
	cleanups.push(() => {
		releaseFonts();
		for (const handle of handles) {
			handle.ready.resolve(undefined);
			handle.finished.resolve(undefined);
		}
		if (previousFonts === undefined) delete (document as unknown as Record<string, unknown>).fonts;
		else Object.defineProperty(document, 'fonts', previousFonts);
		mocks.restore();
	});
	return { handles, fonts, requestFont: () => (fonts.status = 'loading'), releaseFonts };
}

function mount$(
	first: ReturnType<typeof reader>,
	second?: ReturnType<typeof reader>,
	withHostSignalOwner = true,
	requestFont?: () => void,
) {
	const retiredPublishers: { label: string; status: string; hostDraft: string }[] = [];
	const remote = loadCompiledFixtureSource(
		`
		import { useLayoutEffect } from 'octane';
		import { query$ } from 'octane/signals';
		export function Remote({ load, label, onRetire, readHostDraft$ }) @{
			const value$ = query$(() => label, load);
			const value = value$.snapshot();
			useLayoutEffect(() => () => {
				onRetire({ label, status: value$.snapshot().status, hostDraft: readHostDraft$() });
			}, []);
			<section data-reader={label}>
				<input defaultValue="draft" />
				<output>{value.status === 'ready' ? value.value : value.status}</output>
			</section>
		}
	`,
		{
			id: '/external-snapshot-document-lifecycle/remote.tsrx',
			mode: 'client',
			compileOptions: { dev: false, hmr: false },
			runtimeModules: { 'octane/signals': Signals },
		},
	);
	const snapshot = vi.fn(async () => {
		throw new Error('A client mount must not fetch server HTML.');
	});
	const Boundary = Client.externalSnapshotBoundary({
		authority: { publisherBuildId: 'publisher', runtimeABI: 1 },
		component: remote.Remote,
		snapshot,
	});
	const host = loadCompiledFixtureSource(
		`
		import { useInsertionEffect, ViewTransition } from 'octane';
		import { Boundary } from 'publisher-boundary';
		export function Host({ loadA, loadB, showA, onRetire, readHostDraft$ }) @{
			<main>
				@if (showA) { <Boundary load={loadA} label="A" onRetire={onRetire} readHostDraft$={readHostDraft$} /> }
				@if (loadB) { <Boundary load={loadB} label="B" onRetire={onRetire} readHostDraft$={readHostDraft$} /> }
			</main>
		}
		function RemovalGate({ removal }) @{
			if (removal !== undefined) {
				removal.attempted();
				throw removal.pending;
			}
			<span data-removal-gate />
		}
		export function TransitionHost(props) @{
			useInsertionEffect(() => {
				if (!props.showA) props.requestFont();
			}, [props.showA]);
			<ViewTransition><Host {...props} /><RemovalGate removal={props.removal} /></ViewTransition>
		}
	`,
		{
			id: '/external-snapshot-document-lifecycle/host.tsrx',
			mode: 'client',
			compileOptions: { dev: false, hmr: false },
			runtimeModules: { 'publisher-boundary': { Boundary } },
		},
	);
	const signalOwner = Signals.createScope({ scopeKey: 'external-lifecycle-host' });
	const hostDraft$ = signalOwner.signal$('host-draft', 'host remains live');
	const readHostDraft$ = () => hostDraft$.get();
	const onRetire = (publisher: (typeof retiredPublishers)[number]) =>
		retiredPublishers.push(publisher);
	let identity = { buildId: 'host', documentId: 'host-document' };
	const onMismatch = vi.fn();
	const lifecycle = installSignalDocumentLifecycle({
		document,
		buildId: 'host',
		documentId: 'host-document',
		signalOwner,
		readIdentity: () => identity,
		onMismatch,
	});
	const container = document.createElement('div');
	document.body.append(container);
	const root = Client.createRoot(container, {
		...(withHostSignalOwner ? { signalOwner } : {}),
		externalSnapshots: { documentId: 'host-document' },
	});
	const render = (showA: boolean, removal?: { pending: Promise<void>; attempted: () => void }) =>
		root.render(requestFont === undefined ? host.Host : host.TransitionHost, {
			loadA: first.load,
			loadB: second?.load,
			showA,
			onRetire,
			readHostDraft$,
			requestFont,
			removal,
		});
	cleanups.push(() => {
		root.unmount();
		lifecycle.dispose();
		signalOwner.dispose();
		expect(snapshot).not.toHaveBeenCalled();
	});
	render(true);
	return {
		container,
		render,
		onMismatch,
		signalOwner,
		hostDraft$,
		retiredPublishers,
		mountForeignPublisher(pending: ReturnType<typeof reader>) {
			const errors: unknown[] = [];
			const siblingContainer = document.createElement('div');
			document.body.append(siblingContainer);
			const sibling = Client.createRoot(siblingContainer, {
				signalOwner,
				externalSnapshots: { documentId: 'foreign-document' },
				onUncaughtError: (error) => errors.push(error),
			});
			cleanups.push(() => sibling.unmount());
			sibling.render(Boundary, { load: pending.load, label: 'foreign', onRetire, readHostDraft$ });
			return errors;
		},
		changeHost() {
			identity = { ...identity, buildId: 'replacement-host' };
		},
	};
}

it.each([true, false])(
	'restarts an isolated client publisher read after restore with explicit host owner %s',
	async (withHostSignalOwner) => {
		const pending = reader();
		const { container, onMismatch } = mount$(pending, undefined, withHostSignalOwner);
		await Client.act(async () => {});
		expect(pending.attempts).toHaveLength(1);
		const input = container.querySelector('input')!;
		input.value = 'retained draft';
		transition('pagehide');
		expect(pending.attempts[0].signal.aborted).toBe(true);
		transition('pageshow');
		await Client.act(async () => {});
		expect(pending.attempts).toHaveLength(2);
		pending.attempts[1].result.resolve('fresh');
		await Client.act(async () => {});
		pending.attempts[0].result.resolve('stale');
		await Client.act(async () => {});
		expect(container.querySelector('output')!.textContent).toBe('fresh');
		expect(container.querySelector('input')).toBe(input);
		expect(input.value).toBe('retained draft');
		expect(onMismatch).not.toHaveBeenCalled();
	},
);

it('retires a publisher when the host identity changes even though its publisher build is unchanged', async () => {
	const pending = reader();
	const { container, changeHost, onMismatch, retiredPublishers } = mount$(pending);
	await Client.act(async () => {});
	expect(pending.attempts).toHaveLength(1);
	transition('pagehide');
	changeHost();
	transition('pageshow');
	await Client.act(async () => {});
	expect(onMismatch).toHaveBeenCalledOnce();
	expect(retiredPublishers).toEqual([
		{ label: 'A', status: 'pending', hostDraft: 'host remains live' },
	]);
	expect(pending.attempts[0].signal.aborted).toBe(true);
	expect(pending.attempts).toHaveLength(1);
	pending.attempts[0].result.resolve('obsolete result');
	await Client.act(async () => {});
	expect(container.textContent).not.toContain('obsolete result');
});

it('does not restart a removed publisher while a retained sibling resumes', async () => {
	const removed = reader();
	const retained = reader();
	const { container, render, onMismatch, retiredPublishers } = mount$(removed, retained);
	await Client.act(async () => {});
	expect(removed.attempts).toHaveLength(1);
	expect(retained.attempts).toHaveLength(1);
	transition('pagehide');
	await Client.act(() => render(false));
	expect(container.querySelector('[data-reader="A"]')).toBeNull();
	expect(retiredPublishers).toEqual([
		{ label: 'A', status: 'pending', hostDraft: 'host remains live' },
	]);
	transition('pageshow');
	await Client.act(async () => {});
	expect(removed.attempts).toHaveLength(1);
	expect(removed.attempts[0].signal.aborted).toBe(true);
	expect(retained.attempts).toHaveLength(2);
	retained.attempts[1].result.resolve('sibling resumed');
	removed.attempts[0].result.resolve('removed result');
	retained.attempts[0].result.resolve('old sibling result');
	await Client.act(async () => {});
	expect(container.querySelector('output')!.textContent).toBe('sibling resumed');
	expect(onMismatch).not.toHaveBeenCalled();
});

it('keeps publisher data live for cleanup when a deferred-layout removal publishes', async () => {
	const viewTransition = holdViewTransition();
	const pending = reader();
	const { container, render, retiredPublishers, onMismatch } = mount$(
		pending,
		undefined,
		false,
		viewTransition.requestFont,
	);
	await Client.act(async () => {});
	const input = container.querySelector('input')!;
	input.value = 'draft until publication';
	Client.startTransition(() => render(false));
	await vi.waitFor(() => expect(viewTransition.handles).toHaveLength(1));
	expect(container.querySelector('input')).toBe(input);
	expect(input.value).toBe('draft until publication');
	expect(pending.attempts[0].signal.aborted).toBe(false);
	expect(retiredPublishers).toEqual([]);
	const handle = viewTransition.handles[0];
	try {
		const updated = handle.update();
		await vi.waitFor(() => expect(viewTransition.fonts.status).toBe('loading'));
		expect(retiredPublishers).toEqual([
			{ label: 'A', status: 'pending', hostDraft: 'host remains live' },
		]);
		expect(pending.attempts[0].signal.aborted).toBe(true);
		expect(container.querySelector('input')).toBeNull();
		viewTransition.releaseFonts();
		await updated;
		handle.ready.resolve(undefined);
		handle.finished.resolve(undefined);
		await Client.act(async () => {});
		transition('pagehide');
		transition('pageshow');
		pending.attempts[0].result.resolve('retired completion');
		await Client.act(async () => {});
		expect(pending.attempts).toHaveLength(1);
		expect(container.textContent).not.toContain('retired completion');
		expect(onMismatch).not.toHaveBeenCalled();
	} finally {
		viewTransition.releaseFonts();
	}
});

it('keeps a publisher live when its suspended transition removal is abandoned', async () => {
	const viewTransition = holdViewTransition();
	const pending = reader();
	const removal = deferred<void>();
	const attempted = vi.fn();
	const { container, render, retiredPublishers, onMismatch } = mount$(
		pending,
		undefined,
		false,
		() => {},
	);
	await Client.act(async () => {});
	const input = container.querySelector('input')!;
	input.value = 'retained after rollback';
	Client.startTransition(() => render(false, { pending: removal.promise, attempted }));
	await vi.waitFor(() => expect(viewTransition.handles).toHaveLength(1));
	expect(attempted).toHaveBeenCalled();
	expect(pending.attempts[0].signal.aborted).toBe(false);
	expect(retiredPublishers).toEqual([]);
	const handle = viewTransition.handles[0];
	await handle.update();
	handle.ready.resolve(undefined);
	handle.finished.resolve(undefined);
	await Promise.resolve();
	expect(container.querySelector('input')).toBe(input);
	expect(input.value).toBe('retained after rollback');
	expect(pending.attempts[0].signal.aborted).toBe(false);
	expect(retiredPublishers).toEqual([]);
	Client.flushSync(() => render(true));
	removal.resolve(undefined);
	await Client.act(async () => {});
	expect(container.querySelector('input')).toBe(input);
	expect(input.value).toBe('retained after rollback');
	expect(pending.attempts[0].signal.aborted).toBe(false);
	expect(retiredPublishers).toEqual([]);
	transition('pagehide');
	expect(pending.attempts[0].signal.aborted).toBe(true);
	transition('pageshow');
	await Client.act(async () => {});
	expect(pending.attempts).toHaveLength(2);
	pending.attempts[1].result.resolve('resumed publisher');
	pending.attempts[0].result.resolve('obsolete transition result');
	await Client.act(async () => {});
	expect(container.querySelector('output')!.textContent).toBe('resumed publisher');
	expect(container.querySelector('input')).toBe(input);
	expect(input.value).toBe('retained after rollback');
	expect(retiredPublishers).toEqual([]);
	expect(onMismatch).not.toHaveBeenCalled();
});

it('holds a newly mounted publisher read until its frozen host resumes', async () => {
	const pending = reader();
	const { container, render, onMismatch } = mount$(pending);
	await Client.act(async () => {});
	expect(pending.attempts).toHaveLength(1);
	await Client.act(() => render(false));
	expect(pending.attempts[0].signal.aborted).toBe(true);
	transition('pagehide');
	await Client.act(() => render(true));
	expect(pending.attempts).toHaveLength(1);
	transition('pageshow');
	await Client.act(async () => {});
	expect(pending.attempts).toHaveLength(2);
	pending.attempts[1].result.resolve('mounted after freeze');
	pending.attempts[0].result.resolve('old mount');
	await Client.act(async () => {});
	expect(container.querySelector('output')!.textContent).toBe('mounted after freeze');
	expect(onMismatch).not.toHaveBeenCalled();
});

it('rejects a foreign publisher document without retiring the host or healthy sibling', async () => {
	const first = reader();
	const sibling = reader();
	const refused = reader();
	const { container, hostDraft$, mountForeignPublisher, onMismatch } = mount$(first, sibling);
	await Client.act(async () => {});
	const errors = mountForeignPublisher(refused);
	await Client.act(async () => {});
	expect(errors).toHaveLength(1);
	expect(String(errors[0])).toMatch(/document identities must match|Minified Octane error #357/);
	expect(refused.attempts).toHaveLength(0);
	expect(hostDraft$.get()).toBe('host remains live');
	transition('pagehide');
	transition('pageshow');
	await Client.act(async () => {});
	expect(first.attempts).toHaveLength(2);
	expect(sibling.attempts).toHaveLength(2);
	first.attempts[1].result.resolve('first healthy');
	sibling.attempts[1].result.resolve('sibling healthy');
	first.attempts[0].result.resolve('first obsolete');
	sibling.attempts[0].result.resolve('sibling obsolete');
	await Client.act(async () => {});
	expect(container.querySelector('[data-reader="A"] output')!.textContent).toBe('first healthy');
	expect(container.querySelector('[data-reader="B"] output')!.textContent).toBe('sibling healthy');
	expect(hostDraft$.get()).toBe('host remains live');
	expect(onMismatch).not.toHaveBeenCalled();
});
