import { afterEach, describe, expect, it } from 'vitest';
import {
	__derivedAt,
	__derivedScalarAt,
	__hotSignalModule,
	__queryAt,
	__registerHotSignalComponent,
	__remountHotSignalComponent,
	__signalAt,
	createScope,
	runWithSignalOwner,
	type Scope,
} from 'octane/signals';
import {
	admitHotSignalPublisher,
	createNativeHotSignalOwnerProof,
	getNativeHotSignalComponentBuild,
	type HotSignalDeclarationShape,
	type HotSignalExecutionFrame,
	type HotSignalModuleManifest,
	type HotSignalRuntime,
} from '../src/signals/hot-declarations.js';
import { createSignalOwnerLifecycle } from '../src/signals/facade.js';
import { deferred, drainProducers } from './_fixtures/signals-async-controls';

const executionKey = Symbol.for('octane.hot-signals.execution');
const bridgeKey = Symbol.for('octane.hot-signals.bridge');
const globals = globalThis as Record<symbol, any>;
const owned: Scope[] = [];
const scopes = (key: string) => {
	const scope = createScope({ scopeKey: key });
	owned.push(scope);
	return scope;
};

afterEach(() => {
	delete globals[executionKey];
	for (const scope of owned.splice(0)) scope.dispose();
});

function manifest(
	generation: string,
	declarations: HotSignalDeclarationShape[],
	hookSlots: string[] = [],
): HotSignalModuleManifest {
	return { version: 1, moduleId: '/remote/Widget.tsrx', generation, declarations, hookSlots };
}

function harness(initial: HotSignalModuleManifest) {
	let owner: Scope | undefined = scopes('remote');
	const host$ = scopes('host$');
	const sibling$ = scopes('sibling$');
	const component = () => {};
	const runtime: HotSignalRuntime = {
		modules: new Map([['widget', [initial]]]),
		features: new Set(['widget']),
		executed: new Set(['widget']),
		buildId: 'build:1',
		generationChanged: false,
	};
	let remounts = 0;
	let suspensions = 0;
	let rotations = 0;
	const frame = (next: HotSignalModuleManifest, hot: boolean): HotSignalExecutionFrame => ({
		runtime,
		executableId: 'widget',
		buildId: runtime.buildId,
		manifests: [next],
		hot,
		requiresAdmission: true,
	});
	function execute(
		next: HotSignalModuleManifest,
		hot: boolean,
		body: (stamp: ReturnType<typeof __hotSignalModule>) => void,
	) {
		const execution = frame(next, hot);
		globals[executionKey] = execution;
		try {
			if (hot) execution.transaction = globals[bridgeKey].beforeFactory(execution);
			const stamp = __hotSignalModule(next);
			body(stamp);
			__registerHotSignalComponent(stamp, component);
			globals[bridgeKey].afterFactory(execution);
			return stamp;
		} catch (error) {
			globals[bridgeKey]?.abortFactory(execution);
			throw error;
		} finally {
			delete globals[executionKey];
		}
	}
	return {
		runtime,
		host$,
		sibling$,
		component,
		execute,
		get owner() {
			return owner!;
		},
		get remounts() {
			return remounts;
		},
		get suspensions() {
			return suspensions;
		},
		get rotations() {
			return rotations;
		},
		admit() {
			const proof = createNativeHotSignalOwnerProof({
				publisherKey: 'remote/widget',
				documentId: 'document',
				ownerKey: 'remote',
				buildId: runtime.buildId,
				currentOwner: () => owner,
				acceptsComponent: (candidate) => candidate === component,
				suspendIngress() {
					suspensions++;
				},
				rotateIngress() {
					rotations++;
				},
				remount() {
					owner?.dispose();
					owner = scopes('remote');
					remounts++;
				},
			});
			return admitHotSignalPublisher(component, proof);
		},
		update(
			next: HotSignalModuleManifest,
			body: (stamp: ReturnType<typeof __hotSignalModule>) => void,
		) {
			runtime.buildId = `build:${Number(runtime.buildId.split(':')[1]) + 1}`;
			runtime.modules.set('widget', [next]);
			return execute(next, true, body);
		},
	};
}

const countShape: HotSignalDeclarationShape = {
	site: 'g:count$',
	key: 'g:count$',
	scope: 'document',
	kind: 'signal',
	factory: '__signalAt',
};
const derivedShape: HotSignalDeclarationShape = {
	site: 'g:label$',
	key: 'g:label$',
	scope: 'document',
	kind: 'derived',
	factory: '__derivedScalarAt',
};
const queryShape: HotSignalDeclarationShape = {
	site: 'g:feed$',
	key: 'g:feed$',
	scope: 'document',
	kind: 'async',
	factory: '__queryAt',
	queryKind: 'promise',
};

describe('native hot signal generations', () => {
	it('revokes an aborted factory and restores canonical metadata for a corrected registry generation', () => {
		const initial = manifest('source:1', [countShape]);
		const h = harness(initial);
		h.execute(initial, false, (stamp) => {
			__signalAt('g:count$', 1, undefined, stamp);
		});
		h.admit();
		const originalBody = () => {};
		const metadata = {
			fn: originalBody,
			update(body: () => void) {
				this.fn = body;
				return true;
			},
		};
		Object.defineProperty(h.component, Symbol.for('octane.hmr'), { value: metadata });
		let leaked$!: ReturnType<typeof __signalAt<number>>;
		expect(() =>
			h.update(manifest('source:2', [countShape]), (stamp) => {
				leaked$ = __signalAt('g:count$', 2, undefined, stamp);
				metadata.update(() => {});
				__registerHotSignalComponent(stamp, h.component);
				throw new Error('authored failure');
			}),
		).toThrow('authored failure');
		expect(metadata.fn).toBe(originalBody);
		expect(getNativeHotSignalComponentBuild(h.component)).toBe('build:1');
		expect(() => runWithSignalOwner(h.owner, () => leaked$.get())).toThrow();
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(false);
		let corrected$!: ReturnType<typeof __signalAt<number>>;
		h.update(manifest('source:3', [countShape]), (stamp) => {
			corrected$ = __signalAt('g:count$', 3, undefined, stamp);
		});
		runWithSignalOwner(h.owner, () => expect(corrected$.get()).toBe(3));
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(true);
	});

	it('resets a shared native boundary once when two proofs admit its factory', () => {
		const initial = manifest('source:1', [countShape]);
		const h = harness(initial);
		const child = () => {};
		h.execute(initial, false, (stamp) => {
			const count$ = __signalAt('g:count$', 1, undefined, stamp);
			runWithSignalOwner(h.owner, () => count$.set(7));
			__registerHotSignalComponent(stamp, child);
		});
		h.admit();
		const proof = createNativeHotSignalOwnerProof({
			publisherKey: 'remote/child',
			documentId: 'document',
			ownerKey: h.owner.scopeKey,
			buildId: h.runtime.buildId,
			currentOwner: () => h.owner,
			acceptsComponent: (component) => component === child,
			suspendIngress() {},
			rotateIngress() {},
			remount() {
				throw new Error('duplicate native remount');
			},
		});
		admitHotSignalPublisher(child, proof);
		h.update(manifest('source:2', [countShape], ['changed-slot']), (stamp) => {
			__signalAt('g:count$', 1, undefined, stamp);
			__registerHotSignalComponent(stamp, child);
		});
		expect(h.remounts).toBe(1);
	});

	it('preserves writable cells and subscriptions while replacing only owned derived closures', () => {
		const initial = manifest('source:1', [countShape, derivedShape]);
		const h = harness(initial);
		let count$!: ReturnType<typeof __signalAt<number>>;
		let label$!: ReturnType<typeof __derivedScalarAt<number>>;
		h.execute(initial, false, (stamp) => {
			count$ = __signalAt('g:count$', 1, undefined, stamp);
			label$ = __derivedScalarAt('g:label$', () => count$.get() + 1, undefined, stamp);
		});
		const hostCount$ = h.host$.signal$('count$', 20);
		const siblingCount$ = h.sibling$.signal$('count$', 30);
		runWithSignalOwner(h.owner, () => {
			count$.set(7);
			expect(label$.get()).toBe(8);
		});
		h.admit();
		let notifications = 0;
		const stop = runWithSignalOwner(h.owner, () =>
			label$.subscribe(() => {
				notifications++;
			}),
		);
		h.update(manifest('source:2', [countShape, derivedShape]), (stamp) => {
			const freshCount = __signalAt('g:count$', 999, undefined, stamp);
			__derivedScalarAt('g:label$', () => freshCount.get() + 2, undefined, stamp);
		});
		runWithSignalOwner(h.owner, () => {
			expect(count$.get()).toBe(7);
			expect(label$.get()).toBe(9);
			count$.set(8);
			expect(label$.get()).toBe(10);
		});
		expect(notifications).toBeGreaterThan(0);
		expect(hostCount$.get()).toBe(20);
		expect(siblingCount$.get()).toBe(30);
		expect(h.remounts).toBe(0);
		expect(h.suspensions).toBe(1);
		expect(h.rotations).toBe(1);
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(true);
		h.update(manifest('source:3', [countShape, derivedShape]), (stamp) => {
			const freshCount$ = __signalAt('g:count$', 999, undefined, stamp);
			__derivedScalarAt('g:label$', () => freshCount$.get() + 3, undefined, stamp);
		});
		runWithSignalOwner(h.owner, () => {
			expect(count$.get()).toBe(8);
			expect(label$.get()).toBe(11);
		});
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(true);
		stop();
	});

	it('rebinds an instance recipe in its next native render after the factory finishes', () => {
		const shape: HotSignalDeclarationShape = {
			site: 'i:local',
			key: 'i:local',
			scope: 'instance',
			kind: 'derived',
			factory: '__derivedScalarAt',
		};
		const initial = manifest('source:1', [shape]);
		const h = harness(initial);
		let previous$!: ReturnType<typeof __derivedScalarAt<number>>;
		let fresh$!: ReturnType<typeof __derivedScalarAt<number>>;
		h.execute(initial, false, (stamp) => {
			previous$ = __derivedScalarAt('i:local', () => 1, undefined, stamp);
		});
		runWithSignalOwner(h.owner, () => expect(previous$.get()).toBe(1));
		h.admit();
		h.update(manifest('source:2', [shape]), (stamp) => {
			fresh$ = __derivedScalarAt('i:local', () => 2, undefined, stamp);
		});
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(true);
		runWithSignalOwner(h.owner, () => {
			expect(fresh$.get()).toBe(2);
			expect(previous$.get()).toBe(2);
		});
	});

	it('keeps the remaining owner admitted after another owner disposes following an update', () => {
		const initial = manifest('source:1', [countShape, derivedShape]);
		const h = harness(initial);
		const other = scopes('remote:second');
		let count$!: ReturnType<typeof __signalAt<number>>;
		let label$!: ReturnType<typeof __derivedScalarAt<number>>;
		h.execute(initial, false, (stamp) => {
			count$ = __signalAt('g:count$', 1, undefined, stamp);
			label$ = __derivedScalarAt('g:label$', () => count$.get() + 1, undefined, stamp);
		});
		runWithSignalOwner(h.owner, () => {
			count$.set(10);
			label$.get();
		});
		runWithSignalOwner(other, () => {
			count$.set(20);
			label$.get();
		});
		const releaseFirst = h.admit();
		const proof = createNativeHotSignalOwnerProof({
			publisherKey: 'remote/second',
			documentId: 'document',
			ownerKey: other.scopeKey,
			buildId: h.runtime.buildId,
			currentOwner: () => other,
			acceptsComponent: (component) => component === h.component,
			suspendIngress() {},
			rotateIngress() {},
			remount() {
				other.dispose();
			},
		});
		const releaseOther = admitHotSignalPublisher(h.component, proof);
		const replace = (version: number) =>
			h.update(manifest(`source:${version}`, [countShape, derivedShape]), (stamp) => {
				const freshCount$ = __signalAt('g:count$', 99, undefined, stamp);
				__derivedScalarAt('g:label$', () => freshCount$.get() + version, undefined, stamp);
			});
		replace(2);
		h.owner.dispose();
		releaseFirst();
		expect(globals[bridgeKey].allowStatus(h.runtime, 'check')).toBe(true);
		replace(3);
		runWithSignalOwner(other, () => {
			expect(count$.get()).toBe(20);
			expect(label$.get()).toBe(23);
		});
		other.dispose();
		releaseOther();
	});

	it('aborts old query work and preserves a sibling request and wire identity', async () => {
		const initial = manifest('source:1', [queryShape]);
		const h = harness(initial);
		const old = deferred<string>();
		const next = deferred<string>();
		let aborted!: AbortSignal;
		let feed$!: ReturnType<typeof __queryAt<string, string>>;
		h.execute(initial, false, (stamp) => {
			feed$ = __queryAt(
				'g:feed$',
				() => 'same',
				(_arg, { signal }) => {
					aborted = signal;
					return old.promise;
				},
				undefined,
				stamp,
			);
		});
		runWithSignalOwner(h.owner, () => expect(feed$.snapshot().status).toBe('pending'));
		const requestKey = runWithSignalOwner(h.owner, () => feed$.snapshot().requestKey);
		const siblingQuery$ = h.sibling$.derived$('query', () => 'sibling$');
		expect(siblingQuery$.get()).toBe('sibling$');
		h.admit();
		h.update(manifest('source:2', [queryShape]), (stamp) => {
			__queryAt(
				'g:feed$',
				() => 'same',
				() => next.promise,
				undefined,
				stamp,
			);
		});
		expect(aborted.aborted).toBe(true);
		expect(h.owner.inspect().activeRequests).toBe(1);
		old.resolve('obsolete');
		await drainProducers();
		runWithSignalOwner(h.owner, () => expect(feed$.snapshot().status).toBe('pending'));
		next.resolve('fresh');
		await drainProducers();
		runWithSignalOwner(h.owner, () => {
			expect(feed$.get()).toBe('fresh');
			expect(feed$.snapshot().requestKey).toBe(requestKey);
		});
		expect(siblingQuery$.get()).toBe('sibling$');
	});

	it('rebinds a query before its newly read derived dependency and keeps subscriptions live', async () => {
		const initial = manifest('source:1', [queryShape, derivedShape, countShape]);
		const h = harness(initial);
		let feed$!: ReturnType<typeof __queryAt<number, number>>;
		let label$!: ReturnType<typeof __derivedScalarAt<number>>;
		let count$!: ReturnType<typeof __signalAt<number>>;
		h.execute(initial, false, (stamp) => {
			count$ = __signalAt('g:count$', 3, undefined, stamp);
			label$ = __derivedScalarAt('g:label$', () => count$.get() + 1, undefined, stamp);
			feed$ = __queryAt(
				'g:feed$',
				() => 1,
				(argument) => argument * 2,
				undefined,
				stamp,
			);
		});
		// The query was read before the dependency its replacement will introduce.
		runWithSignalOwner(h.owner, () => {
			feed$.snapshot();
			expect(label$.get()).toBe(4);
		});
		await drainProducers();
		runWithSignalOwner(h.owner, () => expect(feed$.get()).toBe(2));
		h.admit();
		let notifications = 0;
		const stop = runWithSignalOwner(h.owner, () => feed$.subscribe(() => notifications++));
		const replacement = deferred<number>();
		h.update(manifest('source:2', [queryShape, derivedShape, countShape]), (stamp) => {
			const freshCount$ = __signalAt('g:count$', 99, undefined, stamp);
			const freshLabel$ = __derivedScalarAt(
				'g:label$',
				() => freshCount$.get() + 2,
				undefined,
				stamp,
			);
			__queryAt(
				'g:feed$',
				() => freshLabel$.get(),
				(argument) => (argument === 5 ? replacement.promise : argument * 2),
				undefined,
				stamp,
			);
		});
		runWithSignalOwner(h.owner, () => {
			expect(feed$.snapshot().status).toBe('pending');
			expect(feed$.latest()).toBe(2);
		});
		replacement.resolve(10);
		await drainProducers();
		runWithSignalOwner(h.owner, () => {
			expect(feed$.get()).toBe(10);
			expect(label$.get()).toBe(5);
			count$.set(4);
			feed$.snapshot();
		});
		await drainProducers();
		runWithSignalOwner(h.owner, () => expect(feed$.get()).toBe(12));
		expect(notifications).toBeGreaterThan(0);
		expect(h.remounts).toBe(0);
		stop();
	});

	it('freezes and resumes queries after their native definition generation changed', async () => {
		const initial = manifest('source:1', [queryShape]);
		const h = harness(initial);
		const first = deferred<string>();
		const resumed = deferred<string>();
		let current!: AbortSignal;
		let attempts = 0;
		let feed$!: ReturnType<typeof __queryAt<string, string>>;
		h.execute(initial, false, (stamp) => {
			feed$ = __queryAt(
				'g:feed$',
				() => 'same',
				() => 'old',
				undefined,
				stamp,
			);
		});
		runWithSignalOwner(h.owner, () => feed$.snapshot());
		await drainProducers();
		runWithSignalOwner(h.owner, () => expect(feed$.get()).toBe('old'));
		h.admit();
		h.update(manifest('source:2', [queryShape]), (stamp) => {
			__queryAt(
				'g:feed$',
				() => 'same',
				(_argument, { signal }) => {
					current = signal;
					return ++attempts === 1 ? first.promise : resumed.promise;
				},
				undefined,
				stamp,
			);
		});
		expect(h.owner.inspect().activeRequests).toBe(1);
		const lifetime = createSignalOwnerLifecycle(h.owner);
		lifetime.freeze();
		expect(current.aborted).toBe(true);
		expect(h.owner.inspect().activeRequests).toBe(0);
		first.resolve('obsolete');
		await drainProducers();
		lifetime.resume();
		expect(attempts).toBe(2);
		resumed.resolve('fresh');
		await drainProducers();
		runWithSignalOwner(h.owner, () => expect(feed$.get()).toBe('fresh'));
	});

	it('remounts only the admitted boundary when factory or slot shape changes', () => {
		const initial = manifest('source:1', [countShape, derivedShape], ['slot:1']);
		const h = harness(initial);
		const originalOwner = h.owner;
		h.execute(initial, false, (stamp) => {
			const count$ = __signalAt('g:count$', 1, undefined, stamp);
			const label$ = __derivedScalarAt('g:label$', () => count$.get(), undefined, stamp);
			runWithSignalOwner(h.owner, () => {
				count$.set(9);
				label$.get();
			});
		});
		const host$ = h.host$.signal$('host$', 7);
		const sibling$ = h.sibling$.signal$('sibling$', 8);
		h.admit();
		const nextShape = { ...derivedShape, factory: '__derivedAt' as const };
		let replacement$!: ReturnType<typeof __signalAt<number>>;
		h.update(manifest('source:2', [countShape, nextShape], ['slot:2']), (stamp) => {
			replacement$ = __signalAt('g:count$', 2, undefined, stamp);
			const label$ = __derivedAt('g:label$', () => replacement$.get() * 2, undefined, stamp);
			runWithSignalOwner(h.owner, () => expect(label$.get()).toBe(4));
		});
		expect(originalOwner.retired).toBe(true);
		expect(h.remounts).toBe(1);
		runWithSignalOwner(h.owner, () => expect(replacement$.get()).toBe(2));
		expect(host$.get()).toBe(7);
		expect(sibling$.get()).toBe(8);
	});

	it('rejects forged proofs, stamps without a factory, and unadmitted hot execution', () => {
		const initial = manifest('source:1', [countShape]);
		const h = harness(initial);
		h.execute(initial, false, (stamp) => {
			__signalAt('g:count$', 1, undefined, stamp);
		});
		expect(() => admitHotSignalPublisher(h.component, {} as any)).toThrow();
		const foreign = createNativeHotSignalOwnerProof({
			publisherKey: 'foreign',
			documentId: 'document',
			ownerKey: h.owner.scopeKey,
			buildId: h.runtime.buildId,
			currentOwner: () => h.owner,
			acceptsComponent: () => false,
			suspendIngress() {},
			rotateIngress() {},
			remount() {},
		});
		expect(() => admitHotSignalPublisher(h.component, foreign)).toThrow();
		const inert = __hotSignalModule(initial);
		const other = () => {};
		__registerHotSignalComponent(inert, other);
		const proof = createNativeHotSignalOwnerProof({
			publisherKey: 'other',
			documentId: 'document',
			ownerKey: h.owner.scopeKey,
			buildId: h.runtime.buildId,
			currentOwner: () => h.owner,
			acceptsComponent: () => true,
			suspendIngress() {},
			rotateIngress() {},
			remount() {},
		});
		expect(() => admitHotSignalPublisher(other, proof)).toThrow();
		expect(() => h.update(manifest('source:2', [countShape]), () => {})).toThrow();
	});

	it('does not run a new factory when an old abort callback retires its owner', () => {
		const initial = manifest('source:1', [queryShape]);
		const h = harness(initial);
		const original = h.owner;
		const stale = deferred<string>();
		h.execute(initial, false, (stamp) => {
			const feed$ = __queryAt(
				'g:feed$',
				() => 'same',
				(_arg, { signal }) => {
					signal.addEventListener('abort', () => original.dispose(), { once: true });
					return stale.promise;
				},
				undefined,
				stamp,
			);
			runWithSignalOwner(h.owner, () => feed$.snapshot());
		});
		const sibling$ = h.sibling$.signal$('count', 41);
		h.admit();
		let factories = 0;
		expect(() =>
			h.update(manifest('source:2', [queryShape]), () => {
				factories++;
			}),
		).toThrow();
		expect(factories).toBe(0);
		expect(original.retired).toBe(true);
		expect(sibling$.get()).toBe(41);
		stale.resolve('obsolete');
	});

	it('retires only the admitted owner before retrying an incompatible native wrapper', () => {
		const initial = manifest('source:1', [countShape]);
		const h = harness(initial);
		const original = h.owner;
		h.execute(initial, false, (stamp) => {
			const count$ = __signalAt('g:count$', 1, undefined, stamp);
			runWithSignalOwner(h.owner, () => count$.set(9));
		});
		const host$ = h.host$.signal$('count', 20);
		h.admit();
		Object.defineProperty(h.component, Symbol.for('octane.hmr'), {
			value: { update: () => original.retired },
		});
		let fresh$!: ReturnType<typeof __signalAt<number>>;
		h.update(manifest('source:2', [countShape]), (stamp) => {
			fresh$ = __signalAt('g:count$', 2, undefined, stamp);
			expect(__remountHotSignalComponent(stamp, h.component, () => {})).toBe(true);
		});
		runWithSignalOwner(h.owner, () => expect(fresh$.get()).toBe(2));
		expect(original.retired).toBe(true);
		expect(h.remounts).toBe(1);
		expect(host$.get()).toBe(20);
	});

	it('keeps ordinary duplicate declarations on their original closure', () => {
		const scope = scopes('ordinary');
		const first$ = __derivedScalarAt('g:same', () => 1);
		const duplicate$ = __derivedScalarAt('g:same', () => 2);
		runWithSignalOwner(scope, () => {
			expect(first$.get()).toBe(1);
			expect(duplicate$.get()).toBe(1);
		});
	});

	it('executes an unsupported initial factory normally while refusing partial admission', () => {
		const scope = scopes('unsupported');
		const shape = manifest('source:1', [countShape]);
		const runtime: HotSignalRuntime = {
			modules: new Map([['mixed', []]]),
			features: new Set(['mixed']),
			executed: new Set(['mixed']),
			buildId: 'build:1',
			generationChanged: false,
		};
		const frame: HotSignalExecutionFrame = {
			runtime,
			executableId: 'mixed',
			buildId: runtime.buildId,
			manifests: [],
			hot: false,
			requiresAdmission: true,
		};
		globals[executionKey] = frame;
		const stamp = __hotSignalModule(shape);
		const count$ = __signalAt('g:count$', 1, undefined, stamp);
		const component = () => {};
		__registerHotSignalComponent(stamp, component);
		globals[bridgeKey].afterFactory(frame);
		delete globals[executionKey];
		runWithSignalOwner(scope, () => {
			count$.set(7);
			expect(count$.get()).toBe(7);
		});
		expect(globals[bridgeKey].allowStatus(runtime, 'check')).toBe(false);
	});
});
