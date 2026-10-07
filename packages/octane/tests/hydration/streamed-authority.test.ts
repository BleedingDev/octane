import { describe, expect, it, vi } from 'vitest';
import {
	bootstrapStreamedSignalHydration,
	bootstrapStreamedSignalResults,
} from '../../src/hydration/streamed-signals.js';
import { createStreamedSignalResultFrames } from 'octane/server';
import {
	__queryAt,
	currentSignalOwner,
	retireSignalOwnerIdentity,
	runWithSignalOwner,
} from 'octane/signals';
import { childSlot, createRoot, enableSignalBindings, type Scope } from '../../src/runtime.js';
import type {
	StreamFrameIdentity,
	StreamedRendererFrame,
} from '../../src/streamed-signals-protocol.js';

function authority(buildId: string, documentId = 'shared-document') {
	const owner = { scopeKey: 'same-compiled-owner' };
	const identity: StreamFrameIdentity = {
		protocol: 1,
		buildId,
		documentId,
		ownerKey: owner.scopeKey,
		instanceKey: JSON.stringify([buildId, 'root']),
		nodeKey: 'g:shared-compiled-query',
		selectionKey: JSON.stringify(['g:shared-compiled-query', ['string', 'record']]),
		selectionGeneration: 1,
		attempt: 1,
	};
	return { owner, identity };
}

async function frames(identity: StreamFrameIdentity, value: string) {
	const output: StreamedRendererFrame[] = [];
	for await (const frame of createStreamedSignalResultFrames(identity, value)) output.push(frame);
	return output;
}

function target(identities: StreamFrameIdentity[] = [], buffered: StreamedRendererFrame[] = []) {
	return {
		__octaneStreamedSignalSelections: {
			version: 1 as const,
			identities,
			register(_identity: unknown) {},
		},
		__octaneStreamedRenderer: {
			version: 1 as const,
			frames: buffered,
			receive(_frame: unknown) {},
		},
	};
}

describe('independent streamed signal authorities', () => {
	it('rejects a replaced early mailbox while a publisher lease is live', async () => {
		const first = authority('closed-before-replacement');
		const second = authority('active-before-replacement');
		const third = authority('attempted-replacement');
		const realm = target(
			[first.identity, second.identity],
			[
				...(await frames(first.identity, 'first native result')),
				...(await frames(second.identity, 'retained native result')),
			],
		);
		const mailbox = realm.__octaneStreamedSignalSelections;
		const one = bootstrapStreamedSignalResults({
			buildId: first.identity.buildId,
			documentId: first.identity.documentId,
			signalOwner: first.owner,
			target: realm,
		});
		const two = bootstrapStreamedSignalResults({
			buildId: second.identity.buildId,
			documentId: second.identity.documentId,
			signalOwner: second.owner,
			target: realm,
		});
		let replacement: ReturnType<typeof bootstrapStreamedSignalResults> | undefined;
		const value = __queryAt(
			'g:shared-compiled-query',
			() => 'record',
			() => Promise.resolve('browser value'),
		);
		try {
			one.dispose();
			realm.__octaneStreamedSignalSelections = target().__octaneStreamedSignalSelections;
			expect(() => {
				replacement = bootstrapStreamedSignalResults({
					buildId: third.identity.buildId,
					documentId: third.identity.documentId,
					signalOwner: third.owner,
					target: realm,
				});
			}).toThrow(/already installed/);
			realm.__octaneStreamedSignalSelections = mailbox;
			expect(runWithSignalOwner(second.owner, () => value.get())).toBe('retained native result');
		} finally {
			realm.__octaneStreamedSignalSelections = mailbox;
			one.dispose();
			two.dispose();
			replacement?.dispose();
			retireSignalOwnerIdentity(first.owner);
			retireSignalOwnerIdentity(second.owner);
			retireSignalOwnerIdentity(third.owner);
		}
	});

	it('retains unclaimed foreign selections after the final claimed publisher closes', async () => {
		const first = authority('closed-claimed-publisher');
		const second = authority('unclaimed-foreign-publisher');
		const realm = target(
			[first.identity, second.identity],
			await frames(first.identity, 'first native result'),
		);
		const mailbox = realm.__octaneStreamedSignalSelections;
		const one = bootstrapStreamedSignalResults({
			buildId: first.identity.buildId,
			documentId: first.identity.documentId,
			signalOwner: first.owner,
			target: realm,
		});
		let two: ReturnType<typeof bootstrapStreamedSignalResults> | undefined;
		try {
			one.dispose();
			realm.__octaneStreamedSignalSelections = target().__octaneStreamedSignalSelections;
			expect(() => {
				two = bootstrapStreamedSignalResults({
					buildId: second.identity.buildId,
					documentId: second.identity.documentId,
					signalOwner: second.owner,
					target: realm,
				});
			}).toThrow(/already installed/);
			realm.__octaneStreamedSignalSelections = mailbox;
			realm.__octaneStreamedRenderer = target(
				[],
				await frames(second.identity, 'foreign native result'),
			).__octaneStreamedRenderer;
			two = bootstrapStreamedSignalResults({
				buildId: second.identity.buildId,
				documentId: second.identity.documentId,
				signalOwner: second.owner,
				target: realm,
			});
			const value = __queryAt(
				'g:shared-compiled-query',
				() => 'record',
				() => Promise.resolve('browser value'),
			);
			expect(runWithSignalOwner(second.owner, () => value.get())).toBe('foreign native result');
		} finally {
			realm.__octaneStreamedSignalSelections = mailbox;
			one.dispose();
			two?.dispose();
			retireSignalOwnerIdentity(first.owner);
			retireSignalOwnerIdentity(second.owner);
		}
	});

	it('retains an unclaimed publisher snapshot and joins both results before browser loaders start', async () => {
		const first = authority('first-publisher');
		const second = authority('second-publisher');
		const realm = target(
			[first.identity, second.identity],
			[
				...(await frames(first.identity, 'first server value')),
				...(await frames(second.identity, 'second server value')),
			],
		);
		const load = vi.fn(() => Promise.resolve('browser value'));
		const value = __queryAt('g:shared-compiled-query', () => 'record', load);
		const one = bootstrapStreamedSignalHydration({
			buildId: first.identity.buildId,
			documentId: first.identity.documentId,
			signalOwner: first.owner,
			target: realm,
		});
		let two: ReturnType<typeof bootstrapStreamedSignalResults> | undefined;
		try {
			expect(runWithSignalOwner(first.owner, () => value.get())).toBe('first server value');
			two = bootstrapStreamedSignalResults({
				buildId: second.identity.buildId,
				documentId: second.identity.documentId,
				signalOwner: second.owner,
				target: realm,
			});
			expect(runWithSignalOwner(second.owner, () => value.get())).toBe('second server value');
			expect(runWithSignalOwner(first.owner, () => value.get())).toBe('first server value');
			expect(load).not.toHaveBeenCalled();
		} finally {
			one.dispose();
			two?.dispose();
			retireSignalOwnerIdentity(first.owner);
			retireSignalOwnerIdentity(second.owner);
		}
	});

	it('joins a publisher whose selection and result arrive after the host starts', async () => {
		const first = authority('early-host');
		const second = authority('late-remote');
		const realm = target();
		const one = bootstrapStreamedSignalResults({
			buildId: first.identity.buildId,
			documentId: first.identity.documentId,
			signalOwner: first.owner,
			target: realm,
		});
		let two: ReturnType<typeof bootstrapStreamedSignalResults> | undefined;
		const load = vi.fn(() => Promise.resolve('browser value'));
		const value = __queryAt('g:shared-compiled-query', () => 'record', load);
		try {
			realm.__octaneStreamedSignalSelections.register(second.identity);
			for (const frame of await frames(second.identity, 'late server value'))
				realm.__octaneStreamedRenderer.receive(frame);
			two = bootstrapStreamedSignalResults({
				buildId: second.identity.buildId,
				documentId: second.identity.documentId,
				signalOwner: second.owner,
				target: realm,
			});
			expect(runWithSignalOwner(second.owner, () => value.get())).toBe('late server value');
			expect(load).not.toHaveBeenCalled();
		} finally {
			one.dispose();
			two?.dispose();
			retireSignalOwnerIdentity(first.owner);
			retireSignalOwnerIdentity(second.owner);
		}
	});

	it('activates the surviving component owner after another publisher unmounts', async () => {
		enableSignalBindings();
		const publishers = [authority('first-component'), authority('second-component')];
		for (const publisher of publishers) {
			publisher.identity = {
				...publisher.identity,
				nodeKey: 'i:shared-compiled-query',
				selectionKey: JSON.stringify(['i:shared-compiled-query', ['string', 'record']]),
			};
		}
		const realm = target();
		const bridges = publishers.map(({ identity, owner }) =>
			bootstrapStreamedSignalResults({
				buildId: identity.buildId,
				documentId: identity.documentId,
				signalOwner: owner,
				target: realm,
			}),
		);
		const containers = publishers.map(() => document.createElement('div'));
		document.body.append(...containers);
		const roots = publishers.map(({ identity, owner }, index) =>
			createRoot(containers[index], { identifierPrefix: identity.buildId, signalOwner: owner }),
		);
		const value = __queryAt(
			'i:shared-compiled-query',
			() => 'record',
			() => new Promise<string>(() => {}),
		);
		const Body = (props: { index: number }, scope: Scope) => {
			const owner = currentSignalOwner();
			if (owner === null || !('instanceKey' in owner))
				throw new Error('A native component signal owner is required');
			publishers[props.index].identity = {
				...publishers[props.index].identity,
				instanceKey: owner.instanceKey,
			};
			return childSlot(scope, 0, scope.block.parentNode, value);
		};
		const deliver = async (index: number, result: string) => {
			const identity = publishers[index].identity;
			realm.__octaneStreamedSignalSelections.register(identity);
			for (const frame of await frames(identity, result))
				realm.__octaneStreamedRenderer.receive(frame);
			await vi.waitFor(() => expect(containers[index].textContent).toBe(result));
		};
		try {
			roots[0].render(Body, { index: 0 });
			await deliver(0, 'first component value');
			roots[0].unmount();
			bridges[0].dispose();
			roots[1].render(Body, { index: 1 });
			await deliver(1, 'second component value');
		} finally {
			for (const root of roots) root.unmount();
			for (const bridge of bridges) bridge.dispose();
			for (const { owner } of publishers) retireSignalOwnerIdentity(owner);
			for (const container of containers) container.remove();
		}
	});

	it.each([
		{ close: 'dispose', closing: 0 },
		{ close: 'dispose', closing: 1 },
		{ close: 'suspend', closing: 0 },
		{ close: 'suspend', closing: 1 },
	] as const)(
		'keeps the other publisher receiving when publisher $closing calls $close',
		async ({ close, closing }) => {
			const first = authority('closing-publisher');
			const second = authority('surviving-publisher', 'another-document');
			const realm = target([first.identity, second.identity]);
			const one = bootstrapStreamedSignalResults({
				buildId: first.identity.buildId,
				documentId: first.identity.documentId,
				signalOwner: first.owner,
				target: realm,
			});
			const two = bootstrapStreamedSignalResults({
				buildId: second.identity.buildId,
				documentId: second.identity.documentId,
				signalOwner: second.owner,
				target: realm,
			});
			const load = vi.fn(() => new Promise<string>(() => {}));
			const value = __queryAt('g:shared-compiled-query', () => 'record', load);
			try {
				const surviving = closing === 0 ? second : first;
				[one, two][closing][close]();
				for (const frame of await frames(surviving.identity, 'surviving server value'))
					realm.__octaneStreamedRenderer.receive(frame);
				await vi.waitFor(() =>
					expect(runWithSignalOwner(surviving.owner, () => value.get())).toBe(
						'surviving server value',
					),
				);
				expect(load).not.toHaveBeenCalled();
			} finally {
				one.dispose();
				two.dispose();
				retireSignalOwnerIdentity(first.owner);
				retireSignalOwnerIdentity(second.owner);
			}
		},
	);

	it('rejects a duplicate authority before changing the original publisher state', async () => {
		const first = authority('unique-publisher');
		const realm = target([first.identity], await frames(first.identity, 'accepted server value'));
		const one = bootstrapStreamedSignalResults({
			buildId: first.identity.buildId,
			documentId: first.identity.documentId,
			signalOwner: first.owner,
			target: realm,
		});
		const impostor = { scopeKey: first.owner.scopeKey };
		const value = __queryAt(
			'g:shared-compiled-query',
			() => 'record',
			() => Promise.resolve('browser value'),
		);
		try {
			expect(() =>
				bootstrapStreamedSignalResults({
					buildId: first.identity.buildId,
					documentId: first.identity.documentId,
					signalOwner: impostor,
					target: realm,
				}),
			).toThrow(/already installed/);
			expect(runWithSignalOwner(first.owner, () => value.get())).toBe('accepted server value');
		} finally {
			one.dispose();
			retireSignalOwnerIdentity(first.owner);
			retireSignalOwnerIdentity(impostor);
		}
	});

	it.each(['selections', 'frames'] as const)(
		'bounds unclaimed %s while the active publisher continues receiving',
		async (channel) => {
			const active = authority('active-publisher');
			const waiting = authority('unclaimed-publisher');
			const realm = target([active.identity]);
			const bridge = bootstrapStreamedSignalResults({
				buildId: active.identity.buildId,
				documentId: active.identity.documentId,
				signalOwner: active.owner,
				target: realm,
			});
			const load = vi.fn(() => Promise.resolve('browser value'));
			const value = __queryAt('g:shared-compiled-query', () => 'record', load);
			try {
				if (channel === 'selections') {
					for (let index = 0; index < 256; index++)
						realm.__octaneStreamedSignalSelections.register({
							...waiting.identity,
							instanceKey: String(index),
						});
					expect(() => realm.__octaneStreamedSignalSelections.register(waiting.identity)).toThrow(
						/overflow/,
					);
				} else {
					realm.__octaneStreamedSignalSelections.register(waiting.identity);
					const open = (await frames(waiting.identity, 'waiting value'))[0];
					for (let index = 0; index < 513; index++) realm.__octaneStreamedRenderer.receive(open);
				}
				expect(() =>
					bootstrapStreamedSignalResults({
						buildId: waiting.identity.buildId,
						documentId: waiting.identity.documentId,
						signalOwner: waiting.owner,
						target: realm,
					}),
				).toThrow(/overflow/);
				for (const frame of await frames(active.identity, 'active server value'))
					realm.__octaneStreamedRenderer.receive(frame);
				await vi.waitFor(() =>
					expect(runWithSignalOwner(active.owner, () => value.get())).toBe('active server value'),
				);
				expect(load).not.toHaveBeenCalled();
			} finally {
				bridge.dispose();
				retireSignalOwnerIdentity(active.owner);
				retireSignalOwnerIdentity(waiting.owner);
			}
		},
	);
});
