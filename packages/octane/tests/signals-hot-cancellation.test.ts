import { afterEach, describe, expect, it } from 'vitest';
import {
	__derivedAt,
	__derivedScalarAt,
	__queryAt,
	createResource,
	createScope,
	query,
	ScopeDisposedError,
	type SignalHandle,
	type SignalSnapshot,
} from 'octane/signals';
import { ScopeImpl } from '../src/signals/engine.js';
import { resolveSignalHandleForScope } from '../src/signals/facade.js';
import { ScopedNode } from '../src/signals/graph.js';
import {
	controlledStream,
	deferred,
	drainProducers,
	nextSnapshot$,
} from './_fixtures/signals-async-controls';

const owners: ScopeImpl[] = [];

function owner(key: string): ScopeImpl {
	const scope = createScope({ scopeKey: key });
	if (!(scope instanceof ScopeImpl)) throw new Error('Expected the native signal scope.');
	owners.push(scope);
	return scope;
}

function materialized(scope: ScopeImpl, handles: SignalHandle<unknown>[]): ScopedNode[] {
	return handles.map((handle) => {
		const cell = resolveSignalHandleForScope(handle, scope);
		if (!(cell instanceof ScopedNode)) throw new Error('Expected a materialized native signal.');
		return cell;
	});
}

afterEach(() => {
	for (const scope of owners.splice(0)) scope.dispose();
});

describe('hot signal cancellation', () => {
	it('seals all affected values before a dependent producer can cancel', () => {
		const scope = owner('hot-cancel-dependent');
		const completion = deferred<number>();
		const a$ = __derivedScalarAt('g:a', () => 1);
		const c$ = __derivedScalarAt('g:c', () => 3);
		const sibling$ = scope.derived$('sibling', () => 40);
		const observed: SignalSnapshot<unknown>[][] = [];
		let cancelled!: AbortSignal;
		const b$ = __derivedAt('g:b', ({ signal }) => {
			a$.get();
			cancelled = signal;
			signal.addEventListener(
				'abort',
				() => {
					observed.push(cells.map((cell) => cell.snapshot()));
				},
				{ once: true },
			);
			return completion.promise;
		});
		const cells = materialized(scope, [a$, b$, c$]);
		expect(cells[0].get()).toBe(1);
		expect(cells[2].get()).toBe(3);
		expect(cells[1].snapshot().status).toBe('pending');
		expect(sibling$.get()).toBe(40);

		const finish = scope.prepareHotDeclarations(cells, 'module:next');
		expect(cancelled.aborted).toBe(false);
		expect(observed).toEqual([]);
		finish();

		expect(cancelled.aborted).toBe(true);
		expect(observed.map((snapshots) => snapshots.map((snapshot) => snapshot.status))).toEqual([
			['pending', 'pending', 'pending'],
		]);
		expect(sibling$.get()).toBe(40);
	});

	it('seals later affected values before an unchanged dependent cancels', () => {
		const scope = owner('hot-cancel-unchanged-dependent');
		const completion = deferred<number>();
		const a$ = __derivedScalarAt('g:a', () => 1);
		const c$ = __derivedScalarAt('g:c', () => 3);
		const affected = materialized(scope, [a$, c$]);
		const observed: SignalSnapshot<unknown>[][] = [];
		let cancelled!: AbortSignal;
		const b$ = __derivedAt('g:b', ({ signal }) => {
			a$.get();
			cancelled = signal;
			signal.addEventListener(
				'abort',
				() => {
					observed.push(affected.map((cell) => cell.snapshot()));
				},
				{ once: true },
			);
			return completion.promise;
		});
		const [dependent] = materialized(scope, [b$]);
		expect(affected[0].get()).toBe(1);
		expect(affected[1].get()).toBe(3);
		expect(dependent.snapshot().status).toBe('pending');

		const finish = scope.prepareHotDeclarations(affected, 'module:next');
		expect(cancelled.aborted).toBe(false);
		finish();

		expect(cancelled.aborted).toBe(true);
		expect(observed.map((snapshots) => snapshots.map((snapshot) => snapshot.status))).toEqual([
			['pending', 'pending'],
		]);
		expect(dependent.snapshot().status).toBe('pending');
	});

	it('cancels every detached producer when the first cancellation retires its owner', async () => {
		const scope = owner('hot-cancel-retiring-owner');
		const sibling = owner('hot-cancel-sibling');
		const sibling$ = sibling.signal$('value', 41);
		const first = deferred<string>();
		const second = deferred<string>();
		const queryStream = controlledStream<string>();
		const derivedStream = controlledStream<string>();
		const aborted: AbortSignal[] = [];
		const firstLoad = query('first', (_argument: undefined, { signal }) => {
			aborted.push(signal);
			signal.addEventListener('abort', () => scope.dispose(), { once: true });
			return first.promise;
		});
		const secondLoad = query('second', (_argument: undefined, { signal }) => {
			aborted.push(signal);
			return second.promise;
		});
		const streamLoad = query(
			'stream',
			(_argument: undefined, { signal }) => {
				aborted.push(signal);
				return queryStream.iterable;
			},
			{ kind: 'stream' },
		);
		const first$ = createResource(scope, 'first', () => firstLoad(undefined));
		const second$ = createResource(scope, 'second', () => secondLoad(undefined));
		const stream$ = createResource(scope, 'stream', () => streamLoad(undefined));
		const derived$ = __derivedAt('g:derived-stream', ({ signal }) => {
			aborted.push(signal);
			return derivedStream.iterable;
		});
		const cells = materialized(scope, [first$, second$, stream$, derived$]);
		for (const cell of cells) expect(cell.snapshot().status).toBe('pending');
		await Promise.all([queryStream.started, derivedStream.started]);
		expect(aborted.map((signal) => signal.aborted)).toEqual([false, false, false, false]);

		const finish = scope.prepareHotDeclarations(cells, 'module:next');
		expect(() => finish()).toThrow();
		await drainProducers();

		expect(scope.retired).toBe(true);
		expect(aborted.map((signal) => signal.aborted)).toEqual([true, true, true, true]);
		expect(queryStream.cancellations).toBe(1);
		expect(derivedStream.cancellations).toBe(1);
		expect(() => second$.get()).toThrow(ScopeDisposedError);
		expect(sibling$.get()).toBe(41);
	});

	it('keeps replacement work usable when an obsolete iterator throws during cleanup', async () => {
		const scope = owner('hot-cancel-throwing-close');
		const closeFailure = new Error('obsolete iterator close failed');
		const firstStream = controlledStream<string>({
			onReturn: () => {
				throw closeFailure;
			},
		});
		const derivedStream = controlledStream<string>();
		const replacementStream = controlledStream<string>();
		const completion = deferred<string>();
		const aborted: AbortSignal[] = [];
		const first$ = __queryAt(
			'g:first-stream',
			() => 'same',
			(_selection, { signal }) => {
				aborted.push(signal);
				return firstStream.iterable;
			},
			{ kind: 'stream' },
		);
		const second$ = __queryAt(
			'g:second-query',
			() => 'same',
			(_selection, { signal }) => {
				aborted.push(signal);
				return completion.promise;
			},
		);
		const derived$ = __derivedAt('g:derived-stream', ({ signal }) => {
			aborted.push(signal);
			return derivedStream.iterable;
		});
		const cells = materialized(scope, [first$, second$, derived$]);
		for (const cell of cells) expect(cell.snapshot().status).toBe('pending');
		await Promise.all([firstStream.started, derivedStream.started]);

		const finish = scope.prepareHotDeclarations(cells, 'module:next');
		expect(() => finish()).not.toThrow();
		expect(aborted.map((signal) => signal.aborted)).toEqual([true, true, true]);
		expect(firstStream.cancellations).toBe(1);
		expect(derivedStream.cancellations).toBe(1);
		for (const cell of cells) expect(cell.snapshot().status).toBe('pending');

		const replacement$ = __queryAt(
			'g:first-stream',
			() => 'same',
			() => replacementStream.iterable,
			{ kind: 'stream' },
		);
		const replacement = scope.rebindHotDeclaration('g:first-stream', 'module:next', () =>
			resolveSignalHandleForScope(replacement$, scope),
		);
		expect(replacement.snapshot().status).toBe('pending');
		const ready = nextSnapshot$(replacement, (snapshot) => snapshot.status === 'ready');
		replacementStream.emit('current');
		await ready;
		expect(replacement.get()).toBe('current');

		firstStream.emit('obsolete');
		completion.resolve('obsolete');
		await drainProducers();
		expect(cells[0].get()).toBe('current');
		expect(cells[1].snapshot().status).toBe('pending');
	});
});
