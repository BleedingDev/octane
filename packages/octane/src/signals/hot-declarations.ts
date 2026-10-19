import { formatClientError } from '../error-codes.client.generated.js';
import { installNativeHotOwnerDriver } from '../native-hot-owner.js';
import type { ScopeImpl } from './engine.js';
import type { GraphOwner, ScopedNode } from './graph.js';
import { assertAlive, assertWritable, invalidateNode, pendingState, signalBatch } from './graph.js';
import { SignalFrameError } from './errors.js';
import type { SignalHandle, SignalOwnerIdentity } from './types.js';

/** Compiler metadata describes declaration identity, never publisher authority. */
export interface HotSignalDeclarationShape {
	readonly site: string;
	readonly key: string;
	readonly scope: 'document' | 'instance';
	readonly kind: 'signal' | 'derived' | 'async';
	readonly factory: '__signalAt' | '__derivedScalarAt' | '__derivedAt' | '__queryAt';
	readonly queryKind?: 'promise' | 'stream';
}

export interface HotSignalModuleManifest {
	readonly version: 1;
	readonly moduleId: string;
	readonly generation: string;
	readonly hookSlots: readonly string[];
	readonly declarations: readonly HotSignalDeclarationShape[];
}

declare const stampBrand: unique symbol;
export interface HotSignalModuleStamp {
	readonly [stampBrand]: true;
}
declare const proofBrand: unique symbol;
export interface HotSignalOwnerProof {
	readonly [proofBrand]: true;
}

/** @internal The Rspack token is local to an actual native module runtime. */
export interface HotSignalRuntime {
	modules: Map<string, HotSignalModuleManifest[]>;
	features: Set<string>;
	executed: Set<string>;
	buildId: string;
	generationChanged: boolean;
}

export interface HotSignalExecutionFrame {
	runtime: HotSignalRuntime;
	executableId: string;
	buildId: string;
	manifests: HotSignalModuleManifest[];
	hot: boolean;
	requiresAdmission: boolean;
	transaction?: object;
}

/** @internal Only the renderer's validated publisher boundary mints this proof. */
export interface NativeHotSignalOwner {
	readonly publisherKey: string;
	readonly documentId: string;
	readonly ownerKey: string;
	readonly buildId: string;
	currentOwner(): SignalOwnerIdentity | undefined;
	/** Check the actual mounted native component under this private boundary. */
	acceptsComponent(component: object): boolean;
	suspendIngress(): void;
	rotateIngress(buildId: string): void;
	/** Retire the old native owner synchronously; remount only this boundary. */
	remount(): void;
	/** Hold native memberships until the returned handoff/recovery cleanup runs. */
	holdUpdate?(): () => void;
}

interface ProofState {
	readonly native: NativeHotSignalOwner;
	readonly memberships: Set<ModuleState>;
	buildId: string;
	released: boolean;
}

interface Recipe {
	readonly shape: HotSignalDeclarationShape;
	readonly create: (scope: ScopeImpl) => SignalHandle<unknown>;
}

interface MaterializedScope {
	readonly scope: ScopeImpl;
	readonly dataOwner: object;
	readonly nodes: Map<string, ScopedNode>;
}

interface ModuleState {
	readonly manifest: HotSignalModuleManifest;
	readonly runtime: HotSignalRuntime | undefined;
	readonly executableId: string | undefined;
	readonly buildId: string | undefined;
	readonly recipes: Map<string, Recipe>;
	readonly cells: Map<ScopeImpl, MaterializedScope>;
	readonly components: Set<object>;
	readonly admissions: Set<ProofState>;
	readonly rebindGeneration: string | undefined;
	previous: ModuleState | undefined;
	retired: boolean;
	aborted?: boolean;
}

interface Transaction {
	readonly token: object;
	readonly frame: HotSignalExecutionFrame;
	readonly previous: ModuleState[];
	readonly fresh: Map<string, ModuleState>;
	readonly proofs: Set<ProofState>;
	readonly cold: Set<ProofState>;
	readonly owners: Map<ProofState, SignalOwnerIdentity>;
	readonly remountedOwners: Set<SignalOwnerIdentity>;
	readonly updates: Map<SignalOwnerIdentity, () => void>;
	readonly bodies: Map<object, object>;
	readonly builds: Map<ProofState, string>;
	readonly generation: string;
	done: boolean;
}

const executionKey = Symbol.for('octane.hot-signals.execution');
const bridgeKey = Symbol.for('octane.hot-signals.bridge');
const hmrKey = Symbol.for('octane.hmr');
const stamps = new WeakMap<object, ModuleState>();
const proofs = new WeakMap<object, ProofState>();
const components = new WeakMap<object, ModuleState>();
const modules = new WeakMap<HotSignalRuntime, Map<string, ModuleState[]>>();
const transactions = new WeakMap<HotSignalExecutionFrame, Transaction>();
const abortResults = new WeakMap<HotSignalExecutionFrame, boolean>();
const claims = new WeakMap<ScopedNode, Set<ModuleState>>();
const activeModules = new WeakSet<ModuleState>();
// A fully retired native publisher leaves no work requiring a live lease.
const admittedModules = new WeakSet<ModuleState>();
const componentBindings = new WeakMap<ModuleState, Map<string, object>>();

interface PublisherReplacement {
	readonly previous: Set<ModuleState>;
	readonly owners: Map<ProofState, SignalOwnerIdentity>;
	readonly updates: Map<SignalOwnerIdentity, () => void>;
	readonly transactions: Transaction[];
	readonly bodies: Map<object, object>;
	readonly canUpdate: (component: object, body: object) => boolean;
	runtime: HotSignalRuntime | undefined;
	committing: boolean;
	failed: boolean;
}

// This scope exists only around one explicitly authorized synchronous factory.
// It never spans container/chunk loading or a promise continuation.
let publisherReplacement: PublisherReplacement | undefined;
const replacementTransactions = new WeakMap<Transaction, PublisherReplacement>();

interface HotDeclarationBarrier {
	readonly generation: string;
	readonly node: ScopedNode;
	readonly waiting: Promise<void>;
	ready(): void;
}
const descriptorStamps = new WeakMap<object, HotSignalModuleStamp>();

export function hotSignalDescriptorStamp(descriptor: object): HotSignalModuleStamp | undefined {
	return descriptorStamps.get(descriptor);
}

export function stampHotSignalDescriptor(descriptor: object, stamp: HotSignalModuleStamp): void {
	descriptorStamps.set(descriptor, stamp);
}

const hotDeclarations = new WeakMap<GraphOwner, Map<string, HotDeclarationBarrier>>();
const installingHotDeclarations = new WeakSet<GraphOwner>();

/** A detached query acquires its replacement namespace only during native rebinding. */
export function hotDeclarationGeneration(node: ScopedNode): string | undefined {
	return installingHotDeclarations.has(node.owner)
		? hotDeclarations.get(node.owner)?.get(node.key)?.generation
		: undefined;
}

/** Stage all owned barriers before any cancellation callback can run. */
export function prepareHotDeclarations(
	scope: ScopeImpl,
	nodes: readonly ScopedNode[],
	generation: string,
): () => void {
	assertAlive(scope);
	assertWritable();
	if (scope.readBarrier || scope.frames?.size) throw new SignalFrameError(formatClientError(359));
	const targets = new Set(nodes);
	for (const node of targets) {
		if (node.owner !== scope || scope.nodes.get(node.key) !== node)
			throw new SignalFrameError(formatClientError(360));
	}
	const retired: { dispose(): void }[] = [];
	const previousBarriers: (() => void)[] = [];
	for (const node of targets) {
		if (node.kind === 'signal') continue;
		let ready!: () => void;
		const waiting = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const previous = hotDeclarations.get(scope)?.get(node.key);
		let barriers = hotDeclarations.get(scope);
		if (barriers === undefined) hotDeclarations.set(scope, (barriers = new Map()));
		barriers.set(node.key, { node, generation, waiting, ready });
		node.compute = () => pendingState(waiting, 'none', undefined, ready);
		node.invalidateAttempt = undefined;
		if (node.kind === 'async')
			node.retry = () => {
				throw waiting;
			};
		const resource = scope.resources?.get(node);
		const derived = scope.derivedBindings?.get(node);
		if (resource) {
			scope.resources!.delete(node);
			retired.push(resource);
		}
		if (derived) {
			scope.derivedBindings!.delete(node);
			retired.push(derived);
		}
		scope.streams?.retireSelection(node.key);
		invalidateNode(node, false);
		if (previous) previousBarriers.push(previous.ready);
	}
	let finished = false;
	return () => {
		if (finished) return;
		finished = true;
		const errors: unknown[] = [];
		signalBatch(() => {
			for (const node of targets) {
				if (node.kind === 'signal') continue;
				try {
					invalidateNode(node);
				} catch (error) {
					errors.push(error);
				}
			}
			for (const ready of previousBarriers) ready();
			// Detached bindings are no longer reachable by Scope.dispose(). Drain
			// every one even if a preceding cancellation retires the owner.
			for (const binding of retired) {
				try {
					binding.dispose();
				} catch (error) {
					errors.push(error);
				}
			}
		});
		if (errors.length > 1) throw new AggregateError(errors, formatClientError(363));
		if (errors.length) throw errors[0];
		assertAlive(scope);
	};
}

/** Lazy instance descriptors install their new closure in the real render scope. */
export function rebindHotDeclaration<T extends SignalHandle<unknown>>(
	scope: ScopeImpl,
	key: string,
	generation: string,
	create: () => T,
): T {
	assertAlive(scope);
	const barrier = hotDeclarations.get(scope)?.get(key);
	if (!barrier) return create();
	if (
		barrier.generation !== generation ||
		scope.nodes.get(key) !== barrier.node ||
		installingHotDeclarations.has(scope)
	) {
		throw new SignalFrameError(formatClientError(361));
	}
	return signalBatch(() => {
		installingHotDeclarations.add(scope);
		try {
			const result = create();
			assertAlive(scope);
			if (
				hotDeclarations.get(scope)?.get(key) !== barrier ||
				(result as SignalHandle<unknown>) !== barrier.node
			) {
				throw new SignalFrameError(formatClientError(362));
			}
			hotDeclarations.get(scope)!.delete(key);
			barrier.ready();
			invalidateNode(barrier.node);
			return result;
		} finally {
			installingHotDeclarations.delete(scope);
		}
	});
}

function fail(): never {
	throw new Error(formatClientError(363));
}

function currentFrame(): HotSignalExecutionFrame | undefined {
	return (globalThis as Record<symbol, unknown>)[executionKey] as
		HotSignalExecutionFrame | undefined;
}

function manifestCopy(value: HotSignalModuleManifest): HotSignalModuleManifest {
	// Compiler records are plain data. Copy first so later mutation cannot alter a grant.
	const copy = JSON.parse(JSON.stringify(value)) as HotSignalModuleManifest;
	if (
		copy?.version !== 1 ||
		typeof copy.moduleId !== 'string' ||
		!copy.moduleId ||
		typeof copy.generation !== 'string' ||
		!copy.generation ||
		!Array.isArray(copy.hookSlots) ||
		!copy.hookSlots.every((slot) => typeof slot === 'string') ||
		!Array.isArray(copy.declarations)
	)
		fail();
	const keys = new Set<string>();
	for (const shape of copy.declarations) {
		if (
			!shape ||
			typeof shape.site !== 'string' ||
			!shape.site ||
			typeof shape.key !== 'string' ||
			!shape.key ||
			!['document', 'instance'].includes(shape.scope) ||
			!['signal', 'derived', 'async'].includes(shape.kind) ||
			!['__signalAt', '__derivedScalarAt', '__derivedAt', '__queryAt'].includes(shape.factory) ||
			(shape.kind === 'signal' && shape.factory !== '__signalAt') ||
			(shape.kind === 'derived' && !['__derivedAt', '__derivedScalarAt'].includes(shape.factory)) ||
			(shape.kind === 'async' &&
				(shape.factory !== '__queryAt' || !['promise', 'stream'].includes(shape.queryKind!))) ||
			keys.has(JSON.stringify([shape.scope, shape.key]))
		)
			fail();
		keys.add(JSON.stringify([shape.scope, shape.key]));
		Object.freeze(shape);
	}
	Object.freeze(copy.hookSlots);
	Object.freeze(copy.declarations);
	return Object.freeze(copy);
}

function sameManifest(left: HotSignalModuleManifest, right: HotSignalModuleManifest): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function sameShape(left: HotSignalModuleManifest, right: HotSignalModuleManifest): boolean {
	return (
		left.moduleId === right.moduleId &&
		JSON.stringify(left.hookSlots) === JSON.stringify(right.hookSlots) &&
		JSON.stringify(left.declarations) === JSON.stringify(right.declarations)
	);
}

function admittedOwner(proof: ProofState): SignalOwnerIdentity | undefined {
	if (proof.released) fail();
	const owner = proof.native.currentOwner();
	if (owner !== undefined && owner.scopeKey !== proof.native.ownerKey) fail();
	return owner;
}

function pruneRetiredScopes(state: ModuleState): void {
	for (const [scope, materialized] of state.cells) {
		if (!scope.retired) continue;
		for (const node of materialized.nodes.values()) claims.get(node)?.delete(state);
		state.cells.delete(scope);
	}
}

function validateModule(state: ModuleState): void {
	if (state.retired || !state.runtime) fail();
	pruneRetiredScopes(state);
	if (!state.admissions.size && (!admittedModules.has(state) || state.cells.size !== 0)) fail();
	for (const proof of state.admissions) {
		if (
			proof.buildId !== state.buildId ||
			!admittedOwner(proof) ||
			![...state.components].some((component) => proof.native.acceptsComponent(component))
		)
			fail();
	}
	for (const materialized of state.cells.values()) {
		if (
			materialized.scope.retired ||
			![...state.admissions].some((proof) => admittedOwner(proof) === materialized.dataOwner)
		)
			fail();
		for (const node of materialized.nodes.values()) {
			const owners = claims.get(node);
			if (owners?.size !== 1 || !owners.has(state)) fail();
		}
	}
}

/** @internal This function is intentionally absent from the public signals entry. */
export function createNativeHotSignalOwnerProof(native: NativeHotSignalOwner): HotSignalOwnerProof {
	for (const value of [native.publisherKey, native.documentId, native.ownerKey, native.buildId]) {
		if (typeof value !== 'string' || !value) fail();
	}
	const owner = native.currentOwner();
	if (!owner || owner.scopeKey !== native.ownerKey) fail();
	const proof = Object.freeze({}) as HotSignalOwnerProof;
	proofs.set(proof, { native, memberships: new Set(), buildId: native.buildId, released: false });
	return proof;
}

/** @internal Derive compiler identity from the registered native factory, never caller data. */
export function getNativeHotSignalComponentBuild(
	component: object,
	signalsOnly = false,
): string | undefined {
	const state = components.get(component);
	return state &&
		!state.retired &&
		state.runtime &&
		(!signalsOnly ||
			state.runtime.features.has(state.executableId!) ||
			state.runtime.executed.has(state.executableId!))
		? state.buildId
		: undefined;
}

/** Admit a compiled component only with authority minted by its native boundary. */
export function admitHotSignalPublisher(component: object, proof: HotSignalOwnerProof): () => void {
	const state = components.get(component);
	const authority = proofs.get(proof);
	if (
		!state ||
		!state.runtime ||
		state.retired ||
		!authority ||
		authority.released ||
		authority.buildId !== state.buildId ||
		!admittedOwner(authority) ||
		!authority.native.acceptsComponent(component)
	)
		fail();
	for (const member of authority.memberships) {
		if (member.runtime !== state.runtime || member.executableId !== state.executableId) fail();
	}
	state.admissions.add(authority);
	admittedModules.add(state);
	authority.memberships.add(state);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		authority.released = true;
		for (const member of authority.memberships) {
			member.admissions.delete(authority);
			pruneRetiredScopes(member);
		}
		authority.memberships.clear();
	};
}

/** Compiler-only module stamp, bound to the exact factory execution frame. */
export function __hotSignalModule(manifest: HotSignalModuleManifest): HotSignalModuleStamp {
	const snapshot = manifestCopy(manifest);
	const frame = currentFrame();
	const transaction = frame && transactions.get(frame);
	let previous: ModuleState | undefined;
	let admittedFrame = false;
	if (frame) {
		if (
			frame.buildId !== frame.runtime.buildId ||
			frame.requiresAdmission !==
				(frame.runtime.features.has(frame.executableId) ||
					frame.runtime.executed.has(frame.executableId))
		)
			fail();
		const recorded = frame.manifests.some((expected) => sameManifest(expected, snapshot));
		// An unsupported concatenated factory may contain a compiled neighbour.
		// Its initial execution remains ordinary; no partial table can admit it.
		if (frame.hot && frame.requiresAdmission && !recorded) fail();
		admittedFrame = recorded;
		if ((frame.hot && frame.requiresAdmission) || transaction) {
			if (!transaction || transaction.done || frame.transaction !== transaction.token) fail();
			previous = transaction.previous.find(
				(state) => state.manifest.moduleId === snapshot.moduleId,
			);
			if (!previous || transaction.fresh.has(snapshot.moduleId)) fail();
		}
	}
	const state: ModuleState = {
		manifest: snapshot,
		runtime: admittedFrame ? frame!.runtime : undefined,
		executableId: admittedFrame ? frame!.executableId : undefined,
		buildId: admittedFrame ? frame!.buildId : undefined,
		recipes: new Map(),
		cells: new Map(),
		components: new Set(),
		admissions: new Set(previous?.admissions),
		previous,
		retired: false,
		rebindGeneration: transaction ? `${transaction.generation}:${snapshot.moduleId}` : undefined,
	};
	for (const authority of state.admissions) authority.memberships.add(state);
	if (previous && admittedModules.has(previous)) admittedModules.add(state);
	if (transaction) {
		transaction.fresh.set(snapshot.moduleId, state);
		if (!replacementTransactions.has(transaction) && sameShape(previous!.manifest, snapshot)) {
			for (const [scope, materialized] of previous!.cells) state.cells.set(scope, materialized);
		}
	} else if (state.runtime) {
		let runtimeModules = modules.get(state.runtime);
		if (!runtimeModules) modules.set(state.runtime, (runtimeModules = new Map()));
		const existing = runtimeModules.get(frame!.executableId) ?? [];
		const duplicate = existing.find((entry) => entry.manifest.moduleId === snapshot.moduleId);
		if (
			duplicate &&
			(!frame!.hot ||
				frame!.requiresAdmission ||
				snapshot.declarations.length !== 0 ||
				duplicate.manifest.declarations.length !== 0 ||
				duplicate.admissions.size !== 0 ||
				duplicate.cells.size !== 0)
		)
			fail();
		runtimeModules.set(frame!.executableId, [
			...existing.filter((entry) => entry !== duplicate),
			state,
		]);
	}
	const stamp = Object.freeze({}) as HotSignalModuleStamp;
	stamps.set(stamp, state);
	moduleStamps.set(state, stamp);
	installBridge();
	return stamp;
}

/** @internal Register a recipe without materializing an owner or starting work. */
export function registerHotSignalDeclaration(
	stamp: HotSignalModuleStamp,
	site: string | undefined,
	key: string,
	kind: SignalHandle<unknown>['kind'],
	factory: HotSignalDeclarationShape['factory'],
	create: (scope: ScopeImpl) => SignalHandle<unknown>,
	queryKind?: 'promise' | 'stream',
): void {
	const state = stamps.get(stamp);
	if (state && !state.runtime) return;
	const shape = state?.manifest.declarations.find((entry) => entry.site === site);
	if (
		!state ||
		state.retired ||
		!shape ||
		shape.key !== key ||
		shape.kind !== kind ||
		shape.factory !== factory ||
		(shape.kind === 'async' && shape.queryKind !== queryKind)
	)
		fail();
	// Instance recipes are created on every render; their current closure belongs
	// to that render. Document recipes have exactly one authored module closure.
	if (shape.scope === 'document' && state.recipes.has(shape.site)) fail();
	state.recipes.set(shape.site, { shape, create });
}

/** @internal Existing cells remain usable after replacement, never after abort. */
export function assertHotSignalDeclarationUsable(stamp: HotSignalModuleStamp): void {
	const state = stamps.get(stamp);
	if (!state || state.aborted) fail();
	if (
		publisherReplacement !== undefined &&
		!publisherReplacement.committing &&
		state.previous !== undefined
	)
		fail();
}

/** @internal Called only after the shared facade resolved the actual native scope. */
export function resolveHotSignalDeclaration<H extends SignalHandle<unknown>>(
	stamp: HotSignalModuleStamp,
	site: string,
	scope: ScopeImpl,
	dataOwner: object,
	create: () => H,
	key?: string,
): H {
	const state = stamps.get(stamp);
	if (state && !state.runtime) return create();
	if (!state || state.retired) fail();
	const recipe = state.recipes.get(site);
	if (!recipe) fail();
	if (
		state.rebindGeneration &&
		![...state.admissions].some((proof) => admittedOwner(proof) === dataOwner)
	)
		fail();
	pruneRetiredScopes(state);
	const generation =
		state.rebindGeneration ?? `${state.buildId}:${state.executableId}:${state.manifest.generation}`;
	const cell = state.rebindGeneration
		? rebindHotDeclaration(scope, key ?? recipe.shape.key, generation, create)
		: create();
	let materialized = state.cells.get(scope);
	if (!materialized)
		state.cells.set(scope, (materialized = { scope, dataOwner, nodes: new Map() }));
	if (materialized.dataOwner !== dataOwner) fail();
	const node = cell as unknown as ScopedNode;
	materialized.nodes.set(node.key, node);
	let owners = claims.get(node);
	if (!owners) claims.set(node, (owners = new Set()));
	if (state.previous) owners.delete(state.previous);
	owners.add(state);
	return cell;
}

/** Select canonical wrappers before authored memo and module-local captures. */
export function __canonicalHotSignalComponent<T extends object>(
	stamp: HotSignalModuleStamp,
	bindingKey: string,
	fresh: T,
): T {
	const state = stamps.get(stamp);
	if (!state || state.retired || !bindingKey) fail();
	const frame = currentFrame();
	const transaction = frame && transactions.get(frame);
	const replacement = transaction && replacementTransactions.get(transaction);
	if (!replacement) return fresh;
	const canonical = state.previous && componentBindings.get(state.previous)?.get(bindingKey);
	if (!canonical) fail();
	const body = (fresh as Record<symbol, { fn?: object }>)[hmrKey]?.fn;
	if (typeof body !== 'function' || replacement.bodies.has(canonical)) fail();
	replacement.bodies.set(canonical, body);
	return canonical as T;
}

export function __registerHotSignalComponent(
	stamp: HotSignalModuleStamp,
	component: object,
	bindingKey?: string,
): void {
	const state = stamps.get(stamp);
	if (
		!state ||
		state.retired ||
		!component ||
		(typeof component !== 'function' && typeof component !== 'object')
	)
		fail();
	const previous = components.get(component);
	if (previous && previous !== state && previous !== state.previous && !previous.retired) {
		const ordinary =
			!previous.runtime ||
			(!previous.manifest.declarations.length &&
				!previous.runtime.features.has(previous.executableId!) &&
				!previous.runtime.executed.has(previous.executableId!));
		if (
			!ordinary ||
			(state.runtime !== undefined &&
				(state.runtime !== previous.runtime || state.executableId !== previous.executableId))
		)
			fail();
		previous.retired = true;
	}
	state.components.add(component);
	components.set(component, state);
	if (bindingKey !== undefined) {
		if (!bindingKey) fail();
		let bindings = componentBindings.get(state);
		if (!bindings) componentBindings.set(state, (bindings = new Map()));
		if (bindings.has(bindingKey) && bindings.get(bindingKey) !== component) fail();
		bindings.set(bindingKey, component);
	}
}

function holdNativeUpdates(
	authorities: Map<ProofState, SignalOwnerIdentity>,
	updates: Map<SignalOwnerIdentity, () => void>,
): void {
	// Synchronous nested factories settle in reverse call order, restoring the
	// outer hold before its final membership reconciliation.
	for (const [proof, owner] of authorities) {
		if (proof.native.holdUpdate !== undefined && !updates.has(owner))
			updates.set(owner, proof.native.holdUpdate());
	}
}

function settleNativeUpdates(updates: Map<SignalOwnerIdentity, () => void>): void {
	const errors: unknown[] = [];
	for (const [owner, settle] of updates) {
		updates.delete(owner);
		try {
			settle();
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 1) throw new AggregateError(errors, formatClientError(363));
	if (errors.length) throw errors[0];
}

function remountProof(transaction: Transaction, proof: ProofState): void {
	if (transaction.cold.has(proof)) return;
	const oldOwner = transaction.owners.get(proof);
	if (!oldOwner) fail();
	if (!transaction.remountedOwners.has(oldOwner)) {
		proof.native.remount();
		transaction.remountedOwners.add(oldOwner);
	}
	if (admittedOwner(proof) === oldOwner) fail();
	for (const state of transaction.previous) {
		for (const materialized of state.cells.values()) {
			if (materialized.dataOwner === oldOwner && !materialized.scope.retired) fail();
		}
	}
	transaction.cold.add(proof);
}

/** Retry the canonical native wrapper only after its exact admitted owner retired. */
export function __remountHotSignalComponent(
	stamp: HotSignalModuleStamp,
	previousWrapper: object,
	freshBody: object,
): boolean {
	const state = stamps.get(stamp);
	const frame = currentFrame();
	const transaction = frame && transactions.get(frame);
	if (
		!state?.previous ||
		!transaction ||
		transaction.done ||
		frame!.transaction !== transaction.token ||
		components.get(previousWrapper) !== state.previous
	)
		return false;
	for (const proof of state.previous.admissions) remountProof(transaction, proof);
	const metadata = (previousWrapper as Record<symbol, { update?: (fresh: object) => boolean }>)[
		hmrKey
	];
	return metadata?.update?.(freshBody) === true;
}

function allowStatus(runtime: HotSignalRuntime): boolean {
	try {
		for (const id of runtime.executed) {
			const states = modules.get(runtime)?.get(id);
			const table = runtime.modules.get(id);
			if (!states?.length || !table?.length || states.length !== table.length) return false;
			for (const state of states) {
				if (!table.some((manifest) => sameManifest(state.manifest, manifest))) return false;
				validateModule(state);
			}
		}
		return true;
	} catch {
		return false;
	}
}

function replacementFactory(frame: HotSignalExecutionFrame): boolean {
	return (
		publisherReplacement !== undefined &&
		!publisherReplacement.committing &&
		frame.manifests.some((manifest) =>
			[...publisherReplacement!.previous].some(
				(state) => state.manifest.moduleId === manifest.moduleId,
			),
		)
	);
}

function beginReplacementFactory(frame: HotSignalExecutionFrame): object {
	const replacement = publisherReplacement!;
	if (
		replacement.failed ||
		currentFrame() !== frame ||
		frame.hot ||
		frame.runtime.executed.has(frame.executableId) ||
		frame.buildId !== frame.runtime.buildId ||
		transactions.has(frame) ||
		(replacement.runtime !== undefined && replacement.runtime !== frame.runtime)
	)
		fail();
	const previous = frame.manifests.map((manifest) => {
		const found = [...replacement.previous].find(
			(state) => state.manifest.moduleId === manifest.moduleId,
		);
		if (
			!found ||
			found.runtime === frame.runtime ||
			replacement.transactions.some((transaction) => transaction.previous.includes(found))
		)
			fail();
		return found;
	});
	if (!previous.length || new Set(previous).size !== previous.length) fail();
	replacement.runtime = frame.runtime;
	const transaction: Transaction = {
		token: Object.freeze({}),
		frame,
		previous,
		fresh: new Map(),
		proofs: new Set(previous.flatMap((state) => [...state.admissions])),
		cold: new Set(),
		owners: new Map(),
		remountedOwners: new Set(),
		updates: new Map(),
		bodies: new Map(),
		builds: new Map(),
		generation: `${frame.buildId}:${frame.executableId}`,
		done: false,
	};
	for (const proof of transaction.proofs) {
		const owner = replacement.owners.get(proof);
		if (!owner || admittedOwner(proof) !== owner) fail();
		transaction.owners.set(proof, owner);
		transaction.builds.set(proof, proof.buildId);
	}
	for (const state of previous)
		for (const component of state.components) {
			const body = (component as Record<symbol, { fn?: object }>)[hmrKey]?.fn;
			if (typeof body !== 'function') fail();
			transaction.bodies.set(component, body);
		}
	transactions.set(frame, transaction);
	replacementTransactions.set(transaction, replacement);
	replacement.transactions.push(transaction);
	return transaction.token;
}

function discardPublisherReplacement(replacement: PublisherReplacement): void {
	replacement.failed = true;
	if (replacement.committing) {
		for (const transaction of replacement.transactions) {
			if (transaction.done) continue;
			try {
				abortFactory(transaction.frame);
			} catch {
				// Preserve the original native commit failure after attempting every owner.
			}
		}
	}
	for (const transaction of replacement.transactions) {
		if (transaction.done) continue;
		transactions.delete(transaction.frame);
		for (const state of transaction.fresh.values()) {
			state.retired = state.aborted = true;
			for (const component of state.components) {
				if (components.get(component) !== state) continue;
				if (state.previous?.components.has(component)) components.set(component, state.previous);
				else components.delete(component);
			}
			for (const proof of state.admissions) proof.memberships.delete(state);
			state.admissions.clear();
			state.previous = undefined;
		}
		const { runtime, executableId } = transaction.frame;
		if (
			!modules
				.get(runtime)
				?.get(executableId)
				?.some((state) => !state.retired)
		)
			runtime.executed.delete(executableId);
	}
}

/** Native boundary authority, never caller-supplied module IDs or build hashes. */
export function prepareNativePublisherReplacement(
	component: object,
	token: HotSignalOwnerProof,
	canUpdate: (component: object, body: object) => boolean,
	assertCanExecute: () => void,
): { readonly commitStarted: boolean; execute<T>(factory: () => T): T } {
	const root = components.get(component);
	const authority = proofs.get(token);
	if (
		!root?.runtime ||
		!authority ||
		!root.admissions.has(authority) ||
		!authority.native.acceptsComponent(component)
	)
		fail();
	validateModule(root);
	const owners = new Set<SignalOwnerIdentity>();
	for (const proof of root.admissions) {
		if (!proof.native.acceptsComponent(component)) continue;
		if (
			proof.native.publisherKey !== authority.native.publisherKey ||
			proof.native.documentId !== authority.native.documentId
		)
			fail();
		const owner = admittedOwner(proof);
		if (!owner) fail();
		owners.add(owner);
	}
	const previous = new Set<ModuleState>();
	const captured = new Map<ProofState, SignalOwnerIdentity>();
	for (const states of modules.get(root.runtime)?.values() ?? [])
		for (const state of states) {
			if (![...state.admissions].some((proof) => owners.has(admittedOwner(proof)!))) continue;
			validateModule(state);
			for (const proof of state.admissions) {
				const owner = admittedOwner(proof);
				if (!owner || !owners.has(owner)) fail();
				captured.set(proof, owner);
			}
			if (componentBindings.get(state)?.size !== state.components.size) fail();
			previous.add(state);
		}
	if (!previous.has(root)) fail();
	let consumed = false;
	let attempted: PublisherReplacement | undefined;
	return Object.freeze({
		get commitStarted(): boolean {
			return attempted?.committing === true;
		},
		execute<T>(factory: () => T): T {
			if (consumed) fail();
			consumed = true;
			assertCanExecute();
			if (publisherReplacement !== undefined || typeof factory !== 'function') fail();
			for (const [proof, owner] of captured) if (admittedOwner(proof) !== owner) fail();
			for (const state of previous) validateModule(state);
			// Loading the next container may admit or remove conditional modules.
			// The factory grant covers only the complete graph captured at prepare.
			let currentModules = 0;
			for (const states of modules.get(root.runtime!)?.values() ?? [])
				for (const state of states) {
					if (![...state.admissions].some((proof) => owners.has(admittedOwner(proof)!))) continue;
					if (!previous.has(state)) fail();
					for (const proof of state.admissions)
						if (captured.get(proof) !== admittedOwner(proof)) fail();
					currentModules++;
				}
			if (currentModules !== previous.size) fail();
			const replacement: PublisherReplacement = {
				previous,
				owners: captured,
				updates: new Map(),
				transactions: [],
				bodies: new Map(),
				canUpdate,
				runtime: undefined,
				committing: false,
				failed: false,
			};
			attempted = replacement;
			publisherReplacement = replacement;
			try {
				holdNativeUpdates(replacement.owners, replacement.updates);
				const result = factory();
				if (
					result !== null &&
					(typeof result === 'object' || typeof result === 'function') &&
					'then' in result &&
					typeof result.then === 'function'
				) {
					Promise.resolve(result).catch(() => {});
					fail();
				}
				if (
					replacement.failed ||
					!replacement.transactions.length ||
					[...previous].some(
						(state) =>
							!replacement.transactions.some((transaction) => transaction.previous.includes(state)),
					)
				)
					fail();
				commitPublisherReplacement(replacement);
				return result;
			} catch (error) {
				discardPublisherReplacement(replacement);
				throw error;
			} finally {
				publisherReplacement = undefined;
				settleNativeUpdates(replacement.updates);
			}
		},
	});
}

function commitPublisherReplacement(replacement: PublisherReplacement): void {
	const all = replacement.transactions;
	for (const [proof, owner] of replacement.owners) if (admittedOwner(proof) !== owner) fail();
	for (const transaction of all) {
		if (transaction.fresh.size !== transaction.previous.length) fail();
		for (const previous of transaction.previous) {
			const fresh = transaction.fresh.get(previous.manifest.moduleId);
			if (
				!fresh ||
				fresh.cells.size ||
				previous.components.size !== fresh.components.size ||
				[...previous.components].some(
					(component) => !fresh.components.has(component) || !replacement.bodies.has(component),
				)
			)
				fail();
		}
	}
	// Factory evaluation and its captures are complete. Only now cancel old
	// producers, rotate native ownership, or install a candidate component body.
	const coldOwners = new Set<SignalOwnerIdentity>();
	for (const transaction of all)
		for (const previous of transaction.previous) {
			const fresh = transaction.fresh.get(previous.manifest.moduleId)!;
			let compatible = sameShape(previous.manifest, fresh.manifest);
			for (const component of previous.components)
				if (!replacement.canUpdate(component, replacement.bodies.get(component)!))
					compatible = false;
			if (!compatible)
				for (const proof of previous.admissions) coldOwners.add(replacement.owners.get(proof)!);
		}
	replacement.committing = true;
	for (const [proof, owner] of replacement.owners) {
		proof.native.suspendIngress();
		if (!coldOwners.has(owner)) continue;
		proof.native.remount();
		coldOwners.delete(owner);
		for (const transaction of all)
			for (const sibling of transaction.proofs)
				if (replacement.owners.get(sibling) === owner) transaction.cold.add(sibling);
	}
	try {
		signalBatch(() => {
			const finishes: (() => void)[] = [];
			try {
				for (const transaction of all)
					for (const previous of transaction.previous) {
						const fresh = transaction.fresh.get(previous.manifest.moduleId)!;
						for (const [scope, materialized] of previous.cells) {
							if (scope.retired) continue;
							fresh.cells.set(scope, materialized);
							finishes.push(
								prepareHotDeclarations(
									scope,
									[...materialized.nodes.values()],
									`${transaction.generation}:${previous.manifest.moduleId}`,
								),
							);
						}
					}
			} finally {
				const errors: unknown[] = [];
				for (const finish of finishes) {
					try {
						finish();
					} catch (error) {
						errors.push(error);
					}
				}
				if (errors.length) throw new AggregateError(errors, formatClientError(363));
			}
			for (const [component, body] of replacement.bodies) {
				const meta = (component as Record<symbol, { update?: (body: object) => boolean }>)[hmrKey];
				if (meta?.update?.(body) !== true) fail();
			}
			const globals = globalThis as Record<symbol, unknown>;
			const previousFrame = globals[executionKey];
			try {
				for (const transaction of all) {
					globals[executionKey] = transaction.frame;
					afterFactory(transaction.frame);
				}
				// All owner callbacks and declaration rebindings must succeed before
				// retiring any old module. A commit error can then use native abort
				// recovery against the complete previous graph.
				for (const transaction of all) finishFactory(transaction);
			} finally {
				if (previousFrame === undefined) delete globals[executionKey];
				else globals[executionKey] = previousFrame;
			}
		});
	} finally {
		// Observer delivery can throw after every transaction has committed.
		// Retired runtimes must still release their fence, without revoking the
		// fresh graph whose canonical wrappers now own the mounted publishers.
		for (const previous of replacement.previous) {
			if (!previous.retired) continue;
			const runtime = previous.runtime!;
			const id = previous.executableId!;
			const surviving =
				modules
					.get(runtime)
					?.get(id)
					?.filter((state) => !state.retired) ?? [];
			if (surviving.length) modules.get(runtime)!.set(id, surviving);
			else {
				modules.get(runtime)?.delete(id);
				runtime.executed.delete(id);
			}
		}
	}
}

function requiresFactoryAdmission(frame: HotSignalExecutionFrame): boolean {
	return (
		modules
			.get(frame.runtime)
			?.get(frame.executableId)
			?.some((state) => admittedModules.has(state)) === true
	);
}

function beforeFactory(frame: HotSignalExecutionFrame): object | undefined {
	if (replacementFactory(frame)) return beginReplacementFactory(frame);
	if (
		currentFrame() !== frame ||
		!frame.hot ||
		(!frame.requiresAdmission && !requiresFactoryAdmission(frame)) ||
		frame.buildId !== frame.runtime.buildId ||
		transactions.has(frame)
	)
		return;
	const previous = modules.get(frame.runtime)?.get(frame.executableId);
	if (
		!previous?.length ||
		!frame.manifests.length ||
		new Set(frame.manifests.map((manifest) => manifest.moduleId)).size !== frame.manifests.length ||
		previous.length !== frame.manifests.length ||
		previous.some((state) => activeModules.has(state))
	)
		return;
	for (const state of previous) validateModule(state);
	const transaction: Transaction = {
		token: Object.freeze({}),
		frame,
		previous,
		fresh: new Map(),
		proofs: new Set(),
		cold: new Set(),
		owners: new Map(),
		remountedOwners: new Set(),
		updates: new Map(),
		bodies: new Map(),
		builds: new Map(),
		generation: `${frame.buildId}:${frame.executableId}`,
		done: false,
	};
	transactions.set(frame, transaction);
	for (const state of previous) activeModules.add(state);
	try {
		for (const state of previous)
			for (const proof of state.admissions) transaction.proofs.add(proof);
		for (const state of previous)
			for (const component of state.components) {
				const fn = (component as Record<symbol, { fn?: object }>)[hmrKey]?.fn;
				if (typeof fn === 'function') transaction.bodies.set(component, fn);
			}
		for (const proof of transaction.proofs) {
			const owner = admittedOwner(proof);
			if (!owner) fail();
			transaction.owners.set(proof, owner);
			transaction.builds.set(proof, proof.buildId);
		}
		holdNativeUpdates(transaction.owners, transaction.updates);
		for (const proof of transaction.proofs) {
			const owner = admittedOwner(proof);
			proof.native.suspendIngress();
			if (!owner || admittedOwner(proof) !== owner) fail();
		}
		for (const state of previous) {
			const next = frame.manifests.find(
				(manifest) => manifest.moduleId === state.manifest.moduleId,
			);
			if (!next) fail();
			if (!sameShape(state.manifest, manifestCopy(next))) {
				for (const proof of state.admissions) remountProof(transaction, proof);
			}
		}
		signalBatch(() => {
			const prepared: (() => void)[] = [];
			const errors: unknown[] = [];
			try {
				for (const state of previous)
					for (const materialized of state.cells.values()) {
						if (materialized.scope.retired) continue;
						prepared.push(
							prepareHotDeclarations(
								materialized.scope,
								[...materialized.nodes.values()],
								`${transaction.generation}:${state.manifest.moduleId}`,
							),
						);
					}
			} catch (error) {
				errors.push(error);
			}
			for (const finish of prepared) {
				try {
					finish();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length > 1) throw new AggregateError(errors, formatClientError(363));
			if (errors.length) throw errors[0];
		});
		for (const state of previous)
			for (const materialized of state.cells.values()) {
				if (
					!materialized.scope.retired &&
					![...state.admissions].some((proof) => admittedOwner(proof) === materialized.dataOwner)
				)
					fail();
			}
		return transaction.token;
	} catch (error) {
		abortFactory(frame);
		throw error;
	}
}

function afterFactory(frame: HotSignalExecutionFrame): void {
	const transaction = transactions.get(frame);
	if (!transaction) {
		if (frame.hot && frame.requiresAdmission) fail();
		return;
	}
	if (
		transaction.done ||
		frame.transaction !== transaction.token ||
		currentFrame() !== frame ||
		transaction.fresh.size !== frame.manifests.length
	)
		fail();
	const replacement = replacementTransactions.get(transaction);
	if (replacement !== undefined && !replacement.committing) return;
	for (const state of transaction.fresh.values()) {
		const previous = state.previous!;
		for (const component of previous.components) if (!state.components.has(component)) fail();
		pruneRetiredScopes(state);
		for (const materialized of state.cells.values()) {
			if (materialized.scope.retired) fail();
			if (![...state.admissions].some((proof) => admittedOwner(proof) === materialized.dataOwner))
				fail();
			for (const node of materialized.nodes.values()) {
				const shape = state.manifest.declarations.find(
					(declaration) => declaration.key === node.key,
				);
				const site = shape?.site;
				const recipe = site === undefined ? undefined : state.recipes.get(site);
				if (shape?.scope !== 'document') continue;
				if (!recipe) fail();
				resolveHotSignalDeclaration(
					moduleStamps.get(state)!,
					site!,
					materialized.scope,
					materialized.dataOwner,
					() => recipe.create(materialized.scope),
				);
			}
		}
	}
	for (const proof of transaction.proofs) {
		if (!transaction.cold.has(proof) && !admittedOwner(proof)) fail();
		proof.native.rotateIngress(frame.buildId);
		if (!transaction.cold.has(proof) && !admittedOwner(proof)) fail();
		proof.buildId = frame.buildId;
	}
	if (replacement !== undefined) return;
	finishFactory(transaction);
	settleNativeUpdates(transaction.updates);
}

function finishFactory(transaction: Transaction): void {
	const frame = transaction.frame;
	for (const state of transaction.previous) {
		state.retired = true;
		activeModules.delete(state);
		for (const materialized of state.cells.values())
			for (const node of materialized.nodes.values()) claims.get(node)?.delete(state);
		state.cells.clear();
		state.recipes.clear();
		state.components.clear();
		for (const authority of state.admissions) authority.memberships.delete(state);
		state.admissions.clear();
		state.previous = undefined;
	}
	for (const state of transaction.fresh.values()) {
		for (const materialized of state.cells.values())
			for (const node of materialized.nodes.values()) claims.get(node)?.add(state);
		state.previous = undefined;
	}
	let runtimeModules = modules.get(frame.runtime);
	if (!runtimeModules) modules.set(frame.runtime, (runtimeModules = new Map()));
	runtimeModules.set(frame.executableId, [...transaction.fresh.values()]);
	transaction.done = true;
	transactions.delete(frame);
	if (!frame.runtime.features.has(frame.executableId))
		frame.runtime.executed.delete(frame.executableId);
}

// WeakMap keys cannot be enumerated; each state retains exactly its opaque stamp.
const moduleStamps = new WeakMap<ModuleState, HotSignalModuleStamp>();

function abortFactory(frame: HotSignalExecutionFrame): boolean {
	const transaction = transactions.get(frame);
	if (!transaction || transaction.done) return abortResults.get(frame) ?? true;
	const replacement = replacementTransactions.get(transaction);
	if (replacement !== undefined && !replacement.committing) {
		discardPublisherReplacement(replacement);
		return true;
	}
	transaction.done = true;
	transactions.delete(frame);
	abortResults.set(frame, false);
	for (const state of transaction.previous) activeModules.delete(state);
	// Revoke leaked fresh descriptors and restore canonical identity before
	// native owner callbacks can reenter the registry.
	for (const state of transaction.fresh.values()) {
		state.retired = true;
		state.aborted = true;
		for (const component of state.components)
			if (components.get(component) === state) components.delete(component);
		for (const materialized of state.cells.values())
			for (const node of materialized.nodes.values()) claims.get(node)?.delete(state);
		for (const authority of state.admissions) authority.memberships.delete(state);
		state.admissions.clear();
		state.cells.clear();
		state.recipes.clear();
		state.components.clear();
		state.previous = undefined;
	}
	for (const state of transaction.previous)
		for (const component of state.components) components.set(component, state);
	for (const [proof, buildId] of transaction.builds) proof.buildId = buildId;
	const restored = new Set<object>();
	const restoreBodies = () => {
		for (const [component, fn] of transaction.bodies) {
			if (restored.has(component)) continue;
			try {
				const meta = (component as Record<symbol, { update?: (body: object) => boolean }>)[hmrKey];
				if (meta?.update?.(fn) === true) restored.add(component);
			} catch {
				/* A failed native restore keeps the gate's document fence. */
			}
		}
	};
	restoreBodies();
	const owners = new Map<object, ProofState>();
	let valid = true;
	for (const proof of transaction.proofs) {
		try {
			const owner = admittedOwner(proof) ?? transaction.owners.get(proof);
			if (!owner) {
				valid = false;
				continue;
			}
			if (!owners.has(owner)) owners.set(owner, proof);
		} catch {
			valid = false;
		}
	}
	// An abort also retires a fresh owner created by a pre-factory cold reset.
	// Shared proofs for one native slot must never reset that new owner twice.
	for (const [owner, proof] of owners) {
		try {
			proof.native.remount();
			if (admittedOwner(proof) === owner) valid = false;
			for (const state of transaction.previous)
				for (const materialized of state.cells.values()) {
					if (materialized.dataOwner === owner && !materialized.scope.retired) valid = false;
				}
		} catch {
			valid = false;
		}
	}
	restoreBodies();
	valid &&= restored.size === transaction.bodies.size;
	abortResults.set(frame, valid);
	if (replacement === undefined) settleNativeUpdates(transaction.updates);
	return valid;
}

function installBridge(): void {
	const globals = globalThis as Record<symbol, unknown>;
	const installed = globals[bridgeKey];
	if (installed && installed !== bridge) fail();
	globals[bridgeKey] = bridge;
	installNativeHotOwnerDriver(nativeOwnerDriver);
}

const bridge = {
	allowStatus,
	replacementFactory,
	requiresFactoryAdmission,
	beforeFactory,
	afterFactory,
	abortFactory,
};
const nativeOwnerDriver = {
	getComponentBuild: getNativeHotSignalComponentBuild,
	createProof: createNativeHotSignalOwnerProof,
	admit: admitHotSignalPublisher,
	prepareReplacement: prepareNativePublisherReplacement,
};
