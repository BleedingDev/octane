// @vitest-environment node

import { parseModule } from '@tsrx/core';
import { transform } from 'esbuild';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { compile } from 'octane/compiler';
import { createOctaneCompiler } from '../../src/compiler/bundler.js';

const filename = '/src/Counter.tsrx';
const hookOnly = `import { useSignal$ } from 'octane/signals/client';
export function Counter() @{ const count$ = useSignal$(0); <button>{count$.get() as string}</button> }`;

function hot(source: string) {
	return compile(source, filename, { hmr: 'webpack', dev: true });
}

function callArguments(code: string, helper: string) {
	const ast = parseModule(code, filename);
	const calls: any[][] = [];
	const visit = (node: any) => {
		if (node === null || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (
			node.type === 'CallExpression' &&
			(node.callee.name === helper || node.callee.property?.name === helper)
		)
			calls.push(node.arguments);
		for (const [key, child] of Object.entries(node)) {
			if (!['start', 'end', 'loc', 'metadata'].includes(key)) visit(child);
		}
	};
	visit(ast);
	return calls;
}

describe('native hot signal compiler recipe', () => {
	it.each(
		[
			`export default memo(Counter);`,
			`const Alias = Counter; const Memo = memo(Alias); const Public = Memo; export { Public as default };`,
		].flatMap((expose) =>
			['private tsrx', 'private jsx', 'named tsrx'].map((shape) => ({ expose, shape })),
		),
	)(
		'preserves the canonical inner memo component across compiled $shape replacements: $expose',
		async ({ expose, shape }) => {
			const dom = new JSDOM('<main id="app"></main>');
			vi.stubGlobal('document', dom.window.document);
			vi.stubGlobal('window', dom.window);
			for (const name of [
				'Node',
				'Text',
				'Element',
				'HTMLElement',
				'DocumentFragment',
				'Comment',
			] as const)
				vi.stubGlobal(name, dom.window[name]);
			try {
				const [runtime, internal, signals] = await Promise.all([
					import('../../src/index.js'),
					import('../../src/internal/client.js'),
					import('../../src/signals/index.js'),
				]);
				const modules: Record<string, unknown> = {
					octane: runtime,
					'octane/internal/client': internal,
					'octane/signals': signals,
				};
				const data: Record<string, unknown> = {};
				let dispose: ((data: Record<string, unknown>) => void) | undefined;
				let invalidated = false;
				const hot = {
					data,
					dispose(callback: typeof dispose) {
						dispose = callback;
					},
					accept() {},
					invalidate() {
						invalidated = true;
					},
				};
				const load = async (version: number) => {
					dispose?.(data);
					const view = `<section><p>{label}</p><button onClick={() => setCount(count + 1)}>{count as string}</button></section>`;
					const compiled = compile(
						`import { memo, useState } from 'octane';
${shape === 'named tsrx' ? 'export ' : ''}function Counter() ${shape === 'private jsx' ? `{ const [count, setCount] = useState(0); return ${view}; }` : `@{ const [count, setCount] = useState(0); ${view} }`}
${expose}
const label = 'version ${version}';`,
						filename,
						{ hmr: 'webpack', dev: true },
					);
					const emitted = await transform(compiled.code, {
						loader: 'js',
						format: 'cjs',
						define: { 'import.meta.webpackHot': 'hot' },
					});
					const module = { exports: {} as { default: any } };
					Function(
						'require',
						'module',
						'exports',
						'hot',
						emitted.code,
					)(
						(name: string) => {
							if (!(name in modules)) throw new Error(`Unexpected compiled import ${name}`);
							return modules[name];
						},
						module,
						module.exports,
						hot,
					);
					return module.exports.default;
				};
				const initial = await load(1);
				const container = dom.window.document.querySelector('#app')!;
				const root = runtime.createRoot(container);
				try {
					runtime.flushSync(() => root.render(initial, {}));
					for (const version of [2, 3, 4]) {
						runtime.flushSync(() => container.querySelector('button')!.click());
						const fresh = await load(version);
						expect(container.querySelector('p')!.textContent).toBe(`version ${version}`);
						expect(container.querySelector('button')!.textContent).toBe(String(version - 1));
						expect(fresh.type).toBe(initial.type);
					}
					expect(initial.type[runtime.HMR]).toBeDefined();
					expect(invalidated).toBe(false);
				} finally {
					root.unmount();
				}
			} finally {
				vi.unstubAllGlobals();
				dom.window.close();
			}
		},
	);

	it.each([
		`import { memo } from 'foreign'; export default memo(Counter);`,
		`import { memo } from 'octane'; let Memo = memo(Counter); export default Memo;`,
		`export let Public = Counter; Public = other;`,
		`let Public; Public = Counter; export { Public };`,
		`export let Public; Public = Counter;`,
		`const [Public] = [Counter]; export { Public };`,
		`const { Public } = { Public: Counter }; export { Public };`,
		`let Public; for (Public of [Counter]) {} export { Public };`,
		`for (var Public of [Counter]) {} export { Public };`,
		`{ var Public = Counter; } export { Public };`,
		`if (condition) { var Public = Counter; } export { Public };`,
		`class Public { static Component = Counter; } export { Public };`,
		`namespace Holder { export const Public = Counter; } export default Holder.Public;`,
		`enum Holder { Public = Counter as any } export default Holder.Public;`,
		`namespace Holder { export const Public = Counter; } import Public = Holder.Public; export { Public };`,
		`import { memo } from 'octane'; export var Public = memo(Counter); Public = other;`,
		`import { memo } from 'octane'; export default condition ? memo(Counter) : Counter;`,
		`import { memo } from 'octane'; export default memo(...[Counter]);`,
		`import { memo } from 'octane'; export default memo(Counter, (left, right) => left.value === right.value);`,
		`export default decorate(Counter);`,
		`export default { Counter };`,
		`import { memo } from 'octane'; Counter = other; export default memo(Counter);`,
		`import { memo } from 'octane'; export default memo(function Inner() @{ <p>inner</p> });`,
		`function expose() { return Counter; } export default expose();`,
		`import { memo } from 'octane'; function expose() { return memo(Counter); } export const Public = expose();`,
		`export function expose() { return Counter; }`,
	])('retains the module fence for an unproven component export flow: %s', (expose) => {
		const source = `import { signal$ } from 'octane/signals'; const value$ = signal$(0);
function Counter() @{ <p>{value$.get() as string}</p> }
${expose}`;
		const result = hot(source);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
		expect(callArguments(result.code, '_$__signalAt')[0]).toHaveLength(2);
	});

	it.each([
		`import { memo as wrap } from 'octane'; const Memo = wrap(Counter); export default Memo;`,
		`import * as Octane from 'octane'; const Memo = Octane.memo(Counter); export default Memo;`,
	])('registers exact native memo export aliases: %s', (expose) => {
		const result = hot(`function Counter() @{ <p>memo</p> } ${expose}`);
		expect(result.hotSignalModule).toBeDefined();
		expect(callArguments(result.code, '_$__registerHotSignalComponent')).toHaveLength(1);
		expect(result.code).toContain('let Counter = _$hmr(');
	});

	it('retains the fence when a component escapes before its canonical wrapper exists', () => {
		const result = hot(`import { memo } from 'octane';
import { signal$ } from 'octane/signals'; const value$ = signal$(0);
const Captured = Counter;
function Counter() @{ <p>{value$.get() as string}</p> }
export default memo(Counter);`);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
		expect(callArguments(result.code, '_$__signalAt')[0]).toHaveLength(2);
	});

	it.each(['export', 'export default'])(
		'fences reassigned directly %s component roots',
		(expose) => {
			const result = hot(`import { signal$ } from 'octane/signals'; const value$ = signal$(0);
${expose} function Counter() @{ <p>{value$.get() as string}</p> }
Counter = other;`);
			expect(result.hotSignalModule).toBeUndefined();
			expect(result.code).not.toContain('__hotSignalModule');
			expect(callArguments(result.code, '_$__signalAt')[0]).toHaveLength(2);
		},
	);

	it('publishes an empty ordinary recipe when the last native feature is removed', () => {
		const ordinary = `export function Counter() @{ <p>ordinary</p> }`;
		const initial = hot(hookOnly);
		const removed = hot(ordinary);
		expect(initial.streamedSignals).toBe(true);
		expect(removed.streamedSignals).toBeUndefined();
		expect(removed.hotSignalModule).toEqual({
			version: 1,
			moduleId: filename,
			generation: expect.any(String),
			declarations: [],
			hookSlots: [],
		});
		expect(removed.hotSignalModule?.generation).not.toEqual(initial.hotSignalModule?.generation);
		expect(removed.code).toContain('__registerHotSignalComponent');
	});

	it('returns the exact hook-only module recipe and registers the canonical export after handoff', () => {
		const result = hot(hookOnly);
		expect(result.hotSignalModule).toEqual({
			version: 1,
			moduleId: filename,
			generation: expect.any(String),
			declarations: [],
			hookSlots: ['octane:/src/Counter.tsrx:Counter.useSignal$#0'],
		});
		expect(
			result.code.indexOf('_$__registerHotSignalComponent(_$hotSignalModule, Counter)'),
		).toBeGreaterThan(result.code.indexOf('_$webpackHot.accept()'));
		expect(result.code).toContain('_$__remountHotSignalComponent');
		expect(result.code).toContain('_$webpackHot.invalidate()');
		expect(hot(hookOnly).hotSignalModule).toEqual(result.hotSignalModule);
		expect(
			hot(hookOnly.replace('useSignal$(0)', 'useSignal$(1)')).hotSignalModule?.generation,
		).not.toEqual(result.hotSignalModule?.generation);
	});

	it('records actual facade node keys, producer factories and scopes without changing argument positions', () => {
		const result = hot(`import { signal$, derived$, query$ } from 'octane/signals';
const count$ = signal$(1);
const twice$ = derived$(() => count$.get() * 2, {key: 'twice'});
const queried$ = query$(() => count$.get(), async count => count * 3, {key: 'queried', kind: 'stream'});
export function Counter() @{ const local$ = signal$(2, {key: 'local'}); <p>{local$.get() as string}</p> }`);
		expect(result.hotSignalModule?.declarations).toEqual([
			{
				site: expect.stringMatching(/^g:/),
				key: expect.stringMatching(/^g:/),
				kind: 'signal',
				factory: '__signalAt',
				scope: 'document',
			},
			{
				site: expect.stringMatching(/^g:/),
				key: 'twice',
				kind: 'derived',
				factory: '__derivedScalarAt',
				scope: 'document',
			},
			{
				site: expect.stringMatching(/^g:/),
				key: 'g:queried',
				kind: 'async',
				factory: '__queryAt',
				scope: 'document',
				queryKind: 'stream',
			},
			{
				site: expect.stringMatching(/^i:/),
				key: 'local',
				kind: 'signal',
				factory: '__signalAt',
				scope: 'instance',
			},
		]);
		const signalCalls = callArguments(result.code, '_$__signalAt');
		expect(signalCalls).toHaveLength(2);
		expect(signalCalls[0]).toHaveLength(4);
		expect(signalCalls[0][2]).toMatchObject({ type: 'UnaryExpression', operator: 'void' });
		expect(signalCalls[0][3]).toMatchObject({ type: 'Identifier', name: '_$hotSignalModule' });
		expect(callArguments(result.code, '_$__derivedScalarAt')[0]).toHaveLength(4);
		expect(callArguments(result.code, '_$__queryAt')[0]).toHaveLength(5);
	});

	it('uses the precise producer recipe and hook table to distinguish incompatible module shapes', () => {
		const source = `import { derived$ } from 'octane/signals'; export const value$ = derived$(() => 1); export function Counter() @{ <p>{value$.get() as string}</p> }`;
		expect(hot(source).hotSignalModule?.declarations[0].factory).toBe('__derivedScalarAt');
		expect(
			hot(source.replace('() => 1', 'async () => 1')).hotSignalModule?.declarations[0].factory,
		).toBe('__derivedAt');
		const addedHook = hookOnly
			.replace(
				'export function Counter()',
				"import { useRef } from 'octane'; export function Counter()",
			)
			.replace('const count$', 'useRef(null); const count$');
		expect(hot(addedHook).hotSignalModule?.hookSlots).toEqual([
			'octane:/src/Counter.tsrx:Counter.useRef#0',
			'octane:/src/Counter.tsrx:Counter.useSignal$#1',
		]);
	});

	it.each([
		`signal$(1, options)`,
		`signal$(1, {key: dynamic})`,
		`signal$(1, {})`,
		`signal$(...values)`,
		`signal$(1, null, 'extra')`,
		`query$(() => 1, load, {key: 'query', kind: dynamic})`,
		`query$(() => 1, load, {key: 'query'})`,
		`query$(() => 1, load, {kind: 'promise'})`,
		`query$(() => 1, load, {key: 'query', get kind() { return 'promise'; }})`,
		`scope.signal$('other', 1)`,
		`makeScope('manual')`,
		`signals.createResource('manual', load)`,
		`signals[factory](1)`,
		`aliased(1)`,
		`new signal$(1, {key: 'constructed'})`,
		`new signals.signal$(1, {key: 'constructed'})`,
		`query$(0, 1)`,
		`query$(select, load)`,
		`scope.signal$.call(scope, 'manual', 1)`,
		`scope.signal$.bind(scope)`,
		`scope[method]('manual', 1)`,
		`(scope[method] as Function)('manual', 1)`,
	])('retains the whole-module fence for untracked or dynamic declaration %s', (declaration) => {
		const source = `import { signal$, query$, createScope as makeScope } from 'octane/signals';
import * as signals from 'octane/signals';
${declaration === 'aliased(1)' ? 'const aliased = signal$;' : ''}
const first$ = signal$(0);
const unsafe$ = ${declaration};
export function Counter() @{ <p>{first$.get() as string}</p> }`;
		const result = hot(source);
		expect(result.streamedSignals).toBe(true);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
		expect(callArguments(result.code, '_$__signalAt')[0]).toHaveLength(2);
	});

	it.each([
		`import { derived$ } from 'octane/signals'; const unsafe$ = new derived$(() => 1, {key: 'manual'});`,
		`import { query$ } from 'octane/signals'; const unsafe$ = new query$(() => 1, async () => 1, {key: 'manual', kind: 'promise'});`,
		`import { derived$ } from 'octane/signals'; const unsafe$ = derived$(0);`,
		`import { derived$ } from 'octane/signals'; const unsafe$ = derived$(compute);`,
		`import { __signalAt as manual } from 'octane/signals'; const unsafe$ = manual('g:manual', 1);`,
		`import { __derivedAt as manual } from 'octane/signals'; const unsafe$ = manual('g:manual', () => 1);`,
		`import { __derivedScalarAt as manual } from 'octane/signals'; const unsafe$ = manual('g:manual', () => 1);`,
		`import { __queryAt as manual } from 'octane/signals'; const unsafe$ = manual('g:manual', () => 1, async () => 1);`,
		`import * as signals from 'octane/signals'; const unsafe$ = signals.__signalAt('g:manual', 1);`,
		`const {signal$: manual} = scope; const unsafe$ = manual.call(scope, 'manual', 1);`,
		`const manual = scope.derived$.bind(scope); const unsafe$ = manual('manual', () => 1);`,
		`class Store { value$ = signal$(1, {key: 'manual'}); } const first = new Store(), second = new Store();`,
		`class Store { accessor value$ = signal$(1, {key: 'manual'}); } const first = new Store(), second = new Store();`,
		`for (let index = 0; index < 2; index++) { signal$(index, {key: 'manual'}); }`,
		`while (again()) { signal$(1, {key: 'manual'}); }`,
		`const unsafe$ = eval('signal$(1, {key: "manual"})');`,
		`const unsafe$ = (eval as Function)('signal$(1, {key: "manual"})');`,
		`const unsafe$ = eval!('signal$(1, {key: "manual"})');`,
		`const unsafe$ = (eval satisfies Function)('signal$(1, {key: "manual"})');`,
	])('fences escaped, constructed or malformed authored recipes %s', (recipe) => {
		const result = hot(`import { signal$ } from 'octane/signals';
const tracked$ = signal$(0);
${recipe}
export function Counter() @{ <p>{tracked$.get() as string}</p> }`);
		expect(result.streamedSignals).toBe(true);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
		expect(callArguments(result.code, '_$__signalAt')[0]).toHaveLength(2);
	});

	it('preserves one-time static field declarations and per-render instance recipes', () => {
		const result = hot(`import { signal$ } from 'octane/signals';
class Store { static value$ = signal$(1, {key: 'static'}); }
export function Counter() @{ for (const initial of [1, 2]) { signal$(initial, {key: 'local'}); } <p>{Store.value$.get() as string}</p> }`);
		expect(result.hotSignalModule?.declarations.map(({ scope, key }) => ({ scope, key }))).toEqual([
			{ scope: 'document', key: 'static' },
			{ scope: 'instance', key: 'local' },
		]);
	});

	it('retains the fence when separate sites share one resolved node key', () => {
		const result = hot(
			`import { signal$ } from 'octane/signals'; const first$ = signal$(1, {key: 'shared'}); const second$ = signal$(2, {key: 'shared'}); export function Counter() @{ <p>{first$.get() as string}</p> }`,
		);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
	});

	it('retains the fence across a top-level asynchronous module boundary', () => {
		for (const pause of ['await load();', 'for await (const item of stream) {}']) {
			const result = hot(
				`import { signal$ } from 'octane/signals'; const state$ = signal$(0); ${pause} export function Counter() @{ <p>{state$.get() as string}</p> }`,
			);
			expect(result.hotSignalModule).toBeUndefined();
			expect(result.code).not.toContain('__hotSignalModule');
		}
	});

	it('allocates collision-safe helper names and preserves namespace declaration imports', () => {
		const result = hot(`import * as signals from 'octane/signals';
const _$hotSignalModule = 1, _$__hotSignalModule = 2, _$__registerHotSignalComponent = 3, _$__remountHotSignalComponent = 4;
const count$ = signals.signal$(0);
export function Counter() @{ <p>{count$.get() as string}</p> }`);
		expect(result.hotSignalModule?.declarations).toHaveLength(1);
		expect(result.code).toContain('__hotSignalModule as _$__hotSignalModule$1');
		expect(callArguments(result.code, '__signalAt')[0][3]).toMatchObject({
			type: 'Identifier',
			name: '_$hotSignalModule$1',
		});
		expect(() => parseModule(result.code, filename)).not.toThrow();
	});

	it.each([
		{ hmr: false as const, dev: false },
		{ hmr: false as const, dev: true },
		{ hmr: true as const, dev: true },
		{ hmr: 'vite' as const, dev: true },
		{ hmr: 'webpack' as const, mode: 'server' as const },
	])('does not stamp unsupported execution mode %j', (options) => {
		const result = compile(hookOnly, filename, options);
		expect(result.hotSignalModule).toBeUndefined();
		expect(result.code).not.toContain('__hotSignalModule');
		expect(result.code).not.toContain('__registerHotSignalComponent');
	});

	it('forwards full-compiler recipes through the public bundler and fences plain helpers', () => {
		const compiler = createOctaneCompiler({ root: '/project' });
		const result = compiler.transform(hookOnly, '/project/src/Counter.tsrx', {
			hmr: 'webpack',
			dev: true,
		});
		expect(result?.hotSignalModule).toEqual(hot(hookOnly).hotSignalModule);
		const plain = compiler.transform(
			`import { signal$ } from 'octane/signals'; export const count$ = signal$(0);`,
			'/project/src/state.ts',
			{ hmr: 'webpack', dev: true },
		);
		expect(plain?.streamedSignals).toBe(true);
		expect(plain?.hotSignalModule).toBeUndefined();
	});
});
