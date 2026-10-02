import { describe, expect, it, vi } from 'vitest';
import { act, createRoot, flushSync, hydrateRoot } from 'octane';
import { bootstrapStreamedSignalHydration } from 'octane/hydration/streamed-signals';
import * as signals from 'octane/signals';
import { drainProducers } from '../_fixtures/signals-async-controls.js';
import { flushEffects } from '../_helpers.js';
import { loadServerFixture } from '../_server-fixture.js';
import {
	activateStreamedMarkup,
	collectReadableStream,
	resetStreamRuntimeGlobals,
} from '../_server-stream.js';
import * as client from './_fixtures/control-flow-signal-identity.tsrx';

const server = loadServerFixture<typeof client>(
	'packages/octane/tests/hydration/_fixtures/control-flow-signal-identity.tsrx',
	{ runtimeModules: { 'octane/signals': signals } },
);

describe('signals through native control flow', () => {
	it('replays a completed server stream when an interaction hydrates nested try content', async () => {
		const serverLoad = vi.fn(async function* () {
			yield 'Server complete';
		});
		const browserLoad = vi.fn(async function* () {
			yield 'Browser replacement';
		});
		const onClick = vi.fn();
		const onHydrated = vi.fn();
		const streamedSignals = {
			buildId: 'control-flow-signals',
			documentId: 'control-flow-signals',
		};
		const output = await collectReadableStream(
			server.DeferredStream,
			{ load: serverLoad, onClick, onHydrated },
			{ streamedSignals },
		);
		expect(output.errors).toEqual([]);
		expect(serverLoad).toHaveBeenCalledOnce();
		const container = document.createElement('div');
		document.body.append(container);
		let root: ReturnType<typeof hydrateRoot> | undefined;
		let hydration: ReturnType<typeof bootstrapStreamedSignalHydration> | undefined;
		try {
			container.innerHTML = output.html;
			activateStreamedMarkup(container);
			const button = container.querySelector<HTMLButtonElement>('#deferred-signal')!;
			expect(button.textContent).toBe('Server complete');
			const errors: unknown[] = [];
			hydration = bootstrapStreamedSignalHydration(streamedSignals);
			root = hydrateRoot(
				container,
				client.DeferredStream,
				{ load: browserLoad, onClick, onHydrated },
				{
					signalOwner: hydration.signalOwner,
					onRecoverableError: (error) => errors.push(error),
					onUncaughtError: (error) => errors.push(error),
				},
			);
			flushEffects();
			expect(browserLoad).not.toHaveBeenCalled();
			expect(onHydrated).not.toHaveBeenCalled();
			await act(() => button.click());
			await vi.waitFor(() => expect(onHydrated).toHaveBeenCalledOnce(), { timeout: 4000 });
			await drainProducers();
			flushSync(() => {});
			expect(onClick).toHaveBeenCalledOnce();
			expect(browserLoad).not.toHaveBeenCalled();
			expect(container.querySelector('#deferred-signal')).toBe(button);
			expect(button.textContent).toBe('Server complete');
			expect(errors).toEqual([]);
		} finally {
			root?.unmount();
			hydration?.dispose();
			container.remove();
			resetStreamRuntimeGlobals();
		}
	});

	it.each([
		['declarations', client.ComponentCounters],
		['callbacks', client.CallbackCounters],
	] as const)(
		'shares %s state across conditional arms without retiring it or sharing sibling state',
		async (_kind, Component) => {
			const container = document.createElement('div');
			document.body.append(container);
			const root = createRoot(container);
			const read = (label: string, value: string) =>
				container.querySelector(`[data-counter="${label}"] [data-value="${value}"]`)?.textContent;
			const click = (label: string, action: string) =>
				act(() =>
					container
						.querySelector<HTMLButtonElement>(
							`[data-counter="${label}"] [data-action="${action}"]`,
						)!
						.click(),
				);
			try {
				await act(() => root.render(Component, { showFirst: true }));
				await click('first', 'direct');
				expect(read('first', 'direct')).toBe('1');
				expect(read('first', 'nested')).toBe('1');
				expect(read('second', 'direct')).toBe('0');
				expect(read('second', 'nested')).toBe('0');
				await act(() => root.render(Component, { showFirst: false }));
				expect(read('first', 'nested')).toBeUndefined();
				await click('first', 'direct');
				expect(read('first', 'direct')).toBe('2');
				await act(() => root.render(Component, { showFirst: true }));
				expect(read('first', 'nested')).toBe('2');
				await click('first', 'nested');
				expect(read('first', 'direct')).toBe('3');
				expect(read('first', 'nested')).toBe('3');
				expect(read('second', 'direct')).toBe('0');
				expect(read('second', 'nested')).toBe('0');
			} finally {
				root.unmount();
				container.remove();
			}
		},
	);

	it('preserves independent keyed component state through arm removal and row moves', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		const items = [
			{ label: 'first', show: true },
			{ label: 'second', show: true },
		];
		const read = (label: string, value: string) =>
			container.querySelector(`[data-counter="${label}"] [data-value="${value}"]`)?.textContent;
		try {
			await act(() => root.render(client.KeyedCounters, { items }));
			const first = container.querySelector('[data-counter="first"]');
			await act(() =>
				container
					.querySelector<HTMLButtonElement>('[data-counter="first"] [data-action="nested"]')!
					.click(),
			);
			expect(read('first', 'direct')).toBe('1');
			expect(read('second', 'nested')).toBe('0');
			await act(() => root.render(client.KeyedCounters, { items: items.toReversed() }));
			expect(container.querySelector('[data-counter="first"]')).toBe(first);
			expect(read('first', 'direct')).toBe('1');
			expect(read('first', 'nested')).toBe('1');
			await act(() =>
				root.render(client.KeyedCounters, { items: [{ label: 'first', show: false }] }),
			);
			expect(read('first', 'direct')).toBe('1');
			await act(() => root.render(client.KeyedCounters, { items }));
			expect(read('first', 'nested')).toBe('1');
			expect(read('second', 'direct')).toBe('0');
			expect(read('second', 'nested')).toBe('0');
		} finally {
			root.unmount();
			container.remove();
		}
	});

	it('preserves root component state when conditional content is removed and restored', async () => {
		const container = document.createElement('div');
		document.body.append(container);
		const root = createRoot(container);
		const read = (value: string) => container.querySelector(`[data-value="${value}"]`)?.textContent;
		try {
			await act(() => root.render(client.Counter, { label: 'root', show: true }));
			await act(() =>
				container.querySelector<HTMLButtonElement>('[data-action="direct"]')!.click(),
			);
			expect(read('direct')).toBe('1');
			expect(read('nested')).toBe('1');
			await act(() => root.render(client.Counter, { label: 'root', show: false }));
			expect(read('nested')).toBeUndefined();
			await act(() =>
				container.querySelector<HTMLButtonElement>('[data-action="direct"]')!.click(),
			);
			expect(read('direct')).toBe('2');
			await act(() => root.render(client.Counter, { label: 'root', show: true }));
			expect(read('nested')).toBe('2');
		} finally {
			root.unmount();
			container.remove();
		}
	});
});
