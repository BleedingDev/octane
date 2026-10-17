import { expect, it, vi } from 'vitest';
import {
	installSignalDocumentLifecycle,
	joinSignalDocumentLifecycle,
} from '../../src/hydration/document-lifecycle.js';
import { createResource, createScope, query } from 'octane/signals';

it('retires every publisher before reporting the first teardown failure', () => {
	const host = createScope({ scopeKey: 'retiring-host' });
	const first = createScope({ scopeKey: 'retiring-first' });
	const sibling = createScope({ scopeKey: 'retiring-sibling' });
	const lifecycle = installSignalDocumentLifecycle({
		document,
		buildId: 'host',
		documentId: 'document',
		signalOwner: host,
	});
	const failure = new Error('publisher teardown failed');
	const firstSuspend = vi.fn(() => {
		throw new Error('later stream cleanup failure');
	});
	const siblingRetire = vi.fn();
	const siblingSuspend = vi.fn();
	let pendingSignal!: AbortSignal;
	const fetch = query('retiring-sibling-read', (_key: string, { signal }) => {
		pendingSignal = signal;
		return new Promise<string>(() => {});
	});
	const value$ = createResource(sibling, 'pending', () => fetch('key'));
	value$.snapshot();
	const join = (signalOwner: typeof first, onRetire: () => void, suspend: () => void) =>
		joinSignalDocumentLifecycle({
			document,
			documentId: 'document',
			hostSignalOwner: host,
			signalOwner,
			streamedHydration: { suspend },
			onRetire,
		});
	join(
		first,
		() => {
			throw failure;
		},
		firstSuspend,
	);
	join(sibling, siblingRetire, siblingSuspend);
	try {
		expect(pendingSignal.aborted).toBe(false);
		let reported: unknown;
		try {
			lifecycle.dispose();
		} catch (error) {
			reported = error;
		}
		expect(reported).toBe(failure);
		expect(first.retired).toBe(true);
		expect(sibling.retired).toBe(true);
		expect(host.retired).toBe(true);
		expect(pendingSignal.aborted).toBe(true);
		expect(siblingRetire).toHaveBeenCalledOnce();
		expect(firstSuspend).toHaveBeenCalledOnce();
		expect(siblingSuspend).toHaveBeenCalledOnce();
		expect(() => value$.snapshot()).toThrow(/retired|disposed/);
		expect(() => lifecycle.dispose()).not.toThrow();
	} finally {
		lifecycle.dispose();
		first.dispose();
		sibling.dispose();
		host.dispose();
	}
});
