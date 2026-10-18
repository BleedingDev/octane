import { afterEach, describe, expect, it } from 'vitest';
import {
	acceptStreamedSignalResult,
	attachStreamedSignalResult,
	bindStreamedSignalSelection,
	createResource,
	createScope,
	failStreamedSignalResult,
	query,
	type Scope,
} from 'octane/signals';
import { ScopeImpl } from '../src/signals/engine.js';
import { scopeStreams } from '../src/signals/scope-streams.js';
import type { StreamFrameIdentity } from '../src/streamed-signals-protocol.js';

const owners: Scope[] = [];

afterEach(() => {
	for (const scope of owners.splice(0)) scope.dispose();
});

function identity(scope: Scope, nodeKey: string, queryKey: string): StreamFrameIdentity {
	return {
		protocol: 1,
		buildId: 'mailbox-build',
		documentId: 'mailbox-document',
		ownerKey: scope.scopeKey,
		instanceKey: 'mailbox-instance',
		nodeKey,
		selectionKey: JSON.stringify([queryKey, ['string', 'selected']]),
		selectionGeneration: 1,
		attempt: 1,
	};
}

function deliver(scope: Scope, selection: StreamFrameIdentity, value: string): void {
	expect(
		acceptStreamedSignalResult(scope, {
			identity: selection,
			sequence: 0,
			channel: 'result',
			kind: 'open',
			resource: 'promise',
		}),
	).toBe(true);
	expect(
		acceptStreamedSignalResult(scope, {
			identity: selection,
			sequence: 1,
			channel: 'result',
			kind: 'value',
			value: ['string', value],
		}),
	).toBe(true);
	expect(
		acceptStreamedSignalResult(scope, {
			identity: selection,
			sequence: 2,
			channel: 'result',
			kind: 'complete',
		}),
	).toBe(true);
}

describe('hot query stream ownership', () => {
	it.each(['value', 'failure'] as const)(
		'retires an early %s channel without discarding its sibling result',
		(buffered) => {
			const scope = createScope({ scopeKey: `hot-mailbox-${buffered}` });
			owners.push(scope);
			if (!(scope instanceof ScopeImpl)) throw new Error('Expected a native signal scope.');
			const target = identity(scope, 'target', 'hot-mailbox-target');
			const sibling = identity(scope, 'sibling', 'hot-mailbox-sibling');
			let targetAttached = false;
			let obsoleteIngressResumed = false;
			let siblingAttached = false;
			let siblingIngressResumed = false;
			const detachTarget = attachStreamedSignalResult(
				{
					attachResult() {
						if (targetAttached) obsoleteIngressResumed = true;
						targetAttached = true;
						return () => {};
					},
				},
				scope,
				target,
			);
			const detachSibling = attachStreamedSignalResult(
				{
					attachResult() {
						if (siblingAttached) siblingIngressResumed = true;
						siblingAttached = true;
						return () => {};
					},
				},
				scope,
				sibling,
			);
			try {
				if (buffered === 'value') deliver(scope, target, 'obsolete target');
				else expect(failStreamedSignalResult(scope, target, 'timeout')).toBe(true);
				deliver(scope, sibling, 'server sibling');

				scopeStreams(scope).retireSelection(target.nodeKey);

				expect(
					acceptStreamedSignalResult(scope, {
						identity: target,
						sequence: 3,
						channel: 'result',
						kind: 'complete',
					}),
				).toBe(false);
				expect(failStreamedSignalResult(scope, target, 'timeout')).toBe(false);

				// Even reinstalling the same wire identity cannot revive buffered
				// data or the old receiver's readiness subscription.
				expect(bindStreamedSignalSelection(scope, target)).toBe(true);
				const loadTarget = query('hot-mailbox-target', () => Promise.resolve('local target'));
				const loadSibling = query('hot-mailbox-sibling', () => Promise.resolve('local sibling'));
				const target$ = createResource(scope, target.nodeKey, () => loadTarget('selected'));
				const sibling$ = createResource(scope, sibling.nodeKey, () => loadSibling('selected'));

				expect(target$.snapshot().status).toBe('pending');
				expect(obsoleteIngressResumed).toBe(false);
				expect(siblingIngressResumed).toBe(true);
				expect(sibling$.get()).toBe('server sibling');

				deliver(scope, target, 'current target');
				expect(target$.get()).toBe('current target');
				expect(sibling$.get()).toBe('server sibling');
			} finally {
				detachTarget();
				detachSibling();
			}
		},
	);
});
