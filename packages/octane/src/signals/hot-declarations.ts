import { formatClientError } from '../error-codes.client.generated.js';
import { installNativeHotOwnerDriver } from '../native-hot-owner.js';
import type { ScopeImpl } from './engine.js';
import type { ScopedNode } from './graph.js';
import { signalBatch } from './graph.js';
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
	readonly runtime?: HotSignalRuntime;
	readonly executableId?: string;
	readonly buildId?: string;
	readonly recipes: Map<string, Recipe>;
	readonly cells: Map<ScopeImpl, MaterializedScope>;
	readonly components: Set<object>;
	readonly admissions: Set<ProofState>;
	readonly rebindGeneration?: string;
	previous?: ModuleState;
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

function fail(): never {
	throw new Error(formatClientError(349));
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
	if (state.retired || !state.runtime || !state.admissions.size) fail();
	pruneRetiredScopes(state);
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
export function getNativeHotSignalComponentBuild(component: object): string | undefined {
	const state = components.get(component);
	return state && !state.retired && state.runtime ? state.buildId : undefined;
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
		admittedFrame = recorded && frame.requiresAdmission;
		if (frame.hot && frame.requiresAdmission) {
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
	if (transaction) {
		transaction.fresh.set(snapshot.moduleId, state);
		if (sameShape(previous!.manifest, snapshot)) {
			for (const [scope, materialized] of previous!.cells) state.cells.set(scope, materialized);
		}
	} else if (state.runtime) {
		let runtimeModules = modules.get(state.runtime);
		if (!runtimeModules) modules.set(state.runtime, (runtimeModules = new Map()));
		const existing = runtimeModules.get(frame!.executableId) ?? [];
		if (existing.some((entry) => entry.manifest.moduleId === snapshot.moduleId)) fail();
		runtimeModules.set(frame!.executableId, [...existing, state]);
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
}

/** @internal Called only after the shared facade resolved the actual native scope. */
export function resolveHotSignalDeclaration<H extends SignalHandle<unknown>>(
	stamp: HotSignalModuleStamp,
	site: string,
	scope: ScopeImpl,
	dataOwner: object,
	create: () => H,
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
		? scope.rebindHotDeclaration(recipe.shape.key, generation, create)
		: create();
	let materialized = state.cells.get(scope);
	if (!materialized)
		state.cells.set(scope, (materialized = { scope, dataOwner, nodes: new Map() }));
	if (materialized.dataOwner !== dataOwner) fail();
	const node = cell as unknown as ScopedNode;
	materialized.nodes.set(site, node);
	let owners = claims.get(node);
	if (!owners) claims.set(node, (owners = new Set()));
	if (state.previous) owners.delete(state.previous);
	owners.add(state);
	return cell;
}

export function __registerHotSignalComponent(stamp: HotSignalModuleStamp, component: object): void {
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
		if (state.runtime || !ordinary) fail();
		previous.retired = true;
	}
	state.components.add(component);
	components.set(component, state);
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

function beforeFactory(frame: HotSignalExecutionFrame): object | undefined {
	if (
		currentFrame() !== frame ||
		!frame.hot ||
		!frame.requiresAdmission ||
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
							materialized.scope.prepareHotDeclarations(
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
			if (errors.length > 1) throw new AggregateError(errors, formatClientError(349));
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
	for (const state of transaction.fresh.values()) {
		const previous = state.previous!;
		for (const component of previous.components) if (!state.components.has(component)) fail();
		pruneRetiredScopes(state);
		for (const materialized of state.cells.values()) {
			if (materialized.scope.retired) fail();
			if (![...state.admissions].some((proof) => admittedOwner(proof) === materialized.dataOwner))
				fail();
			for (const [site] of materialized.nodes) {
				const recipe = state.recipes.get(site);
				const shape = state.manifest.declarations.find((declaration) => declaration.site === site);
				if (shape?.scope !== 'document') continue;
				if (!recipe) fail();
				resolveHotSignalDeclaration(
					moduleStamps.get(state)!,
					site,
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
	modules.get(frame.runtime)!.set(frame.executableId, [...transaction.fresh.values()]);
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
	return valid;
}

function installBridge(): void {
	const globals = globalThis as Record<symbol, unknown>;
	const installed = globals[bridgeKey];
	if (installed && installed !== bridge) fail();
	globals[bridgeKey] = bridge;
	installNativeHotOwnerDriver(nativeOwnerDriver);
}

const bridge = { allowStatus, beforeFactory, afterFactory, abortFactory };
const nativeOwnerDriver = {
	getComponentBuild: getNativeHotSignalComponentBuild,
	createProof: createNativeHotSignalOwnerProof,
	admit: admitHotSignalPublisher,
};
