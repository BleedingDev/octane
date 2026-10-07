import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import rspack, { type Compiler, type Stats } from '@rspack/core';
import { afterEach, expect, it } from 'vitest';
import { createStreamedSignalHmrRuntimeModule } from '../src/streamed-signals-hmr.js';
import { OctaneRspackPlugin } from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	delete (globalThis as any).__octaneNativeHmrEffects;
	delete (globalThis as any).__octaneFailedHmrExports;
	delete (globalThis as any).location;
	delete (globalThis as any)[Symbol.for('octane.hot-signals.bridge')];
	delete (globalThis as any)[Symbol.for('octane.hot-signals.execution')];
});

async function withWatch(
	compiler: Compiler,
	run: (
		first: Stats,
		nextBuild: (accept?: (stats: Stats) => boolean) => Promise<Stats>,
	) => Promise<void>,
) {
	let completed: (error: Error | null, stats?: Stats) => void;
	const nextBuild = (accept: (stats: Stats) => boolean = () => true) =>
		new Promise<Stats>((resolve, reject) => {
			completed = (error, stats) => {
				if (error) reject(error);
				else if (stats && accept(stats)) resolve(stats);
				else if (stats) return;
				else reject(new Error('Rspack completed without stats.'));
			};
		});
	const firstBuild = nextBuild();
	const watching = compiler.watch(
		{ ...compiler.options.watchOptions, aggregateTimeout: 0, poll: 20 },
		(error, stats) => {
			completed(
				error ??
					(stats?.hasErrors() ? new Error(stats.toString({ all: false, errors: true })) : null),
				stats,
			);
		},
	);
	try {
		await run(await firstBuild, nextBuild);
	} finally {
		await new Promise<void>((resolve) => watching.close(resolve));
		await new Promise<void>((resolve, reject) =>
			compiler.close((error) => (error ? reject(error) : resolve())),
		);
	}
}

function hasFactoryEffect(stats: Stats, effect: string): boolean {
	return stats.compilation
		.getAssets()
		.some(
			(asset) =>
				asset.name.includes('.hot-update.') && String(asset.source.source()).includes(effect),
		);
}

async function applyBuild(
	entry: { runtime(): { buildId: string }; update(): Promise<unknown> },
	stats: Stats,
) {
	for (let attempt = 0; attempt < 10; attempt++) {
		expect(await entry.update()).not.toBeNull();
		if (entry.runtime().buildId === stats.hash) return;
	}
	throw new Error(`Native HMR did not reach compilation ${stats.hash}.`);
}

function nativeCompiler(root: string) {
	mkdirSync(join(root, 'node_modules'));
	symlinkSync(
		fileURLToPath(new URL('../../octane', import.meta.url)),
		join(root, 'node_modules/octane'),
	);
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ private: true, dependencies: { octane: '*' } }),
	);
	return rspack({
		mode: 'development',
		target: 'node',
		context: root,
		entry: './entry.cjs',
		devtool: false,
		resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
		// Parallel native implementation edits are outside this app-update fixture.
		watchOptions: {
			ignored: /(?:[\\/](?:packages|node_modules)[\\/]octane[\\/]src|[\\/]dist)(?:[\\/]|$)/,
		},
		output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
		plugins: [
			new rspack.HotModuleReplacementPlugin(),
			new OctaneRspackPlugin({ root, environment: 'client', parallel: false }),
		],
	})!;
}

it('updates eligible ordinary modules repeatedly without signal-owner admission', async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'octane-native-ordinary-hmr-')));
	roots.push(root);
	writeFileSync(
		join(root, 'entry.cjs'),
		`
require('./ordinary.tsrx');
exports.update = function() { return module.hot.check(true); };
exports.build = function() { return __webpack_hash__; };
exports.runtime = function() { return __webpack_require__.__octaneHotSignalRuntime; };
`,
	);
	const source = (version: number) => `
export function Ordinary() @{ <span>ordinary</span> }
globalThis.__octaneNativeHmrEffects.push(${version});
`;
	writeFileSync(join(root, 'ordinary.tsrx'), source(1));
	await withWatch(nativeCompiler(root), async (first, nextBuild) => {
		(globalThis as any).__octaneNativeHmrEffects = [];
		let reloads = 0;
		(globalThis as any).location = {
			reload() {
				reloads++;
			},
		};
		const entry = createRequire(import.meta.url)(join(root, 'dist/entry.cjs'));
		const runtime = entry.runtime();
		expect(entry.build()).toBe(first.hash);
		expect(runtime.executed.size).toBe(0);
		for (const version of [2, 3]) {
			const changedBuild = nextBuild();
			writeFileSync(join(root, 'ordinary.tsrx'), source(version));
			const stats = await changedBuild;
			await applyBuild(entry, stats);
			expect(entry.runtime()).toBe(runtime);
			expect(runtime.buildId).toBe(stats.hash);
			expect(runtime.executed.size).toBe(0);
			expect(entry.build()).toBe(stats.hash);
		}
		expect(reloads).toBe(0);
		expect((globalThis as any).__octaneNativeHmrEffects).toEqual([1, 2, 3]);
		const failedBuild = nextBuild((stats) => hasFactoryEffect(stats, 'ordinary factory failed'));
		writeFileSync(
			join(root, 'ordinary.tsrx'),
			`${source(4)}\nthrow new Error('ordinary factory failed');`,
		);
		await expect(applyBuild(entry, await failedBuild)).rejects.toThrow(/ordinary factory failed/);
		expect(runtime.executed.size).toBe(0);
		expect(reloads).toBe(0);
		expect((globalThis as any).__octaneNativeHmrEffects).toEqual([1, 2, 3, 4]);
		expect((globalThis as any)[Symbol.for('octane.hot-signals.execution')]).toBeUndefined();
	});
}, 30_000);

it.each(['updated', 'released-owner', 'factory-error', 'rollback-error'] as const)(
	'admits successive native feature generations and retains the fence for %s',
	async (outcome) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'octane-native-admitted-hmr-')));
		roots.push(root);
		const nativeOwner = fileURLToPath(
			new URL('../../octane/src/signals/hot-declarations.js', import.meta.url),
		);
		const facade = fileURLToPath(new URL('../../octane/src/signals/facade.js', import.meta.url));
		writeFileSync(
			join(root, 'entry.cjs'),
			`
const { createScope, __signalAt } = require('octane/signals');
const { admitHotSignalPublisher, createNativeHotSignalOwnerProof, getNativeHotSignalComponentBuild } = require(${JSON.stringify(nativeOwner)});
const { resolveSignalHandleForScope } = require(${JSON.stringify(facade)});
const feature = require('./feature.tsrx');
require('./ordinary.cjs');
module.hot.accept('./ordinary.cjs', function() { require('./ordinary.cjs'); });
let owner = createScope({ scopeKey: 'native:feature' });
const sibling = createScope({ scopeKey: 'native:sibling' });
const siblingCell = resolveSignalHandleForScope(__signalAt('g:sibling', 41), sibling);
const writable = resolveSignalHandleForScope(feature.count$, owner);
const derived = resolveSignalHandleForScope(feature.result$, owner);
writable.set(7);
exports.transitions = [];
exports.remounts = 0;
const proof = createNativeHotSignalOwnerProof({
  publisherKey: 'native:publisher', documentId: 'native:document',
  ownerKey: owner.scopeKey, buildId: __webpack_hash__,
  acceptsComponent(component) { return component === feature.Feature; },
  currentOwner() { return owner; },
  suspendIngress() { exports.transitions.push('suspend'); },
  rotateIngress(buildId) { exports.transitions.push(buildId); },
  remount() {
    if (exports.rejectRemount) throw new Error('native owner remount failed');
    owner.dispose();
    owner = createScope({ scopeKey: 'native:feature' });
    exports.remounts++;
  }
});
const release = admitHotSignalPublisher(feature.Feature, proof);
exports.releaseAdmission = release;
exports.update = function() { return module.hot.check(true); };
exports.read = function() { return [writable.get(), derived.get(), siblingCell.get()]; };
exports.current = function() {
  return [resolveSignalHandleForScope(require('./feature.tsrx').count$, owner),
          resolveSignalHandleForScope(require('./feature.tsrx').result$, owner)];
};
exports.handles = [writable, derived];
exports.owner = function() { return owner; };
exports.sibling = function() { return siblingCell.get(); };
exports.runtime = function() { return __webpack_require__.__octaneHotSignalRuntime; };
exports.componentBody = function() { return feature.Feature[Symbol.for('octane.hmr')].fn; };
exports.componentBuild = function() { return getNativeHotSignalComponentBuild(feature.Feature); };
exports.failedRead = function() { return resolveSignalHandleForScope(globalThis.__octaneFailedHmrExports.count$, owner).get(); };
exports.status = function() { return module.hot.status(); };
exports.dispose = function() { release(); owner.dispose(); sibling.dispose(); };
`,
		);
		const source = (
			version: number,
			options: {
				prefix?: string;
				hook?: boolean;
				general?: boolean;
				removed?: boolean;
				fail?: boolean;
			} = {},
		) => `${options.prefix ?? ''}
import { useState } from 'octane';
${
	options.removed
		? ''
		: `
import { signal$, derived$ } from 'octane/signals';
export const count$ = signal$(1);
export const result$ = derived$(() => count$.get() + ${version}, ${options.general ? "{ key: 'result', sync:false }" : "{ key: 'result', sync: true }"});
`
}
export function Feature() @{ ${options.hook ? 'const [value] = useState(0);' : ''} <span>feature</span> }
globalThis.__octaneNativeHmrEffects.push('feature${version}');
${options.fail ? `globalThis.__octaneFailedHmrExports = { count$, result$ }; throw new Error('authored feature factory failed');` : ''}
`;
		writeFileSync(join(root, 'feature.tsrx'), source(1));
		writeFileSync(
			join(root, 'ordinary.cjs'),
			'globalThis.__octaneNativeHmrEffects.push("ordinary1");',
		);
		await withWatch(nativeCompiler(root), async (first, nextBuild) => {
			(globalThis as any).__octaneNativeHmrEffects = [];
			let reloads = 0;
			(globalThis as any).location = {
				reload() {
					reloads++;
				},
			};
			const entry = createRequire(import.meta.url)(join(root, 'dist/entry.cjs'));
			try {
				const runtime = entry.runtime();
				const manifest = () =>
					[...runtime.modules.values()]
						.flat()
						.find((value: any) => value.moduleId === '/feature.tsrx');
				expect(runtime.buildId).toBe(first.hash);
				expect(entry.read()).toEqual([7, 8, 41]);
				for (const version of [2, 3]) {
					const priorBuild = runtime.buildId;
					const changedBuild = nextBuild((stats) => hasFactoryEffect(stats, `feature${version}`));
					writeFileSync(join(root, 'feature.tsrx'), source(version));
					const stats = await changedBuild;
					expect(stats.hash).not.toBe(priorBuild);
					expect(hasFactoryEffect(stats, `feature${version}`)).toBe(true);
					await applyBuild(entry, stats);
					expect((globalThis as any).__octaneNativeHmrEffects.at(-1)).toBe(`feature${version}`);
					expect(entry.runtime()).toBe(runtime);
					expect(runtime.buildId).toBe(stats.hash);
					expect(entry.current()[0]).toBe(entry.handles[0]);
					expect(entry.current()[1]).toBe(entry.handles[1]);
					expect(entry.read()).toEqual([7, 7 + version, 41]);
					expect(entry.remounts).toBe(0);
					expect(entry.transitions.slice(-2)).toEqual(['suspend', stats.hash]);
					if (version === 2) {
						const ordinaryBuild = nextBuild((stats) => hasFactoryEffect(stats, 'ordinary2'));
						writeFileSync(
							join(root, 'ordinary.cjs'),
							'globalThis.__octaneNativeHmrEffects.push("ordinary2");',
						);
						const ordinaryStats = await ordinaryBuild;
						await applyBuild(entry, ordinaryStats);
						expect(runtime.buildId).toBe(ordinaryStats.hash);
						expect(entry.read()).toEqual([7, 9, 41]);
					}
				}
				if (outcome === 'released-owner') {
					entry.releaseAdmission();
					const refusedBuild = nextBuild((stats) => hasFactoryEffect(stats, 'feature4'));
					writeFileSync(join(root, 'feature.tsrx'), source(4));
					await refusedBuild;
					await expect(Promise.resolve().then(() => entry.update())).rejects.toThrow(
						/client build changed/,
					);
					expect(reloads).toBeGreaterThan(0);
					expect((globalThis as any).__octaneNativeHmrEffects).not.toContain('feature4');
					expect(entry.handles[0].get()).toBe(7);
					expect(entry.sibling()).toBe(41);
					return;
				}
				if (outcome === 'factory-error' || outcome === 'rollback-error') {
					const oldOwner = entry.owner();
					const oldBody = entry.componentBody();
					const oldBuild = entry.componentBuild();
					entry.rejectRemount = outcome === 'rollback-error';
					const failedBuild = nextBuild((stats) => hasFactoryEffect(stats, 'feature4'));
					writeFileSync(join(root, 'feature.tsrx'), source(4, { fail: true }));
					const failedStats = await failedBuild;
					await expect(applyBuild(entry, failedStats)).rejects.toThrow(
						outcome === 'rollback-error'
							? /client build changed/
							: /authored feature factory failed/,
					);
					expect(runtime.buildId).toBe(failedStats.hash);
					expect(() => entry.failedRead()).toThrow();
					expect(entry.sibling()).toBe(41);
					// Native plain self-acceptance stops in fail after a factory error.
					// Registry rollback does not override the bundler's lifecycle.
					expect(entry.status()).toBe('fail');
					await expect(Promise.resolve().then(() => entry.update())).rejects.toThrow(
						/check\(\) is only allowed in idle status/,
					);
					expect((globalThis as any)[Symbol.for('octane.hot-signals.execution')]).toBeUndefined();
					if (outcome === 'rollback-error') {
						expect(reloads).toBeGreaterThan(0);
					} else {
						expect(reloads).toBe(0);
						expect(entry.componentBody()).toBe(oldBody);
						expect(entry.componentBuild()).toBe(oldBuild);
						expect(oldOwner.retired).toBe(true);
						expect(entry.owner()).not.toBe(oldOwner);
						expect(entry.remounts).toBe(1);
						expect(() => entry.handles[0].get()).toThrow();
					}
					return;
				}
				const incompatible = [
					{ version: 4, options: { prefix: '// shifted declaration sites\n' }, changed: 'site' },
					{
						version: 5,
						options: { prefix: '// shifted declaration sites\n', hook: true },
						changed: 'slot',
					},
					{
						version: 6,
						options: { prefix: '// shifted declaration sites\n', hook: true, general: true },
						changed: 'factory',
					},
				] as const;
				for (const { version, options, changed } of incompatible) {
					const previous = manifest();
					const oldOwner = entry.owner();
					const oldHandles = entry.current();
					const changedBuild = nextBuild((stats) => hasFactoryEffect(stats, `feature${version}`));
					writeFileSync(join(root, 'feature.tsrx'), source(version, options));
					const stats = await changedBuild;
					await applyBuild(entry, stats);
					const current = manifest();
					const previousSites = previous.declarations.map((shape: any) => shape.site);
					const currentSites = current.declarations.map((shape: any) => shape.site);
					if (changed === 'site') expect(currentSites).not.toEqual(previousSites);
					else expect(currentSites).toEqual(previousSites);
					if (changed === 'slot') expect(current.hookSlots).not.toEqual(previous.hookSlots);
					if (changed === 'factory') {
						expect(current.hookSlots).toEqual(previous.hookSlots);
						expect(previous.declarations[1].factory).toBe('__derivedScalarAt');
						expect(current.declarations[1].factory).toBe('__derivedAt');
					}
					expect(oldOwner.retired).toBe(true);
					expect(entry.owner()).not.toBe(oldOwner);
					expect(() => oldHandles[0].get()).toThrow();
					expect(entry.current().map((handle: any) => handle.get())).toEqual([1, 1 + version]);
					expect(entry.sibling()).toBe(41);
					expect(entry.remounts).toBe(version - 3);
					expect(entry.transitions.slice(-2)).toEqual(['suspend', stats.hash]);
				}
				const finalOwner = entry.owner();
				const removedBuild = nextBuild((stats) => hasFactoryEffect(stats, 'feature7'));
				writeFileSync(join(root, 'feature.tsrx'), source(7, { removed: true, hook: true }));
				const removedStats = await removedBuild;
				await applyBuild(entry, removedStats);
				expect(runtime.buildId).toBe(removedStats.hash);
				expect(finalOwner.retired).toBe(true);
				expect(entry.remounts).toBe(4);
				expect(runtime.features.size).toBe(0);
				expect(runtime.executed.size).toBe(0);
				expect(manifest().declarations).toEqual([]);
				expect(entry.sibling()).toBe(41);
				const ordinaryBuild = nextBuild((stats) => hasFactoryEffect(stats, 'feature8'));
				writeFileSync(join(root, 'feature.tsrx'), source(8, { removed: true, hook: true }));
				const ordinaryStats = await ordinaryBuild;
				await applyBuild(entry, ordinaryStats);
				expect(runtime.buildId).toBe(ordinaryStats.hash);
				expect(entry.remounts).toBe(4);
				expect(runtime.executed.size).toBe(0);
				expect(reloads).toBe(0);
				const featureEffects = (globalThis as any).__octaneNativeHmrEffects.filter(
					(effect: string) => effect.startsWith('feature'),
				);
				expect(
					featureEffects.filter(
						(effect: string, index: number) => effect !== featureEffects[index - 1],
					),
				).toEqual([
					'feature1',
					'feature2',
					'feature3',
					'feature4',
					'feature5',
					'feature6',
					'feature7',
					'feature8',
				]);
				expect((globalThis as any).__octaneNativeHmrEffects).toEqual(
					expect.arrayContaining(['ordinary1', 'ordinary2']),
				);
				expect((globalThis as any)[Symbol.for('octane.hot-signals.execution')]).toBeUndefined();
			} finally {
				entry.dispose();
			}
		});
	},
	30_000,
);

it.each([
	['bootstrapped', 'direct'],
	['unbootstrapped', 'direct'],
	['bootstrapped', 'default-memo'],
	['unbootstrapped', 'default-memo'],
] as const)(
	'admits mounted native publishers in the %s document through %s exports',
	async (authority, exposure) => {
		const memo = exposure === 'default-memo';
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'octane-native-publisher-hmr-')));
		roots.push(root);
		writeFileSync(
			join(root, 'entry.cjs'),
			`
const { createRoot, flushSync } = require('octane');
const { earlySignalBootstrapScript } = require('octane/server');
const { bootstrapStreamedSignalHydration } = require('octane/hydration/streamed-signals');
let mounted, bridge;
exports.mount = function(bootstrap) {
  if (bootstrap) {
    document.head.insertAdjacentHTML('beforeend', earlySignalBootstrapScript());
    window.eval(document.querySelector('script[data-octane-stream]').textContent);
    bridge = bootstrapStreamedSignalHydration({
      buildId: __webpack_hash__, documentId: 'native-watch-document', target: window
    });
  }
  const { Host } = require('./host.tsrx');
  mounted = createRoot(document.querySelector('#app'), bridge ? { signalOwner: bridge.signalOwner } : {});
  flushSync(function() { mounted.render(Host, {}); });
};
exports.click = function(selector) { flushSync(function() { document.querySelector(selector).click(); }); };
exports.settle = function() { flushSync(function() {}); };
exports.update = function() { return module.hot.check(true); };
exports.runtime = function() { return __webpack_require__.__octaneHotSignalRuntime; };
exports.remote = function() { return require('./remote-a.tsrx').default; };
exports.dispose = function() { mounted?.unmount(); bridge?.dispose(); };
`,
		);
		writeFileSync(
			join(root, 'host.tsrx'),
			`
import { publisherBoundary, useState } from 'octane';
import ${memo ? 'RemoteA' : '{ RemoteA }'} from './remote-a.tsrx';
const Remote = publisherBoundary(RemoteA, { publisherKey: 'remote/Widget' });
function Sibling() @{
  const [value, setValue] = useState(41);
  <button data-sibling onClick={() => setValue(value + 1)}>{value}</button>
}
export function Host() @{
  const [value, setValue] = useState(5);
  <main>
    <button data-host onClick={() => setValue(value + 1)}>{value}</button>
    <Sibling />
    <Remote />
  </main>
}
`,
		);
		writeFileSync(
			join(root, 'remote-b.tsrx'),
			`
import { signal$ } from 'octane/signals';
export const count$ = signal$(100);
export function RemoteB() @{
  <button data-remote-b onClick={() => count$.set(count$.get() + 1)}>{count$.get()}</button>
}
globalThis.__octaneNativeHmrEffects.push('remoteB1');
`,
		);
		const source = (
			version: number,
			incompatible = false,
			failed = false,
		) => `${incompatible ? '// changed native declaration sites\n' : ''}
import { signal$, derived$ } from 'octane/signals';
import { RemoteB } from './remote-b.tsrx';
${memo ? "import { memo } from 'octane';" : ''}
export const count$ = signal$(1);
export const result$ = derived$(() => count$.get() + ${version}, { key: 'result', sync: true });
${memo ? 'function PrivateRemoteA' : 'export function RemoteA'}() @{
  <section data-remote-a>
    <button data-remote-increment onClick={() => count$.set(count$.get() + 1)}>increment</button>
    <output data-remote-count>{count$.get()}</output>
    <output data-remote-result>{result$.get()}</output>
    ${memo ? '<output data-remote-label>{label}</output>' : ''}
    <RemoteB />
  </section>
}
${
	memo
		? `const MemoRemote = memo(PrivateRemoteA);
const RemoteExport = MemoRemote;
export default RemoteExport;
const label = 'label${version}';`
		: ''
}
globalThis.__octaneNativeHmrEffects.push('remoteA${version}');
${failed ? "throw new Error('native publisher factory failed');" : ''}
`;
		writeFileSync(join(root, 'remote-a.tsrx'), source(1));
		const { JSDOM } = createRequire(import.meta.url)('jsdom');
		const dom = new JSDOM(
			'<!doctype html><html><head></head><body><div id="app"></div></body></html>',
			{
				url: 'http://localhost/',
				runScripts: 'outside-only',
				pretendToBeVisual: true,
			},
		);
		const names = [
			'window',
			'document',
			'Node',
			'Text',
			'NodeFilter',
			'HTMLElement',
			'Element',
			'Event',
			'CustomEvent',
			'MutationObserver',
			'requestAnimationFrame',
			'cancelAnimationFrame',
		] as const;
		const previous = new Map(
			names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
		);
		for (const name of names) {
			const value =
				name === 'requestAnimationFrame' || name === 'cancelAnimationFrame'
					? dom.window[name].bind(dom.window)
					: dom.window[name];
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
		}
		try {
			await withWatch(nativeCompiler(root), async (_first, nextBuild) => {
				(globalThis as any).__octaneNativeHmrEffects = [];
				let reloads = 0;
				(globalThis as any).location = {
					reload() {
						reloads++;
					},
				};
				const entry = createRequire(import.meta.url)(join(root, 'dist/entry.cjs'));
				try {
					entry.mount(authority === 'bootstrapped');
					const canonical = memo ? entry.remote().type : undefined;
					if (memo) expect(typeof canonical).toBe('function');
					const text = (selector: string) =>
						dom.window.document.querySelector(selector)?.textContent;
					expect(text('[data-remote-count]')).toBe('1');
					expect(text('[data-remote-result]')).toBe('2');
					if (memo) expect(text('[data-remote-label]')).toBe('label1');
					const host = dom.window.document.querySelector('[data-host]');
					const sibling = dom.window.document.querySelector('[data-sibling]');
					entry.click('[data-host]');
					entry.click('[data-sibling]');
					entry.click('[data-remote-increment]');
					entry.click('[data-remote-increment]');
					entry.click('[data-remote-b]');
					expect(text('[data-host]')).toBe('6');
					expect(text('[data-sibling]')).toBe('42');
					expect(text('[data-remote-count]')).toBe('3');
					expect(text('[data-remote-b]')).toBe('101');
					const runtime = entry.runtime();
					for (const version of memo ? [2, 3, 4] : [2, 3]) {
						const changedBuild = nextBuild((stats) => hasFactoryEffect(stats, `remoteA${version}`));
						writeFileSync(join(root, 'remote-a.tsrx'), source(version));
						const stats = await changedBuild;
						if (authority === 'unbootstrapped') {
							await expect(applyBuild(entry, stats)).rejects.toThrow(/client build changed/);
							expect(reloads).toBeGreaterThan(0);
							expect((globalThis as any).__octaneNativeHmrEffects).not.toContain(
								`remoteA${version}`,
							);
							expect(text('[data-remote-count]')).toBe('3');
							if (memo) expect(text('[data-remote-label]')).toBe('label1');
							return;
						}
						await applyBuild(entry, stats);
						entry.settle();
						expect(entry.runtime()).toBe(runtime);
						expect(text('[data-remote-count]')).toBe('3');
						expect(text('[data-remote-result]')).toBe(String(3 + version));
						if (memo) {
							expect(text('[data-remote-label]')).toBe(`label${version}`);
							// The reevaluated export must capture the admitted canonical inner
							// wrapper, not a fresh private wrapper created by this factory.
							expect(entry.remote().type).toBe(canonical);
						}
						// B was compiled in the initial generation and shares A's private
						// publisher. Rendering it after A changes must preserve its own grant.
						entry.click('[data-remote-b]');
						expect(text('[data-remote-b]')).toBe(String(100 + version));
						expect(dom.window.document.querySelector('[data-host]')).toBe(host);
						expect(dom.window.document.querySelector('[data-sibling]')).toBe(sibling);
						expect(text('[data-host]')).toBe('6');
						expect(text('[data-sibling]')).toBe('42');
					}
					const coldVersion = memo ? 5 : 4;
					const changedBuild = nextBuild((stats) =>
						hasFactoryEffect(stats, `remoteA${coldVersion}`),
					);
					writeFileSync(join(root, 'remote-a.tsrx'), source(coldVersion, true));
					await applyBuild(entry, await changedBuild);
					entry.settle();
					expect(text('[data-remote-count]')).toBe('1');
					expect(text('[data-remote-result]')).toBe(String(1 + coldVersion));
					if (memo) {
						expect(text('[data-remote-label]')).toBe(`label${coldVersion}`);
						expect(entry.remote().type).toBe(canonical);
					}
					expect(text('[data-remote-b]')).toBe('100');
					entry.click('[data-remote-b]');
					expect(text('[data-remote-b]')).toBe('101');
					expect(dom.window.document.querySelector('[data-host]')).toBe(host);
					expect(dom.window.document.querySelector('[data-sibling]')).toBe(sibling);
					expect(text('[data-host]')).toBe('6');
					expect(text('[data-sibling]')).toBe('42');
					const failedVersion = coldVersion + 1;
					const failedBuild = nextBuild((stats) =>
						hasFactoryEffect(stats, `remoteA${failedVersion}`),
					);
					writeFileSync(join(root, 'remote-a.tsrx'), source(failedVersion, true, true));
					await expect(applyBuild(entry, await failedBuild)).rejects.toThrow(
						/native publisher factory failed/,
					);
					entry.settle();
					// The failed generation retires this native publisher and restores
					// its last accepted component body before the queued scoped mount.
					expect(text('[data-remote-count]')).toBe('1');
					expect(text('[data-remote-result]')).toBe(String(1 + coldVersion));
					if (memo) {
						expect(text('[data-remote-label]')).toBe(`label${coldVersion}`);
					}
					expect(text('[data-remote-b]')).toBe('100');
					expect(dom.window.document.querySelector('[data-host]')).toBe(host);
					expect(dom.window.document.querySelector('[data-sibling]')).toBe(sibling);
					expect(text('[data-host]')).toBe('6');
					expect(text('[data-sibling]')).toBe('42');
					expect(
						(globalThis as any).__octaneNativeHmrEffects.filter(
							(effect: string) => effect === 'remoteB1',
						),
					).toHaveLength(1);
					expect(reloads).toBe(0);
				} finally {
					entry.dispose();
				}
			});
		} finally {
			for (const name of names) {
				const descriptor = previous.get(name);
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete (globalThis as any)[name];
			}
			dom.window.close();
		}
	},
	30_000,
);

// This exercises native Rspack compilation and hot application, independently
// of TSRX parsing. Compiler-result feature discovery has its own compiler tests.
it.each(['absent', 'initial', 'added', 'deferred', 'added-deferred'] as const)(
	'preserves feature-free HMR and fences %s signal feature execution',
	async (feature) => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'octane-native-hmr-')));
		roots.push(root);
		const deferred = feature === 'deferred' || feature === 'added-deferred';
		writeFileSync(
			join(root, 'entry.cjs'),
			`
${deferred ? "require('./ordinary.cjs');" : "require('./feature.cjs');"}
module.hot.accept('./ordinary.cjs', function() { require('./ordinary.cjs'); });
module.hot.accept('./feature.cjs', function() { ${deferred ? '' : "require('./feature.cjs');"} });
exports.startFeature = function() { require('./feature.cjs'); };
exports.update = function() { return module.hot.check(true); };
`,
		);
		writeFileSync(join(root, 'feature.cjs'), 'globalThis.__octaneNativeHmrEffects.push("first");');
		writeFileSync(
			join(root, 'ordinary.cjs'),
			'globalThis.__octaneNativeHmrEffects.push("ordinary1");',
		);
		let enabled = feature === 'initial' || feature === 'deferred';
		const compiler = rspack({
			mode: 'development',
			target: 'node',
			context: root,
			entry: './entry.cjs',
			devtool: false,
			output: { path: join(root, 'dist'), filename: 'entry.cjs', library: { type: 'commonjs2' } },
			plugins: [
				new rspack.HotModuleReplacementPlugin(),
				{
					apply(compiler: Compiler) {
						expect(
							compiler.options.plugins.some(
								(plugin) => plugin instanceof compiler.webpack.HotModuleReplacementPlugin,
							),
						).toBe(true);
						compiler.hooks.thisCompilation.tap('signal-fence-test', (compilation) => {
							compilation.hooks.additionalTreeRuntimeRequirements.tap(
								'signal-fence-test',
								(chunk, requirements) => {
									if (!enabled || !chunk.hasRuntime()) return;
									const modules = [...compilation.modules]
										.filter((module: any) => module.resource === join(root, 'feature.cjs'))
										.map((module) => ({ module }));
									requirements.add(rspack.RuntimeGlobals.interceptModuleExecution);
									requirements.add(rspack.RuntimeGlobals.moduleCache);
									requirements.add(rspack.RuntimeGlobals.global);
									requirements.add(rspack.RuntimeGlobals.getFullHash);
									compilation.addRuntimeModule(
										chunk,
										createStreamedSignalHmrRuntimeModule(compiler, compilation, modules),
									);
								},
							);
						});
					},
				},
			],
		})!;
		await withWatch(compiler, async (_first, nextBuild) => {
			(globalThis as any).__octaneNativeHmrEffects = [];
			let reloads = 0;
			(globalThis as any).location = {
				reload() {
					reloads++;
				},
			};
			const entry = createRequire(import.meta.url)(join(root, 'dist/entry.cjs'));
			expect((globalThis as any).__octaneNativeHmrEffects).toEqual([
				deferred ? 'ordinary1' : 'first',
			]);
			enabled ||= feature === 'added' || feature === 'added-deferred';
			const changedBuild = nextBuild();
			writeFileSync(
				join(root, deferred ? 'ordinary.cjs' : 'feature.cjs'),
				`globalThis.__octaneNativeHmrEffects.push("${deferred ? 'ordinary2' : 'second'}");`,
			);
			await changedBuild;
			if (deferred) {
				await entry.update();
				expect(reloads).toBe(0);
				expect((globalThis as any).__octaneNativeHmrEffects).toEqual(['ordinary1', 'ordinary2']);
				expect(() => entry.startFeature()).toThrow(/client build changed/);
				expect(reloads).toBeGreaterThan(0);
				expect((globalThis as any).__octaneNativeHmrEffects).toEqual(['ordinary1', 'ordinary2']);
			} else if (feature === 'absent') {
				await entry.update();
				expect(reloads).toBe(0);
				expect((globalThis as any).__octaneNativeHmrEffects).toEqual(['first', 'second']);
			} else {
				await expect(Promise.resolve().then(() => entry.update())).rejects.toThrow(
					/client build changed/,
				);
				expect(reloads).toBeGreaterThan(0);
				expect((globalThis as any).__octaneNativeHmrEffects).toEqual(['first']);
			}
		});
	},
);
