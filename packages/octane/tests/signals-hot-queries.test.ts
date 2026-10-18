import { afterEach, describe, expect, it } from 'vitest';
import { createResource, createScope, query, type QueryRequest, type Scope } from 'octane/signals';
import { createResourceCellWith } from '../src/signals/engine.js';
import { initializeResource, type ResourceBinding } from '../src/signals/requests.js';
import { deferred, drainProducers } from './_fixtures/signals-async-controls';

const scopes: Scope[] = [];
const cleanups: (() => void)[] = [];

function owner(key: string): Scope {
	const scope = createScope({ scopeKey: key });
	scopes.push(scope);
	return scope;
}

function replaceableResource(
	scope: Scope,
	key: string,
	describeRequest: () => QueryRequest<string>,
	generation?: string,
) {
	let binding!: ResourceBinding<string>;
	let replace!: (describeRequest: () => QueryRequest<string>, generation: string) => void;
	const value$ = createResourceCellWith<string>(
		scope,
		key,
		describeRequest,
		(owner, node, describe, seed, retained) => {
			binding = initializeResource(owner, node, describe, seed, retained, generation);
			replace = (nextDescribe, nextGeneration) => {
				binding.dispose();
				binding = initializeResource(
					owner,
					node,
					nextDescribe,
					undefined,
					undefined,
					nextGeneration,
				);
				value$.retry();
			};
			return binding;
		},
	);
	const dispose = () => binding.dispose();
	cleanups.push(dispose);
	return {
		value$,
		replace(describeRequest: () => QueryRequest<string>, generation: string) {
			replace(describeRequest, generation);
		},
		dispose,
	};
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const scope of scopes.splice(0)) scope.dispose();
});

describe('query definition generations', () => {
	it('keeps a sibling on its shared request while a replacement uses its new loader', async () => {
		const scope = owner('hot-query-shared-request');
		const previous = deferred<string>();
		const replacement = deferred<string>();
		const previousSignals: AbortSignal[] = [];
		const oldLoad = query('feed', (_argument: string, { signal }) => {
			previousSignals.push(signal);
			return previous.promise;
		});
		const newLoad = query('feed', () => replacement.promise);
		const target = replaceableResource(scope, 'target', () => oldLoad('same'));
		const sibling$ = createResource(scope, 'sibling', () => oldLoad('same'));
		expect(target.value$.snapshot().status).toBe('pending');
		expect(sibling$.snapshot().status).toBe('pending');

		target.replace(() => newLoad('same'), 'module:next');
		expect(previousSignals[0]?.aborted).toBe(false);
		expect(previousSignals.some((signal) => signal.aborted)).toBe(false);
		previous.resolve('old sibling');
		await drainProducers();
		expect(sibling$.get()).toBe('old sibling');
		expect(target.value$.snapshot().status).toBe('pending');

		replacement.resolve('new target');
		await drainProducers();
		expect(target.value$.get()).toBe('new target');
		expect(sibling$.get()).toBe('old sibling');
		expect(sibling$.snapshot().requestKey).toEqual(expect.any(String));
		expect(target.value$.snapshot().requestKey).toBe(sibling$.snapshot().requestKey);
	});

	it('cancels the replaced sole consumer and ignores its later completion', async () => {
		const scope = owner('hot-query-replaced-attempt');
		const previous = deferred<string>();
		const replacement = deferred<string>();
		let previousSignal!: AbortSignal;
		const oldLoad = query('feed', (_argument: string, { signal }) => {
			previousSignal = signal;
			return previous.promise;
		});
		const newLoad = query('feed', () => replacement.promise);
		const target = replaceableResource(scope, 'target', () => oldLoad('same'), 'module:first');
		expect(target.value$.snapshot().status).toBe('pending');

		target.replace(() => newLoad('same'), 'module:next');
		expect(previousSignal.aborted).toBe(true);
		previous.resolve('obsolete');
		await drainProducers();
		expect(target.value$.snapshot().status).toBe('pending');
		replacement.resolve('accepted');
		await drainProducers();
		expect(target.value$.get()).toBe('accepted');
	});

	it('shares matching generation work until its last consumer leaves', async () => {
		const scope = owner('hot-query-generation-lifetime');
		const completion = deferred<string>();
		const signals: AbortSignal[] = [];
		const load = query('feed', (_argument: string, context) => {
			signals.push(context.signal);
			return completion.promise;
		});
		const first = replaceableResource(scope, 'first', () => load('same'), 'module:first');
		const second = replaceableResource(scope, 'second', () => load('same'), 'module:first');
		expect(first.value$.snapshot().status).toBe('pending');
		expect(second.value$.snapshot().status).toBe('pending');
		first.dispose();
		expect(signals[0]?.aborted).toBe(false);
		expect(signals.some((signal) => signal.aborted)).toBe(false);
		second.dispose();
		expect(signals.every((signal) => signal.aborted)).toBe(true);

		const freshLoad = query('feed', () => 'fresh');
		const fresh = replaceableResource(scope, 'fresh', () => freshLoad('same'), 'module:first');
		completion.resolve('obsolete');
		await drainProducers();
		expect(fresh.value$.get()).toBe('fresh');
	});

	it('evicts an abandoned request while another request keeps its generation live', async () => {
		const scope = owner('hot-query-generation-eviction');
		const abandoned = deferred<string>();
		const surviving = deferred<string>();
		const fresh = deferred<string>();
		let first = true;
		let abandonedSignal!: AbortSignal;
		const load = query('feed', (argument: string, { signal }) => {
			if (argument === 'surviving') return surviving.promise;
			if (!first) return fresh.promise;
			first = false;
			abandonedSignal = signal;
			return abandoned.promise;
		});
		const removed = replaceableResource(scope, 'removed', () => load('same'), 'module:first');
		const sibling = replaceableResource(scope, 'sibling', () => load('surviving'), 'module:first');
		removed.dispose();
		expect(abandonedSignal.aborted).toBe(true);
		const replacement = replaceableResource(
			scope,
			'replacement',
			() => load('same'),
			'module:first',
		);
		abandoned.resolve('obsolete');
		surviving.resolve('surviving');
		fresh.resolve('fresh');
		await drainProducers();
		expect(replacement.value$.get()).toBe('fresh');
		expect(sibling.value$.get()).toBe('surviving');
	});

	it.each([undefined, 'module:first'])(
		'rejects conflicting loaders within definition generation %s',
		async (generation) => {
			const scope = owner('hot-query-generation-conflict');
			const original = query('feed', () => 'original');
			const conflicting = query('feed', () => 'conflicting');
			const first = replaceableResource(scope, 'first', () => original('same'), generation);
			const second = replaceableResource(scope, 'second', () => conflicting('same'), generation);
			await drainProducers();
			expect(first.value$.get()).toBe('original');
			expect(() => second.value$.get()).toThrow(/[Ii]ncompatible query/);
		},
	);
});
