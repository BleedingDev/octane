import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import rspack, { type Compiler, type Stats } from '@rspack/core';
import { expect, it } from 'vitest';
import { OctaneRspackPlugin } from '../src/index.js';

async function build(compiler: Compiler): Promise<Stats> {
	return new Promise((resolve, reject) => {
		compiler.run((error, stats) => {
			compiler.close((closeError) => {
				if (error || closeError) reject(error ?? closeError);
				else if (!stats || stats.hasErrors())
					reject(new Error(stats?.toString({ all: false, errors: true }) ?? 'Missing stats.'));
				else resolve(stats);
			});
		});
	});
}

it.each([
	'normal',
	'observer failure',
	'late admission',
	'failed candidate status',
	'external with plain host child',
	'external plain root with signal host child',
	'external rejects foreign signal child',
	'render-phase execution',
	'outside-owner ABI change',
])(
	'transfers a fresh graph with %s',
	async (scenario) => {
		const observerFailure = scenario === 'observer failure';
		const external = scenario.startsWith('external ');
		const plainRoot =
			scenario === 'external plain root with signal host child' ||
			scenario === 'outside-owner ABI change';
		const signalChild =
			scenario === 'external plain root with signal host child' ||
			scenario === 'external rejects foreign signal child';
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'octane-native-publisher-replacement-')));
		const require = createRequire(import.meta.url);
		const { JSDOM } = require('jsdom');
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
			'location',
		] as const;
		const saved = new Map(
			names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
		);
		let reloads = 0;
		for (const name of names) {
			const value =
				name === 'location'
					? {
							reload() {
								reloads++;
							},
						}
					: name === 'requestAnimationFrame' || name === 'cancelAnimationFrame'
						? dom.window[name].bind(dom.window)
						: dom.window[name];
			Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
		}
		let dispose: (() => void) | undefined;
		try {
			mkdirSync(join(root, 'node_modules'));
			symlinkSync(
				fileURLToPath(new URL('../../octane', import.meta.url)),
				join(root, 'node_modules/octane'),
			);
			writeFileSync(
				join(root, 'package.json'),
				JSON.stringify({ private: true, dependencies: { octane: '*' } }),
			);
			writeFileSync(
				join(root, 'host.tsrx'),
				`
import { useState } from 'octane';
export function Host(props) @{
  const [count, setCount] = useState(5);
  const First = props.first;
  const Second = props.second;
  const Ordinary = props.ordinary;
  if (props.duringRender) props.duringRender();
  <main>
    <button data-host onClick={() => setCount(count + 1)}>{count}</button>
    <div data-first><First late={props.late} /></div>
    <div data-second><Second late={props.late} /></div>
    @if (Ordinary) { <aside data-ordinary-owner><Ordinary /></aside> }
  </main>
}
`,
			);
			writeFileSync(
				join(root, 'host.cjs'),
				`
const runtime = exports.runtime = require('octane');
exports.signals = require('octane/signals');
exports.hydration = require('octane/hydration');
exports.streamedSignals = require('octane/hydration/streamed-signals');
exports.internal = require('octane/internal/client');
const { earlySignalBootstrapScript } = require('octane/server');
exports.HostChild = require('./host-child.tsrx').HostChild;
exports.errors = [];
let mounted, ordinaryRoot, bridge, boundary, second;
exports.mount = function(Remote, external = false, late) {
  document.head.insertAdjacentHTML('beforeend', earlySignalBootstrapScript());
  window.eval(document.querySelector('script[data-octane-stream]').textContent);
  bridge = exports.streamedSignals.bootstrapStreamedSignalHydration({ buildId: 'host-stream', documentId: 'replacement-document', target: window });
  const wrap = () => external ? runtime.externalSnapshotBoundary({
    authority: { publisherBuildId: 'remote-stream', runtimeABI: 1 },
    component: Remote,
    snapshot() { throw new Error('Client rendering must not call server transport.'); }
  }) : runtime.publisherBoundary(Remote, { publisherKey: 'remote/Widget' });
  boundary = wrap();
  second = wrap();
  mounted = runtime.createRoot(document.querySelector('#app'), { signalOwner: bridge.signalOwner, externalSnapshots: { documentId: 'replacement-document' }, onUncaughtError(error) { exports.errors.push(error); } });
  runtime.flushSync(() => mounted.render(require('./host.tsrx').Host, { first: boundary, second, late }));
};
exports.prepare = function() { return runtime.preparePublisherBoundaryReplacement(boundary); };
exports.late = function(late) { runtime.flushSync(() => mounted.render(require('./host.tsrx').Host, { first: boundary, second, late })); };
exports.ordinary = function(ordinary) { runtime.flushSync(() => mounted.render(require('./host.tsrx').Host, { first: boundary, second, ordinary })); };
exports.outside = function(ordinary) {
  const target = document.createElement('div');
  target.setAttribute('data-ordinary-owner', '');
  document.body.append(target);
  ordinaryRoot = runtime.createRoot(target);
  runtime.flushSync(() => ordinaryRoot.render(ordinary, {}));
};
exports.duringRender = function(duringRender) { runtime.flushSync(() => mounted.render(require('./host.tsrx').Host, { first: boundary, second, duringRender })); };
exports.click = function(selector) { runtime.flushSync(() => document.querySelector(selector).click()); };
exports.settle = function() { runtime.flushSync(() => {}); };
exports.dispose = function() { ordinaryRoot?.unmount(); mounted?.unmount(); bridge?.dispose(); };
`,
			);
			writeFileSync(
				join(root, 'host-child.tsrx'),
				`
import { useState } from 'octane';
${signalChild ? "import { signal$ } from 'octane/signals'; const child$ = signal$(31);" : ''}
export function HostChild() @{
  const [value, setValue] = useState(21);
  <button data-host-child onClick={() => setValue(value + 1)}>{value}${signalChild ? ':{child$.get()}' : ''}</button>
}
`,
			);
			const plugins = () => [
				new rspack.HotModuleReplacementPlugin(),
				new OctaneRspackPlugin({ root, environment: 'client', parallel: false }),
			];
			await build(
				rspack({
					mode: 'development',
					target: 'node',
					context: root,
					entry: './host.cjs',
					devtool: false,
					resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
					output: {
						path: join(root, 'host-dist'),
						filename: 'host.cjs',
						library: { type: 'commonjs2' },
					},
					plugins: plugins(),
				})!,
			);
			const host = require(join(root, 'host-dist/host.cjs'));
			dispose = host.dispose;
			const externals: Record<string, string> = {};
			for (const [request, property] of [
				['octane', 'runtime'],
				['octane/signals', 'signals'],
				['octane/hydration', 'hydration'],
				['octane/hydration/streamed-signals', 'streamedSignals'],
				['octane/internal/client', 'internal'],
			]) {
				const file = join(root, `shared-${property}.cjs`);
				writeFileSync(
					file,
					`module.exports = require(${JSON.stringify(join(root, 'host-dist/host.cjs'))}).${property};`,
				);
				externals[request!] = `commonjs ${file}`;
			}
			const source = (version: number, incompatible = false, fail = false) => `
import { useState } from 'octane';
import { signal$, derived$ } from 'octane/signals';
const count$ = signal$(1);
const result$ = derived$(() => count$.get() + ${version}, { key: 'result', sync: true });
export function Remote(props) @{
  ${incompatible ? 'const [added] = useState(99);' : ''}
  const [hookCount, setHookCount] = useState(7);
  const Late = props.late;
  <section data-remote>
    <button data-signal onClick={() => count$.set(count$.get() + 1)}>{count$.get()}</button>
    <button data-hook onClick={() => setHookCount(hookCount + 1)}>{hookCount}</button>
    <output data-result>{result$.get()}</output>
    <button data-observe onClick={() => { globalThis.__octaneReplacementStop = result$.subscribe(() => { if (globalThis.__octaneReplacementObserverError) throw globalThis.__octaneReplacementObserverError; }); }}>observe</button>
    ${incompatible ? '<output data-added>{added}</output>' : ''}
    @if (Late) { <Late /> }
  </section>
}
globalThis.__octaneReplacementExecutions.push(${version});
${fail ? "throw new Error('replacement factory failed');" : ''}
`;
			const plainSource = (version: number, returned = false) => `
import { useState } from 'octane';
export function Remote(props) @{
  ${returned ? 'if (props.returnNothing) return <aside>changed output</aside>;' : ''}
  const [value, setValue] = useState(7);
  const Child = props.late;
  <section data-remote data-version="${version}">
    <button data-hook onClick={() => setValue(value + 1)}>{value}</button>
    @if (Child) { <Child /> }
  </section>
}
globalThis.__octaneReplacementExecutions.push(${version});
`;
			writeFileSync(join(root, 'remote.tsrx'), plainRoot ? plainSource(1) : source(1));
			writeFileSync(
				join(root, 'late.tsrx'),
				`
import { signal$ } from 'octane/signals';
const late$ = signal$(11);
export function Late() @{
  <output data-late>{late$.get()}</output>
}
`,
			);
			const ordinarySource = (version: number) => `
import { useState } from 'octane';
export function Ordinary() @{
  const [count, setCount] = useState(9);
  <button data-ordinary onClick={() => setCount(count + 1)}>{count}:{${version}}</button>
}
`;
			writeFileSync(join(root, 'ordinary.tsrx'), ordinarySource(1));
			writeFileSync(
				join(root, 'control.cjs'),
				`exports.update = () => module.hot.check(true); exports.runtime = () => __webpack_require__.__octaneHotSignalRuntime;`,
			);
			writeFileSync(join(root, 'empty.cjs'), '');
			const remoteCompiler = (generation: string) =>
				rspack({
					mode: 'development',
					target: 'node',
					context: root,
					entry: './empty.cjs',
					devtool: false,
					externals,
					resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
					output: {
						path: join(root, generation),
						filename: 'entry.cjs',
						chunkFilename: '[name].cjs',
						uniqueName: generation,
						hashSalt: generation,
					},
					watchOptions: {
						aggregateTimeout: 0,
						poll: 20,
						ignored:
							/(?:[\\/](?:packages|node_modules)[\\/]octane[\\/]src|[\\/](?:first|second|failed|incompatible|host-dist))(?:[\\/]|$)/,
					},
					plugins: [
						...plugins(),
						// Rspack's built-in container exposes the actual init/get/factory
						// boundary without installing the enhanced federation coordinator.
						new rspack.container.ModuleFederationPluginV1({
							name: generation,
							filename: 'remote.cjs',
							library: { type: 'commonjs2' },
							exposes: {
								'./Widget': './remote.tsrx',
								'./Control': './control.cjs',
								'./Ordinary': './ordinary.tsrx',
								'./Late': './late.tsrx',
							},
						}),
					],
				})!;
			const executions: number[] = [];
			Object.assign(globalThis, { __octaneReplacementExecutions: executions });
			await build(remoteCompiler('first'));
			const first = require(join(root, 'first/remote.cjs'));
			await first.init({});
			const firstFactory = await first.get('./Widget');
			expect(executions).toEqual([]);
			const initial = firstFactory();
			const firstControl = (await first.get('./Control'))();
			expect(executions).toEqual([1]);
			host.mount(initial.Remote, external, external ? host.HostChild : undefined);
			const text = (selector: string) => dom.window.document.querySelector(selector)?.textContent;
			if (scenario === 'external rejects foreign signal child') {
				expect(host.errors).toHaveLength(1);
				expect(host.errors[0]).toBeInstanceOf(TypeError);
				expect(host.errors[0].message).toContain('External snapshot authority does not match');
				return;
			}
			expect(host.errors).toEqual([]);
			const hostButton = dom.window.document.querySelector('[data-host]');
			host.click('[data-host]');
			if (external) {
				const child = dom.window.document.querySelector('[data-first] [data-host-child]');
				host.click('[data-first] [data-host-child]');
				host.click('[data-first] [data-hook]');
				expect(text('[data-first] [data-host-child]')).toBe(signalChild ? '22:31' : '22');
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(dom.window.document.querySelector('[data-first] [data-host-child]')).toBe(child);
				expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
				expect(text('[data-host]')).toBe('6');
				expect(host.errors).toEqual([]);
				expect(reloads).toBe(0);
				return;
			}
			if (scenario === 'outside-owner ABI change') {
				host.outside(initial.Remote);
				host.click('[data-first] [data-hook]');
				host.click('[data-ordinary-owner] [data-hook]');
				const outside = dom.window.document.querySelector('[data-ordinary-owner] [data-hook]');
				const capability = host.prepare();
				writeFileSync(join(root, 'remote.tsrx'), plainSource(2, true));
				await build(remoteCompiler('incompatible'));
				const next = require(join(root, 'incompatible/remote.cjs'));
				await next.init({});
				const factory = await next.get('./Widget');
				expect(() => capability.execute(factory)).toThrow();
				expect(capability.commitStarted).toBe(false);
				host.settle();
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(text('[data-ordinary-owner] [data-hook]')).toBe('8');
				expect(dom.window.document.querySelector('[data-ordinary-owner] [data-hook]')).toBe(
					outside,
				);
				expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
				expect(text('[data-host]')).toBe('6');
				expect(host.errors).toEqual([]);
				expect(reloads).toBe(0);
				return;
			}
			host.click('[data-first] [data-signal]');
			host.click('[data-first] [data-hook]');
			host.click('[data-second] [data-hook]');
			expect(text('[data-first] [data-signal]')).toBe('2');
			expect(text('[data-first] [data-hook]')).toBe('8');
			expect(text('[data-second] [data-signal]')).toBe('1');
			if (scenario === 'render-phase execution') {
				const capability = host.prepare();
				let called = false;
				let failure: unknown;
				host.duringRender(() => {
					try {
						capability.execute(() => {
							called = true;
							return firstFactory();
						});
					} catch (error) {
						failure = error;
					}
				});
				expect(failure).toBeInstanceOf(TypeError);
				expect(called).toBe(false);
				expect(capability.commitStarted).toBe(false);
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
				expect(host.errors).toEqual([]);
				expect(reloads).toBe(0);
				return;
			}
			const asyncCapability = host.prepare();
			expect(asyncCapability.commitStarted).toBe(false);
			expect(() => asyncCapability.execute(async () => initial)).toThrow();
			expect(asyncCapability.commitStarted).toBe(false);
			expect(() => asyncCapability.execute(() => initial)).toThrow();
			if (scenario === 'late admission') {
				// Container loading may finish after another public component has
				// joined the same native owner. Reject before evaluating its factory.
				const stale = host.prepare();
				host.late((await first.get('./Late'))().Late);
				expect(text('[data-first] [data-late]')).toBe('11');
				let called = false;
				expect(() =>
					stale.execute(() => {
						called = true;
						return firstFactory();
					}),
				).toThrow();
				expect(called).toBe(false);
				expect(stale.commitStarted).toBe(false);
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(text('[data-first] [data-late]')).toBe('11');
				expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
				expect(reloads).toBe(0);
				return;
			}
			writeFileSync(join(root, 'remote.tsrx'), source(2, false, true));
			await build(remoteCompiler('failed'));
			const failed = require(join(root, 'failed/remote.cjs'));
			await failed.init({});
			const failedFactory = await failed.get('./Widget');
			expect(executions).toEqual([1]);
			const failedCapability = host.prepare();
			expect(() => failedCapability.execute(failedFactory)).toThrow('replacement factory failed');
			expect(failedCapability.commitStarted).toBe(false);
			host.settle();
			expect(text('[data-first] [data-signal]')).toBe('2');
			expect(text('[data-first] [data-hook]')).toBe('8');
			expect(text('[data-first] [data-result]')).toBe('3');
			if (scenario === 'failed candidate status') {
				const control = (await failed.get('./Control'))();
				expect(await control.update()).toBeNull();
				expect(reloads).toBe(0);
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(text('[data-first] [data-result]')).toBe('3');
				expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
				return;
			}
			writeFileSync(join(root, 'remote.tsrx'), source(3));
			const compiler = remoteCompiler('second');
			let completed: ((error: Error | null, stats?: Stats) => void) | undefined;
			const next = () =>
				new Promise<Stats>((resolve, reject) => {
					completed = (error, stats) =>
						error
							? reject(error)
							: !stats || stats.hasErrors()
								? reject(
										new Error(stats?.toString({ all: false, errors: true }) ?? 'Missing stats.'),
									)
								: resolve(stats);
				});
			const initialBuild = next();
			const watching = compiler.watch(compiler.options.watchOptions, (error, stats) =>
				completed?.(error, stats),
			);
			try {
				await initialBuild;
				const second = require(join(root, 'second/remote.cjs'));
				await second.init({});
				const control = (await second.get('./Control'))();
				const factory = await second.get('./Widget');
				expect(executions).toEqual([1, 2]);
				const capability = host.prepare();
				let replacement;
				if (observerFailure) {
					host.click('[data-first] [data-observe]');
					const error = new Error('replacement observer failed');
					Object.assign(globalThis, { __octaneReplacementObserverError: error });
					expect(() => capability.execute(() => (replacement = factory()))).toThrow(error);
					delete (globalThis as any).__octaneReplacementObserverError;
					(globalThis as any).__octaneReplacementStop();
				} else replacement = capability.execute(factory);
				expect(capability.commitStarted).toBe(true);
				expect(replacement.Remote).toBe(initial.Remote);
				expect(() => capability.execute(factory)).toThrow();
				// The retired container may still poll after reconnect. It has no
				// remaining native owner to fence or reload the host document.
				expect(await firstControl.update()).toBeNull();
				host.settle();
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(text('[data-second] [data-hook]')).toBe('8');
				expect(text('[data-first] [data-signal]')).toBe('2');
				expect(text('[data-first] [data-result]')).toBe('5');
				expect(text('[data-second] [data-result]')).toBe('4');
				expect(() => host.prepare().execute(factory)).toThrow();
				// An unadmitted pure-hook module in this same fresh runtime retains
				// ordinary HMR; native publisher admission must not fence its factory.
				host.ordinary((await second.get('./Ordinary'))().Ordinary);
				host.click('[data-ordinary]');
				expect(text('[data-ordinary]')).toBe('10:1');
				const changed = next();
				writeFileSync(join(root, 'remote.tsrx'), source(4));
				writeFileSync(join(root, 'ordinary.tsrx'), ordinarySource(2));
				const stats = await changed;
				for (let attempt = 0; attempt < 10 && control.runtime().buildId !== stats.hash; attempt++)
					await control.update();
				expect(control.runtime().buildId).toBe(stats.hash);
				host.settle();
				expect(text('[data-first] [data-hook]')).toBe('8');
				expect(text('[data-first] [data-signal]')).toBe('2');
				expect(text('[data-first] [data-result]')).toBe('6');
				expect(text('[data-ordinary]')).toBe('10:2');
			} finally {
				await new Promise<void>((resolve) => watching.close(resolve));
				await new Promise<void>((resolve, reject) =>
					compiler.close((error) => (error ? reject(error) : resolve())),
				);
			}
			writeFileSync(join(root, 'remote.tsrx'), source(5, true));
			await build(remoteCompiler('incompatible'));
			const incompatible = require(join(root, 'incompatible/remote.cjs'));
			await incompatible.init({});
			host.prepare().execute(await incompatible.get('./Widget'));
			host.settle();
			expect(text('[data-first] [data-hook]')).toBe('7');
			expect(text('[data-second] [data-hook]')).toBe('7');
			expect(text('[data-first] [data-signal]')).toBe('1');
			expect(text('[data-first] [data-added]')).toBe('99');
			expect(dom.window.document.querySelector('[data-host]')).toBe(hostButton);
			expect(text('[data-host]')).toBe('6');
			expect(reloads).toBe(0);
			const expired = host.prepare();
			host.dispose();
			dispose = undefined;
			let called = false;
			expect(() =>
				expired.execute(() => {
					called = true;
					return initial;
				}),
			).toThrow();
			expect(called).toBe(false);
		} finally {
			dispose?.();
			for (const name of names) {
				const descriptor = saved.get(name);
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else delete (globalThis as any)[name];
			}
			delete (globalThis as any).__octaneReplacementExecutions;
			delete (globalThis as any).__octaneReplacementObserverError;
			delete (globalThis as any).__octaneReplacementStop;
			delete (globalThis as any)[Symbol.for('octane.hot-signals.bridge')];
			delete (globalThis as any)[Symbol.for('octane.hot-signals.execution')];
			dom.window.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
