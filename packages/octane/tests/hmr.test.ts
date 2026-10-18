import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'octane/server';
import * as Signals from 'octane/signals';
import * as ClientSignals from 'octane/signals/client';
import {
	hmr,
	HMR,
	useState,
	flushSync,
	hydrateRoot,
	createRoot,
	componentSlot,
	type ComponentBody,
	type Scope,
} from '../src/index.js';
import { mount } from './_helpers';
import { loadCompiledFixtureSource, loadPlainHookFixtureSource } from './_server-fixture';
import { drainProducers } from './_fixtures/signals-async-controls';
import {
	admitHotSignalPublisher,
	createNativeHotSignalOwnerProof,
	type HotSignalExecutionFrame,
	type HotSignalRuntime,
} from '../src/signals/hot-declarations.js';

/**
 * Runtime tests for the `hmr(...)` wrapper. The focused unit cases use direct
 * component bodies; the structural regressions evaluate real compiler output.
 * Direct wrapper cases call `Foo[HMR].update(NewFoo)` manually; module-lifecycle
 * cases run the emitted handoff and the bundler's current accept callback.
 *
 * The component bodies here use the same `(props, scope, extra)` signature
 * the octane compiler emits. They follow the standard
 * "clear-range-then-insert" pattern that compiled bodies use on re-render.
 */

function clearBlockRange(scope: Scope): void {
	const block = scope.block;
	// Root blocks have null markers and own the whole parentNode; non-root
	// blocks own just the inclusive range between markers.
	if (!block.startMarker || !block.endMarker) {
		while (block.parentNode.firstChild) {
			block.parentNode.removeChild(block.parentNode.firstChild);
		}
		return;
	}
	let n: Node | null = block.startMarker.nextSibling;
	while (n && n !== block.endMarker) {
		const next: Node | null = n.nextSibling;
		block.parentNode.removeChild(n);
		n = next;
	}
}

interface TestHotContext {
	data?: Record<string, unknown>;
	dispose(callback: (data: Record<string, unknown>) => void): void;
	accept(callback?: (module: Record<string, ComponentBody<any>> | undefined) => void): void;
	invalidate(): void;
}

type HmrTestOptions = { hmr?: 'vite' | 'webpack'; hot?: TestHotContext };

async function compileHmrComponent(
	source: string,
	exportName = 'App',
	filename?: string,
	modules?: Record<string, Record<string, unknown>>,
	options?: HmrTestOptions,
): Promise<ComponentBody<any>> {
	return (await compileHmrModule(source, [exportName], filename, modules, options))[exportName];
}

/** Evaluates compiled output and returns the namespace of `exportNames`. */
async function compileHmrModule(
	source: string,
	exportNames: readonly string[],
	filename = '/src/App.tsrx',
	modules: Record<string, Record<string, unknown>> = {},
	options: HmrTestOptions = {},
): Promise<Record<string, any>> {
	const [{ compile }, runtime, internalRuntime, signals] = await Promise.all([
		import('octane/compiler'),
		import('../src/index.js'),
		import('octane/internal/client'),
		import('octane/signals'),
	]);
	const code = compile(source, filename, { hmr: options.hmr ?? 'webpack' }).code;
	// Export clauses name the module binding behind a renamed export, including
	// an anonymous default export, which has no authored binding.
	const locals = new Map<string, string>();
	for (const [, clause] of code.matchAll(/^export\s*\{([^}]*)\};?\s*$/gm)) {
		for (const specifier of clause.split(',')) {
			const [local, exported = local] = specifier.trim().split(/\s+as\s+/);
			if (local) locals.set(exported, local);
		}
	}
	const namespace = exportNames.map((name) => {
		if (name === 'default' && !locals.has(name)) {
			throw new Error('The compiled module has no default export binding');
		}
		return `${JSON.stringify(name)}: ${locals.get(name) ?? name}`;
	});
	const transformed =
		code
			.replace(
				/^import\s*\{([^}]*)\}\s*from\s*(['"])octane(\/internal\/client)?\2;/gm,
				(_match: string, imports: string, _quote: string, internal: string | undefined) => {
					const properties = imports
						.split(',')
						.map((specifier) => specifier.trim().replace(/\s+as\s+/, ': '))
						.join(', ');
					return `const { ${properties} } = ${internal ? 'internalRuntime' : 'runtime'};`;
				},
			)
			.replace(
				/^import\s*\{([\s\S]*?)\}\s*from\s*(['"])(\.\.?\/[^'"]+|octane\/signals)\2;/gm,
				(_match: string, imports: string, _quote: string, request: string) => {
					const properties = imports
						.split(',')
						.map((specifier) => specifier.trim().replace(/\s+as\s+/, ': '))
						.join(', ');
					return `const { ${properties} } = modules[${JSON.stringify(request)}];`;
				},
			)
			.replace(/\bexport (let|const) /g, '$1 ')
			// Verbatim return-JSX functions emit `function X … export { X };`
			// instead of `export let X = …`; drop the list form the same way.
			.replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
			.replaceAll('import.meta.webpackHot', 'hot')
			.replaceAll('import.meta.hot', 'hot') + `\nreturn { ${namespace.join(', ')} };`;
	const hot = options.hot ?? {
		data: undefined,
		dispose() {},
		accept() {},
		invalidate() {},
	};
	return Function(
		'runtime',
		'internalRuntime',
		'hot',
		'modules',
		transformed,
	)(runtime, internalRuntime, hot, { 'octane/signals': signals, ...modules });
}

/**
 * One webpack module across successive saves: each `load` runs the previous
 * evaluation's dispose handler, then evaluates the edit, which hands every
 * export to its canonical wrapper and invalidates when one declines.
 * `accepted` reports whether the latest evaluation is its own update boundary.
 */
function webpackHotModule(
	filename: string,
	compileOptions: Record<string, unknown> = {},
	runtimeModules: Record<string, Record<string, unknown>> = {},
) {
	const data: Record<string, unknown> = {};
	let dispose: ((data: Record<string, unknown>) => void) | undefined;
	const module = {
		accepted: false,
		invalidated: false,
		load(source: string, exportName = 'App'): ComponentBody<any> {
			dispose?.(data);
			dispose = undefined;
			module.accepted = false;
			return loadCompiledFixtureSource(source, {
				id: filename,
				mode: 'client',
				compileOptions: { hmr: 'webpack', ...compileOptions },
				runtimeModules: {
					'octane/signals': Signals,
					'octane/signals/client': ClientSignals,
					...runtimeModules,
				},
				importMeta: {
					webpackHot: {
						data,
						dispose(callback: (value: Record<string, unknown>) => void) {
							dispose = callback;
						},
						accept() {
							module.accepted = true;
						},
						invalidate() {
							module.invalidated = true;
						},
					},
				},
			})[exportName];
		},
	};
	return module;
}

describe('hmr — runtime wrapper', () => {
	it.each([
		{
			name: 'named block component',
			declaration: 'export function Counter() @{ BODY }',
			exported: 'Counter',
		},
		{
			name: 'component alias captured after canonical initialization',
			declaration:
				'export function Counter() @{ BODY } const Alias = Counter; export default Alias;',
			exported: 'default',
		},
		{
			name: 'named return-JSX component',
			declaration: 'export function Counter() { BODY }',
			exported: 'Counter',
			returned: true,
		},
		{
			name: 'anonymous default component',
			declaration: 'export default function() @{ BODY }',
			exported: 'default',
		},
		{
			name: 'private component captured by an immutable memo alias',
			declaration:
				"import { memo } from 'octane'; function Counter() @{ BODY } const Alias = Counter; export default memo(Alias);",
			exported: 'default',
			memoized: true,
		},
		{
			name: 'aliased native memo import',
			declaration:
				"import { memo as wrap } from 'octane'; function Counter() @{ BODY } const Memo = wrap(Counter); export default Memo;",
			exported: 'default',
			memoized: true,
		},
		{
			name: 'namespace native memo import',
			declaration:
				"import * as Octane from 'octane'; function Counter() @{ BODY } const Memo = Octane.memo(Counter); export default Memo;",
			exported: 'default',
			memoized: true,
		},
		{
			name: 'authored names resembling compiler temporaries',
			declaration:
				'const _$hotSignalModule = 1, _$__hotSignalModule = 2, _$__registerHotSignalComponent = 3, _$__remountHotSignalComponent = 4; export function Counter() @{ BODY }',
			exported: 'Counter',
		},
	])(
		'webpack module replacement preserves signal state through $name',
		async ({ name, declaration, exported, returned, memoized }) => {
			const source = (version: number) => {
				const button = `<button onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button>`;
				return (
					`import { useSignal$ } from 'octane/signals/client'; ` +
					declaration.replace(
						'BODY',
						`const count$ = useSignal$(0); ${returned ? 'return ' : ''}${button}${returned ? ';' : ''}`,
					)
				);
			};
			const hot = webpackHotModule(`/src/hot-signal-${name.replaceAll(' ', '-')}.tsrx`, {
				dev: true,
			});
			const initial = await hot.load(source(1), exported);
			const r = mount(initial);
			try {
				expect(hot.accepted).toBe(true);
				r.click('button');
				r.click('button');
				expect(r.find('button').textContent).toBe('v1:2');
				for (const version of [2, 3]) {
					const updated = await hot.load(source(version), exported);
					flushSync(() => {});
					// memo() creates an outer wrapper on each evaluation. Its public
					// type still captures the same canonical, stateful component.
					if (memoized)
						expect((updated as ComponentBody<any> & { type: ComponentBody<any> }).type).toBe(
							(initial as ComponentBody<any> & { type: ComponentBody<any> }).type,
						);
					else expect(updated).toBe(initial);
					expect(hot.accepted).toBe(true);
					expect(hot.invalidated).toBe(false);
					expect(r.find('button').textContent).toBe(`v${version}:${version}`);
					r.click('button');
					expect(r.find('button').textContent).toBe(`v${version}:${version + 1}`);
				}
			} finally {
				r.unmount();
			}
		},
	);

	it.each([
		{
			name: 'conditional local components',
			before: '',
			local: 'const Child = props.open ? Up : Down;',
			after: 'function Up() @{ <p>child:VERSION</p> } function Down() @{ <p>closed</p> }',
		},
		{
			name: 'helper declared after its caller',
			before: 'const labels = { Helper: true }; void labels.Helper;',
			local: 'const Child = Helper;',
			after: 'function Helper() @{ <p>child:VERSION</p> }',
		},
		{
			name: 'helper declared before its caller',
			before: 'function Helper() @{ <p>child:VERSION</p> }',
			local: 'const Child = Helper;',
			after: '',
		},
		{
			name: 'member helper evaluated only during rendering',
			before: 'const api = { read: () => Helper }; function deferred() { return api.read(); }',
			local: 'const Child = api.read();',
			after: 'function Helper() @{ <p>child:VERSION</p> }',
		},
		{
			name: 'getter evaluated only during rendering',
			before:
				'const api = { get component() { return Helper; } }; function deferred() { return api.component; }',
			local: 'const Child = api.component;',
			after: 'function Helper() @{ <p>child:VERSION</p> }',
		},
	])(
		'self-accepts deferred component references through $name',
		({ name, before, local, after }) => {
			const source = (version: number) => `import { useState } from 'octane';
${before.replaceAll('VERSION', String(version))}
export function App(props) @{ const [count, setCount] = useState(0); ${local}
<section><button onClick={() => setCount(count + 1)}>{'v${version}:' + count as string}</button><Child /></section> }
${after.replaceAll('VERSION', String(version))}`;
			const hot = webpackHotModule(`/src/deferred-${name.replaceAll(' ', '-')}.tsrx`, {
				dev: true,
			});
			const initial = hot.load(source(1));
			const r = mount(initial, { open: true });
			try {
				expect(hot.accepted).toBe(true);
				r.click('button');
				expect(r.find('button').textContent).toBe('v1:1');
				expect(r.find('p').textContent).toBe('child:1');
				expect(hot.load(source(2))).toBe(initial);
				flushSync(() => {});
				expect(hot.accepted).toBe(true);
				expect(hot.invalidated).toBe(false);
				expect(r.find('button').textContent).toBe('v2:1');
				expect(r.find('p').textContent).toBe('child:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:2');
			} finally {
				r.unmount();
			}
		},
	);

	it('retains state when an earlier exported component passes a later component as a prop', () => {
		const source = (version: number) => `import { useSignal$ } from 'octane/signals/client';
export function App() @{ <Slot component={Counter} /> }
function Slot(props) @{ const Child = props.component; <Child /> }
export function Counter() @{ const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button> }`;
		const hot = webpackHotModule('/src/deferred-component-prop.tsrx', { dev: true });
		const initial = hot.load(source(1));
		const r = mount(initial);
		try {
			expect(hot.accepted).toBe(true);
			r.click('button');
			r.click('button');
			expect(r.find('button').textContent).toBe('v1:2');
			expect(hot.load(source(2))).toBe(initial);
			flushSync(() => {});
			expect(hot.accepted).toBe(true);
			expect(hot.invalidated).toBe(false);
			expect(r.find('button').textContent).toBe('v2:2');
			r.click('button');
			expect(r.find('button').textContent).toBe('v2:3');
		} finally {
			r.unmount();
		}
	});

	it.each(['state', 'signal'] as const)(
		'retains %s state across ancestor edits after replacing a mounted child',
		(kind) => {
			const source = (version: number) => `import { useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ <main><Slot component={props.counter ? Counter : Placeholder} /><aside>host:v${version}</aside></main> }
function Slot(props) @{ const Child = props.component; <Child /> }
export function Placeholder() @{ <p>placeholder</p> }
export function Counter() @{ ${kind === 'state' ? 'const [count, setCount] = useState(0);' : 'const count$ = useSignal$(0);'} <button onClick={() => ${kind === 'state' ? 'setCount(count + 1)' : 'count$.set(count$.get() + 1)'}}>{'v${version}:' + ${kind === 'state' ? 'count' : 'count$.get()'} as string}</button> }`;
			const hot = webpackHotModule(`/src/retained-replaced-${kind}-child.tsrx`, { dev: true });
			const initial = hot.load(source(1));
			const owner = Signals.createScope({ scopeKey: `retained-replaced-${kind}-child` });
			const container = document.createElement('div');
			document.body.appendChild(container);
			const root = createRoot(container, { signalOwner: owner });
			const click = () => flushSync(() => container.querySelector('button')!.click());
			try {
				flushSync(() => root.render(initial, { counter: false }));
				expect(container.querySelector('p')!.textContent).toBe('placeholder');
				flushSync(() => root.render(initial, { counter: true }));
				expect(container.querySelector('p')).toBeNull();
				click();
				click();
				expect(container.querySelector('button')!.textContent).toBe('v1:2');
				for (const version of [2, 3]) {
					expect(hot.load(source(version))).toBe(initial);
					flushSync(() => {});
					expect(hot.invalidated).toBe(false);
					expect(container.querySelector('aside')!.textContent).toBe(`host:v${version}`);
					expect(container.querySelector('button')!.textContent).toBe(`v${version}:${version}`);
					click();
					expect(container.querySelector('button')!.textContent).toBe(`v${version}:${version + 1}`);
				}
			} finally {
				root.unmount();
				container.remove();
				owner.dispose();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'retains independent keyed descendants with %s hooks and retires removed children',
		(kind) => {
			const source = (version: number) => `import { useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ <section>@for (const label of props.labels; key label) { <Slot component={Counter} label={label} revision={props.revision} /> }</section> }
function Slot(props) @{ const Child = props.component; <Child label={props.label} key={props.revision} /> }
export function Counter(props) @{ ${kind === 'state' ? 'const [count, setCount] = useState(0);' : 'const count$ = useSignal$(0);'} <button data-label={props.label} onClick={() => ${kind === 'state' ? 'setCount(count + 1)' : 'count$.set(count$.get() + 1)'}}>{'v${version}:' + ${kind === 'state' ? 'count' : 'count$.get()'} as string}</button> }`;
			const hot = webpackHotModule(`/src/retained-${kind}-siblings.tsrx`, { dev: true });
			const initial = hot.load(source(1));
			const r = mount(initial, { labels: ['a', 'b'], revision: 0 });
			try {
				r.click('[data-label="a"]');
				r.click('[data-label="a"]');
				r.click('[data-label="b"]');
				expect(hot.load(source(2))).toBe(initial);
				flushSync(() => {});
				expect(hot.invalidated).toBe(false);
				expect(r.find('[data-label="a"]').textContent).toBe('v2:2');
				expect(r.find('[data-label="b"]').textContent).toBe('v2:1');
				r.update(initial, { labels: ['b', 'a'], revision: 0 });
				expect(r.findAll('button').map((button) => button.textContent)).toEqual(['v2:1', 'v2:2']);
				r.update(initial, { labels: ['b'], revision: 0 });
				expect(hot.load(source(3))).toBe(initial);
				flushSync(() => {});
				expect(r.findAll('button').map((button) => button.textContent)).toEqual(['v3:1']);
				r.update(initial, { labels: ['b', 'a'], revision: 0 });
				expect(r.find('[data-label="a"]').textContent).toBe('v3:0');
				r.update(initial, { labels: ['b', 'a'], revision: 1 });
				expect(r.findAll('button').map((button) => button.textContent)).toEqual(['v3:0', 'v3:0']);
				r.click('[data-label="b"]');
				expect(r.find('[data-label="b"]').textContent).toBe('v3:1');
			} finally {
				r.unmount();
			}
		},
	);

	it('retires retained descendants when the refreshed owner unmounts before rendering', () => {
		const source = (version: number) => `import { useState } from 'octane';
export function App() @{ <Counter /> }
export function Counter() @{ const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{'v${version}:' + count as string}</button> }`;
		const hot = webpackHotModule('/src/retained-aborted-owner.tsrx', { dev: true });
		const initial = hot.load(source(1));
		const r = mount(initial);
		r.click('button');
		expect(r.find('button').textContent).toBe('v1:1');
		hot.load(source(2));
		r.unmount();
		flushSync(() => {});
		const fresh = mount(initial);
		try {
			expect(fresh.find('button').textContent).toBe('v2:0');
			fresh.click('button');
			expect(fresh.find('button').textContent).toBe('v2:1');
		} finally {
			fresh.unmount();
		}
	});

	it('retains an unreached descendant while a refreshed Suspense boundary waits', async () => {
		const source = (version: number) => `import { use, useState } from 'octane';
export function App(props) @{ @try { const ready = use(props.ready); <Slot component={Counter} /> } @pending { <p>pending</p> } }
function Slot(props) @{ const Child = props.component; <Child /> }
export function Counter() @{ const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{'v${version}:' + count as string}</button> }`;
		const hot = webpackHotModule('/src/retained-suspense-descendant.tsrx', { dev: true });
		const initial = hot.load(source(1));
		const ready = Promise.resolve(true);
		await ready;
		const r = mount(initial, { ready });
		let resolve!: (value: boolean) => void;
		const pending = new Promise<boolean>((done) => {
			resolve = done;
		});
		try {
			await Promise.resolve();
			flushSync(() => {});
			r.click('button');
			r.click('button');
			r.update(initial, { ready: pending });
			expect(hot.load(source(2))).toBe(initial);
			flushSync(() => {});
			expect(r.find('p').textContent).toBe('pending');
			resolve(true);
			await pending;
			await Promise.resolve();
			flushSync(() => {});
			expect(hot.invalidated).toBe(false);
			expect(r.find('button').textContent).toBe('v2:2');
			r.click('button');
			expect(r.find('button').textContent).toBe('v2:3');
		} finally {
			resolve(true);
			r.unmount();
		}
	});

	it.each(['suspend', 'error'] as const)(
		'releases unmatched retained hooks after a later sibling causes %s recovery',
		async (failure) => {
			const source = (version: number, removed: boolean) => `import { use } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ @try { <><Counter label="kept" capture={props.capture} /><Gate gate={props.gate} />${removed ? '<Counter label="removed" capture={props.capture} />' : ''}</> } @pending { <p>pending</p> } @catch (error, reset) { <div><p>failed</p><button data-retry onClick={() => reset()}>retry</button></div> } }
function Gate(props) @{ if (props.gate.failure) throw props.gate.failure; const ready = use(props.gate.ready); <span>ready</span> }
export function Counter(props) @{ const count$ = useSignal$(0); props.capture(props.label, count$); <button data-label={props.label} onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button> }`;
			const hot = webpackHotModule(`/src/retained-later-${failure}.tsrx`, { dev: true });
			const initial = hot.load(source(1, true));
			const ready = Promise.resolve(true);
			await ready;
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			const gate: { ready: Promise<boolean>; failure?: Error | undefined } = { ready };
			const signals = new Map<string, ClientSignals.WritableSignal<number>>();
			const props = {
				gate,
				capture: (label: string, count: ClientSignals.WritableSignal<number>) => {
					signals.set(label, count);
				},
			};
			const r = mount(initial, props);
			try {
				await Promise.resolve();
				flushSync(() => {});
				r.click('[data-label="removed"]');
				r.click('[data-label="removed"]');
				const removed = signals.get('removed')!;
				if (failure === 'suspend') gate.ready = pending;
				else gate.failure = new Error('later sibling failed');
				expect(hot.load(source(2, false))).toBe(initial);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe(failure === 'suspend' ? 'pending' : 'failed');
				if (failure === 'suspend') {
					expect(removed.get()).toBe(2);
					resolve(true);
					await pending;
					await Promise.resolve();
				} else gate.failure = undefined;
				r.update(initial, props);
				if (failure === 'error') r.click('[data-retry]');
				flushSync(() => {});
				expect(r.findAll('button').map((button) => button.textContent)).toEqual(['v2:0']);
				// The removed hook's local signal owner must really be disposed,
				// rather than remaining parked after an abandoned commit callback.
				expect(() => removed.get()).toThrow(/disposed/i);
				expect(hot.load(source(3, true))).toBe(initial);
				flushSync(() => {});
				expect(hot.invalidated).toBe(false);
				expect(r.find('[data-label="removed"]').textContent).toBe('v3:0');
			} finally {
				resolve(true);
				r.unmount();
			}
		},
	);

	it.each([
		{ failure: 'suspend', hook: 'state', saves: 1 },
		{ failure: 'error', hook: 'state', saves: 1 },
		{ failure: 'suspend', hook: 'signal', saves: 1 },
		{ failure: 'error', hook: 'signal', saves: 1 },
		{ failure: 'suspend', hook: 'state', saves: 2 },
		{ failure: 'suspend', hook: 'signal', saves: 2 },
	] as const)(
		'reconciles claimed child $hook state when a later sibling causes $failure recovery after $saves saves',
		async ({ failure, hook, saves }) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const source = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ @try { <><Counter /><Gate gate={props.gate} /></> } @pending { <p>pending</p> } @catch (error, reset) { <div><p>failed</p><button data-retry onClick={() => reset()}>retry</button></div> } }
function Gate(props) @{ if (props.gate.failure) throw props.gate.failure; const ready = use(props.gate.ready); <span>ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const hot = webpackHotModule(`/src/retained-claimed-later-${failure}-${hook}-${saves}.tsrx`, {
				dev: true,
			});
			const initial = hot.load(source(1));
			const ready = Promise.resolve(true);
			await ready;
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			const gate: { ready: Promise<boolean>; failure?: Error | undefined } = { ready };
			const r = mount(initial, { gate });
			try {
				await Promise.resolve();
				flushSync(() => {});
				r.click('button');
				r.click('button');
				expect(r.find('button').textContent).toBe('v1:2');
				if (failure === 'suspend') gate.ready = pending;
				else gate.failure = new Error('later sibling failed');
				expect(hot.load(source(2))).toBe(initial);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe(failure === 'suspend' ? 'pending' : 'failed');
				if (saves === 2) {
					expect(hot.load(source(3))).toBe(initial);
					flushSync(() => {});
					expect(r.find('p').textContent).toBe('pending');
				}
				if (failure === 'suspend') {
					resolve(true);
					await pending;
					await Promise.resolve();
				} else gate.failure = undefined;
				r.update(initial, { gate });
				if (failure === 'error') r.click('[data-retry]');
				flushSync(() => {});
				expect(hot.invalidated).toBe(false);
				// A native catch reset remounts its primary; Suspense retries keep it.
				expect(r.find('button').textContent).toBe(`v${saves + 1}:${failure === 'error' ? 0 : 2}`);
				r.click('button');
				expect(r.find('button').textContent).toBe(`v${saves + 1}:${failure === 'error' ? 1 : 3}`);
			} finally {
				resolve(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'keeps retained %s state live after a pending restart rolls back at the root',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const source = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ <main>@try { <><Counter /><Gate wait={props.inner.wait} revision={props.revision} /></> } @pending { <p>inner pending</p> }<Gate wait={props.outer} revision={props.revision} /></main> }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const hot = webpackHotModule(`/src/retained-root-rollback-${hook}.tsrx`, { dev: true });
			const App = hot.load(source(1));
			let resolveInner!: (value: boolean) => void;
			let resolveOuter!: (value: boolean) => void;
			const innerWait = new Promise<boolean>((done) => {
				resolveInner = done;
			});
			const outerWait = new Promise<boolean>((done) => {
				resolveOuter = done;
			});
			const inner: { wait: Promise<boolean> | null } = { wait: null };
			const r = mount(App, { inner, outer: null, revision: 0 });
			try {
				r.click('button');
				r.click('button');
				inner.wait = innerWait;
				expect(hot.load(source(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('inner pending');
				// Restart the refreshed initial primary, then abandon that root render.
				r.update(App, { inner, outer: outerWait, revision: 1 });
				expect(r.find('p').textContent).toBe('inner pending');
				resolveInner(true);
				await innerWait;
				await Promise.resolve();
				flushSync(() => {});
				resolveOuter(true);
				await outerWait;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('button').textContent).toBe('v2:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:3');
			} finally {
				resolveInner(true);
				resolveOuter(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'queues retained %s updates without rendering into a pending owner',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); props.capture(() => setCount(count + 1)); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); props.capture(() => count$.set(count$.get() + 1)); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const source = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function App(props) @{ @try { <><Gate wait={props.gate.wait} /><Counter capture={props.capture} /></> } @pending { <p>pending</p> } }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
export function Counter(props) @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const hot = webpackHotModule(`/src/retained-pending-update-${hook}.tsrx`, { dev: true });
			const App = hot.load(source(1));
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			const gate: { wait: Promise<boolean> | null } = { wait: null };
			let increment!: () => void;
			const capture = (next: () => void) => {
				increment = next;
			};
			const r = mount(App, { gate, capture });
			try {
				r.click('button');
				r.click('button');
				gate.wait = pending;
				expect(hot.load(source(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('pending');
				increment();
				flushSync(() => {});
				expect(r.findAll('button')).toEqual([]);
				expect(r.find('p').textContent).toBe('pending');
				resolve(true);
				await pending;
				await Promise.resolve();
				r.update(App, { gate, capture });
				expect(r.find('button').textContent).toBe('v2:3');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:4');
			} finally {
				resolve(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'keeps nested retained %s state when its parent is hot-replaced while pending',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const childSource = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Child(props) @{ @try { <><Counter /><Gate wait={props.gate.wait} /></> } @pending { <p>child pending</p> } }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const childHot = webpackHotModule(`/src/nested-retained-child-${hook}.tsrx`, { dev: true });
			const Child = childHot.load(childSource(1), 'Child');
			const parentHot = webpackHotModule(
				`/src/nested-retained-parent-${hook}.tsrx`,
				{ dev: true },
				{ './child': { Child } },
			);
			const parentSource = (version: number) => `import { Child } from './child';
export function App(props) @{ <main><Child gate={props.gate} /><aside>parent v${version}</aside></main> }`;
			const App = parentHot.load(parentSource(1));
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			const gate: { wait: Promise<boolean> | null } = { wait: null };
			const r = mount(App, { gate });
			try {
				r.click('button');
				r.click('button');
				gate.wait = pending;
				expect(childHot.load(childSource(2), 'Child')).toBe(Child);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('child pending');
				expect(parentHot.load(parentSource(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('child pending');
				expect(r.find('aside').textContent).toBe('parent v2');
				resolve(true);
				await pending;
				await Promise.resolve();
				r.update(App, { gate });
				expect(r.find('button').textContent).toBe('v2:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:3');
			} finally {
				resolve(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'keeps nested retained %s state after editing its parent before its pending child',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const childSource = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Child(props) @{ @try { <><Counter /><Gate wait={props.gate.wait} /></> } @pending { <p>child pending</p> } }
function Gate(props) @{ if (props.wait) use(props.wait); <span>child ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const childHot = webpackHotModule(`/src/parent-first-retained-child-${hook}.tsrx`, {
				dev: true,
			});
			const Child = childHot.load(childSource(1), 'Child');
			const parentHot = webpackHotModule(
				`/src/parent-first-retained-parent-${hook}.tsrx`,
				{ dev: true },
				{ './child': { Child } },
			);
			const parentSource = (version: number) => `import { use } from 'octane';
import { Child } from './child';
function Gate(props) @{ if (props.wait) use(props.wait); <span>parent ready</span> }
export function App(props) @{ <main>@try { <><Child gate={props.childGate} /><Gate wait={props.parentGate.wait} revision={props.revision} /></> } @pending { <p data-parent-pending>parent pending</p> }<aside>parent v${version}</aside></main> }`;
			const App = parentHot.load(parentSource(1));
			let resolveParent!: (value: boolean) => void;
			let resolveChild!: (value: boolean) => void;
			const parentPending = new Promise<boolean>((done) => {
				resolveParent = done;
			});
			const childPending = new Promise<boolean>((done) => {
				resolveChild = done;
			});
			const parentGate: { wait: Promise<boolean> | null } = { wait: null };
			const childGate: { wait: Promise<boolean> | null } = { wait: null };
			const r = mount(App, { parentGate, childGate, revision: 0 });
			try {
				r.click('button');
				r.click('button');
				parentGate.wait = parentPending;
				expect(parentHot.load(parentSource(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('[data-parent-pending]').textContent).toBe('parent pending');
				childGate.wait = childPending;
				expect(childHot.load(childSource(2), 'Child')).toBe(Child);
				flushSync(() => {});
				r.update(App, { parentGate, childGate, revision: 1 });
				expect(r.find('[data-parent-pending]').textContent).toBe('parent pending');
				expect(r.find('aside').textContent).toBe('parent v2');
				resolveChild(true);
				await childPending;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('[data-parent-pending]').textContent).toBe('parent pending');
				resolveParent(true);
				await parentPending;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('button').textContent).toBe('v2:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:3');
			} finally {
				resolveParent(true);
				resolveChild(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'retains an unreached %s child through nested pending owner edits',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const childSource = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Child(props) @{ <section><Title />@try { <><Gate wait={props.gate.wait} /><Counter /></> } @pending { <p>child pending</p> }</section> }
export function Title() @{ const [count, setCount] = useState(0); <h2 onClick={() => setCount(count + 1)}>{'child v${version}:' + count as string}</h2> }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const childHot = webpackHotModule(`/src/unreached-nested-child-${hook}.tsrx`, { dev: true });
			const Child = childHot.load(childSource(1), 'Child');
			const parentHot = webpackHotModule(
				`/src/unreached-nested-parent-${hook}.tsrx`,
				{ dev: true },
				{ './child': { Child } },
			);
			const parentSource = (version: number) => `import { Child } from './child';
export function App(props) @{ <main><Child gate={props.gate} /><aside>parent v${version}</aside></main> }`;
			const App = parentHot.load(parentSource(1));
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			const gate: { wait: Promise<boolean> | null } = { wait: null };
			const r = mount(App, { gate });
			try {
				r.click('h2');
				expect(r.find('h2').textContent).toBe('child v1:1');
				r.click('button');
				r.click('button');
				gate.wait = pending;
				expect(parentHot.load(parentSource(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('child pending');
				expect(r.find('aside').textContent).toBe('parent v2');
				expect(childHot.load(childSource(2), 'Child')).toBe(Child);
				flushSync(() => {});
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('p').textContent).toBe('child pending');
				resolve(true);
				await pending;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('button').textContent).toBe('v2:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:3');
			} finally {
				resolve(true);
				r.unmount();
			}
		},
	);

	it.each(['state', 'signal'] as const)(
		'retains an outer-pool %s child after a later sibling suspends and restarts',
		async (hook) => {
			const counter =
				hook === 'state'
					? 'const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{PREFIX + count as string}</button>'
					: 'const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{PREFIX + count$.get() as string}</button>';
			const childSource = (version: number) => `import { use, useState } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Child(props) @{ <section data-revision={props.revision}><Title />@try { <><Gate wait={props.gate.wait} /><Counter /><LateGate wait={props.gate.later} /></> } @pending { <p>child pending</p> }</section> }
export function Title() @{ const [count, setCount] = useState(0); <h2 onClick={() => setCount(count + 1)}>{'child v${version}:' + count as string}</h2> }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
function LateGate(props) @{ if (props.wait) use(props.wait); <span>later ready</span> }
export function Counter() @{ ${counter.replace('PREFIX', `'v${version}:'`)} }`;
			const childHot = webpackHotModule(`/src/outer-pool-later-sibling-child-${hook}.tsrx`, {
				dev: true,
			});
			const Child = childHot.load(childSource(1), 'Child');
			const parentHot = webpackHotModule(
				`/src/outer-pool-later-sibling-parent-${hook}.tsrx`,
				{ dev: true },
				{ './child': { Child } },
			);
			const parentSource = (version: number) => `import { Child } from './child';
export function App(props) @{ <main><Child gate={props.gate} revision={props.revision} /><aside>parent v${version}</aside></main> }`;
			const App = parentHot.load(parentSource(1));
			let resolve!: (value: boolean) => void;
			const pending = new Promise<boolean>((done) => {
				resolve = done;
			});
			let resolveLater!: (value: boolean) => void;
			const laterPending = new Promise<boolean>((done) => {
				resolveLater = done;
			});
			const gate: { wait: Promise<boolean> | null; later: Promise<boolean> | null } = {
				wait: null,
				later: null,
			};
			const r = mount(App, { gate, revision: 0 });
			try {
				r.click('h2');
				expect(r.find('h2').textContent).toBe('child v1:1');
				r.click('button');
				r.click('button');
				gate.wait = pending;
				expect(parentHot.load(parentSource(2))).toBe(App);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('child pending');
				expect(r.find('aside').textContent).toBe('parent v2');
				expect(childHot.load(childSource(2), 'Child')).toBe(Child);
				flushSync(() => {});
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('p').textContent).toBe('child pending');
				gate.later = laterPending;
				resolve(true);
				await pending;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('p').textContent).toBe('child pending');
				r.update(App, { gate, revision: 1 });
				expect(r.find('section').getAttribute('data-revision')).toBe('1');
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('p').textContent).toBe('child pending');
				resolveLater(true);
				await laterPending;
				await Promise.resolve();
				flushSync(() => {});
				expect(r.find('h2').textContent).toBe('child v2:1');
				expect(r.find('button').textContent).toBe('v2:2');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:3');
			} finally {
				resolve(true);
				resolveLater(true);
				r.unmount();
			}
		},
	);

	it('retires a removed child signal after a pending root completes with a memoized owner', async () => {
		const source = (visible: boolean) => `import { useSignal$ } from 'octane/signals/client';
export function Widget(props) @{ <section>${visible ? '<Counter capture={props.capture} />' : 'removed'}</section> }
export function Counter(props) @{ const count$ = useSignal$(0); props.capture(count$); <button onClick={() => count$.set(count$.get() + 1)}>{count$.get() as string}</button> }`;
		const hot = webpackHotModule('/src/retained-memo-owner-removal.tsrx', { dev: true });
		const Widget = hot.load(source(true), 'Widget');
		const Host = await compileHmrComponent(
			`import { memo, use } from 'octane'; import { Widget } from './widget';
const MemoWidget = memo(Widget);
function Gate(props) @{ if (props.wait) use(props.wait); <aside>ready</aside> }
export function App(props) @{ <main><MemoWidget capture={props.capture} /><Gate wait={props.wait} /></main> }`,
			'App',
			'/src/retained-memo-owner-host.tsrx',
			{ './widget': { Widget } },
		);
		let count!: ClientSignals.WritableSignal<number>;
		const capture = (next: ClientSignals.WritableSignal<number>) => {
			count = next;
		};
		let resolve!: (value: boolean) => void;
		const pending = new Promise<boolean>((done) => {
			resolve = done;
		});
		const r = mount(Host, { capture, wait: null });
		try {
			r.click('button');
			r.click('button');
			r.update(Host, { capture, wait: pending });
			expect(hot.load(source(false), 'Widget')).toBe(Widget);
			flushSync(() => {});
			expect(r.find('section').textContent).toBe('removed');
			expect(r.findAll('button')).toEqual([]);
			expect(count.get()).toBe(2);
			resolve(true);
			await pending;
			await Promise.resolve();
			flushSync(() => {});
			expect(r.find('aside').textContent).toBe('ready');
			expect(r.find('section').textContent).toBe('removed');
			expect(() => count.get()).toThrow(/disposed/i);
		} finally {
			resolve(true);
			r.unmount();
		}
	});

	it('keeps parked state alive when its owner removal rolls back', async () => {
		const childSource = (version: number) => `import { use } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Child(props) @{ @try { <><Gate wait={props.gate.wait} /><Counter capture={props.capture} /></> } @pending { <p>child pending</p> } }
function Gate(props) @{ if (props.wait) use(props.wait); <span>ready</span> }
export function Counter(props) @{ const count$ = useSignal$(0); props.capture(count$); <button onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button> }`;
		const childHot = webpackHotModule('/src/retained-rolled-back-removal.tsrx', { dev: true });
		const Child = childHot.load(childSource(1), 'Child');
		const App = await compileHmrComponent(
			`import { use } from 'octane'; import { Child } from './child';
function Gate(props) @{ if (props.wait) use(props.wait); <span>outer ready</span> }
export function App(props) @{ <main>@if (props.show) { <Child gate={props.gate} capture={props.capture} /> }<Gate wait={props.outer} /></main> }`,
			'App',
			'/src/retained-removal-host.tsrx',
			{ './child': { Child } },
		);
		let resolve!: (value: boolean) => void;
		let resolveOuter!: (value: boolean) => void;
		const pending = new Promise<boolean>((done) => {
			resolve = done;
		});
		const outerWait = new Promise<boolean>((done) => {
			resolveOuter = done;
		});
		const gate: { wait: Promise<boolean> | null } = { wait: null };
		let count!: ClientSignals.WritableSignal<number>;
		const capture = (next: ClientSignals.WritableSignal<number>) => {
			count = next;
		};
		const r = mount(App, { show: true, gate, capture, outer: null });
		try {
			r.click('button');
			r.click('button');
			gate.wait = pending;
			expect(childHot.load(childSource(2), 'Child')).toBe(Child);
			flushSync(() => {});
			expect(r.find('p').textContent).toBe('child pending');
			r.update(App, { show: false, gate, capture, outer: outerWait });
			expect(r.find('p').textContent).toBe('child pending');
			expect(count.get()).toBe(2);
			// Cancel the suspended removal request; the visible owner never unmounted.
			r.update(App, { show: true, gate, capture, outer: null });
			resolve(true);
			await pending;
			await Promise.resolve();
			flushSync(() => {});
			expect(r.find('button').textContent).toBe('v2:2');
			r.click('button');
			expect(r.find('button').textContent).toBe('v2:3');
		} finally {
			resolve(true);
			resolveOuter(true);
			r.unmount();
		}
	});

	it('remounts ordinary caught primary state through the native reset capability', async () => {
		const App = await compileHmrComponent(`import { useState } from 'octane';
export function App(props) @{ @try { <><Counter /><Gate failure={props.failure} /></> } @catch (error, reset) { <div><p>failed</p><button data-retry onClick={() => reset()}>retry</button></div> } }
function Gate(props) @{ if (props.failure) throw new Error('later sibling failed'); <span>ready</span> }
function Counter() @{ const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{'count:' + count as string}</button> }`);
		const r = mount(App, { failure: false });
		try {
			r.click('button');
			r.click('button');
			expect(r.find('button').textContent).toBe('count:2');
			r.update(App, { failure: true });
			expect(r.find('p').textContent).toBe('failed');
			r.update(App, { failure: false });
			expect(r.find('p').textContent).toBe('failed');
			r.click('[data-retry]');
			expect(r.find('button').textContent).toBe('count:0');
			r.click('button');
			expect(r.find('button').textContent).toBe('count:1');
		} finally {
			r.unmount();
		}
	});

	it('replaces retained children after their helper changes from a borrowed range to a fragment', async () => {
		const children = await compileHmrModule(
			`import { useState } from 'octane';
export function Counter() @{ const [count, setCount] = useState(0); <button onClick={() => setCount(count + 1)}>{'count:' + count as string}</button> }
export function Alternate() @{ <button>alternate</button> }`,
			['Counter', 'Alternate'],
			'/src/retained-range-children.tsrx',
		);
		// Keep the invocation coordinate fixed while switching the compiler's
		// range hint. A source-level fragment edit also shifts template slot IDs,
		// which would test a different component identity instead of marker reuse.
		const slotBody =
			(fragment: boolean): ComponentBody<{ component: ComponentBody<any> }> =>
			(props, scope) => {
				const block = scope.block;
				let span = scope.slots[1] as HTMLSpanElement | undefined;
				if (fragment && span === undefined) {
					span = document.createElement('span');
					span.textContent = 'inside';
					block.parentNode.insertBefore(span, block.endMarker);
					scope.slots[1] = span;
				}
				componentSlot(
					scope,
					0,
					block.parentNode,
					props.component,
					{},
					'c:retained-range-child',
					fragment ? span : block.endMarker,
					false,
					!fragment,
				);
			};
		const Slot = hmr(slotBody(false));
		const App = await compileHmrComponent(
			`import { Slot, Counter, Alternate } from './children';
export function App(props) @{ <section>@if (props.visible) { <Slot component={props.alternate ? Alternate : Counter} /> }<aside>outside</aside></section> }`,
			'App',
			'/src/retained-borrowed-range-shape.tsrx',
			{ './children': { ...children, Slot } },
		);
		const visibleHtml = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');
		const r = mount(App, { visible: true, alternate: false });
		try {
			r.click('button');
			r.click('button');
			flushSync(() => {
				expect((Slot as any)[HMR].update(slotBody(true))).toBe(true);
			});
			expect(r.find('button').textContent).toBe('count:2');
			const fragmentLayout = visibleHtml(r.html()).replace('count:2', 'child');
			r.update(App, { visible: true, alternate: true });
			expect(r.findAll('button').map((button) => button.textContent)).toEqual(['alternate']);
			expect(visibleHtml(r.html()).replace('alternate', 'child')).toBe(fragmentLayout);
			expect(r.find('span').textContent).toBe('inside');
			expect(r.find('aside').textContent).toBe('outside');
			r.update(App, { visible: true, alternate: false });
			expect(r.findAll('button').map((button) => button.textContent)).toEqual(['count:0']);
			r.update(App, { visible: false, alternate: false });
			expect(r.findAll('button')).toEqual([]);
			expect(r.findAll('span')).toEqual([]);
			expect(r.find('aside').textContent).toBe('outside');
			const fresh = mount(App, { visible: true, alternate: false });
			try {
				fresh.update(App, { visible: false, alternate: false });
				expect(visibleHtml(r.html())).toBe(visibleHtml(fresh.html()));
			} finally {
				fresh.unmount();
			}
		} finally {
			r.unmount();
		}
	});

	it.each([
		'const Initial = Counter; capture(Initial);',
		'const Initial = (() => Counter)(); capture(Initial);',
		'const Initial = read(); function read() { return Counter; } capture(Initial);',
		'const api = { read: () => Counter }; const Initial = api.read(); capture(Initial);',
		'const api = { read: () => null }; api.read = () => Counter; const Initial = api.read(); capture(Initial);',
		'const api = { read: () => Counter }; const Initial = api["read"](); capture(Initial);',
		'const api = { get component() { return Counter; } }; const Initial = api.component; capture(Initial);',
		'const api = { nested: { read: () => Counter } }; const alias = api; const nested = alias.nested; const invoke = nested.read; const Initial = invoke(); capture(Initial);',
		'const api = { nested: { get component() { return Counter; } } }; const alias = api.nested; const Initial = alias.component; capture(Initial);',
	])('propagates an early hoisted component capture to its importer: %s', (capture) => {
		let captured: ComponentBody<any> | undefined;
		const hot = webpackHotModule(
			'/src/early-hoisted-capture.tsrx',
			{ dev: true },
			{
				'./capture': {
					capture: (component: ComponentBody<any>) => {
						captured = component;
					},
				},
			},
		);
		const source = (version: number) => `import { useSignal$ } from 'octane/signals/client';
import { capture } from './capture';
${capture}
export function Counter() @{ const count$ = useSignal$(0); <button onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button> }`;
		const importer = () =>
			loadCompiledFixtureSource(
				`import { Widget } from './widget'; export function Host() @{ <section><Widget /><span>host</span></section> }`,
				{
					id: '/src/early-capture-importer.tsrx',
					mode: 'client',
					runtimeModules: { './widget': { Widget: captured } },
				},
			)['Host'] as ComponentBody<any>;
		hot.load(source(1), 'Counter');
		expect(hot.accepted).toBe(false);
		const r = mount(importer());
		try {
			r.click('button');
			r.click('button');
			expect(r.find('button').textContent).toBe('v1:2');
			hot.load(source(2), 'Counter');
			expect(hot.accepted).toBe(false);
			// The raw pre-canonical alias cannot receive a safe component handoff.
			// Its importer must execute again instead of self-accepting stale UI.
			expect(r.find('button').textContent).toBe('v1:2');
			r.update(importer());
			expect(r.find('button').textContent).toBe('v2:0');
			r.click('button');
			expect(r.find('button').textContent).toBe('v2:1');
		} finally {
			r.unmount();
		}
	});

	it.each([
		{ declaration: 'export default memo(Counter);', exported: 'default' },
		{
			declaration:
				'const Alias = Counter; const Wrapped = memo(Alias); export { Wrapped as default };',
			exported: 'default',
		},
		{ declaration: 'export const Wrapped = memo(Counter);', exported: 'Wrapped' },
	])(
		'webpack propagates value exports instead of accepting a memo-only boundary: $declaration',
		async ({ declaration, exported }) => {
			const source = `import { memo } from 'octane'; function Counter() @{ <p>memo</p> } ${declaration}`;
			const hot = webpackHotModule(`/src/memo-propagation-${exported}-${declaration.length}.tsrx`, {
				dev: true,
			});
			await hot.load(source, exported);
			expect(hot.accepted).toBe(true);
			await hot.load(source + ` export const label = 'edited';`, exported);
			expect(hot.accepted).toBe(false);
		},
	);

	it.each([
		{
			name: 'unproven object export',
			before: '',
			after: 'export default { Counter };',
			exported: 'default',
			member: 'Counter',
		},
		{
			name: 'escape before canonicalization',
			before: 'const Captured = Counter;',
			after: 'export default memo(Counter);',
			exported: 'default',
		},
		{
			name: 'reassigned component export',
			before: '',
			after: 'let Public = Counter; Public = Counter; export { Public };',
			exported: 'Public',
		},
		{
			name: 'dynamic streamed query recipe',
			before:
				"const kind = 'stream'; const feed$ = query$(() => count$.get(), async function* (count) { yield count; }, { key: 'feed', kind });",
			after: 'export { Counter };',
			exported: 'Counter',
		},
		{
			name: 'top-level await',
			before: 'await Promise.resolve();',
			after: 'export { Counter };',
			exported: 'Counter',
		},
		{
			name: 'HMR disabled',
			before: '',
			after: 'export { Counter };',
			exported: 'Counter',
			options: { hmr: false as const },
		},
		{
			name: 'production compiler mode',
			before: '',
			after: 'export { Counter };',
			exported: 'Counter',
			options: { hmr: false as const, dev: false },
		},
		{
			name: 'bundler-neutral HMR compiler mode',
			before: '',
			after: 'export { Counter };',
			exported: 'Counter',
			options: { hmr: true as const, dev: true },
		},
		{
			name: 'vite compiler mode',
			before: '',
			after: 'export { Counter };',
			exported: 'Counter',
			options: { hmr: 'vite' as const },
		},
	])(
		'executes fenced $name as a fresh module without claiming hot admission',
		async ({ name, before, after, exported, member, options }) => {
			const [{ compile }, signals] = await Promise.all([
				import('octane/compiler'),
				import('octane/signals'),
			]);
			const id = `/src/fenced-${name.replaceAll(' ', '-')}.tsrx`;
			const source = `import { memo } from 'octane'; import { signal$, query$ } from 'octane/signals'; const count$ = signal$(1); ${before}
function Counter() @{ <button onClick={() => count$.set(count$.get() + 1)}>{count$.get() as string}</button> } ${after}`;
			const compileOptions = { hmr: 'webpack' as const, dev: true, ...options };
			expect(compile(source, id, compileOptions).hotSignalModule).toBeUndefined();
			const globals = globalThis as Record<symbol, unknown>;
			const executionKey = Symbol.for('octane.hot-signals.execution');
			const previous = globals[executionKey];
			const runtime: HotSignalRuntime = {
				modules: new Map(),
				features: new Set(['fenced']),
				executed: new Set(['fenced']),
				buildId: 'unadmitted',
				generationChanged: false,
			};
			try {
				for (const edited of [false, true]) {
					let accepted = false;
					// The module has no admitted recipe. Erroneous stamped output must fail
					// this real runtime fence rather than silently enrolling its declarations.
					globals[executionKey] = {
						runtime,
						executableId: 'fenced',
						buildId: runtime.buildId,
						manifests: [],
						hot: true,
						requiresAdmission: true,
					} satisfies HotSignalExecutionFrame;
					const namespace = await loadCompiledFixtureSource(
						source + (edited ? '\n// edited module' : ''),
						{
							id,
							mode: 'client',
							async: true,
							compileOptions,
							runtimeModules: { 'octane/signals': signals },
							importMeta: {
								webpackHot: {
									data: undefined,
									dispose() {},
									accept() {
										accepted = true;
									},
									invalidate() {
										throw new Error(
											'A fresh fenced module cannot invalidate a mounted predecessor',
										);
									},
								},
								hot: { data: undefined, dispose() {}, accept() {}, invalidate() {} },
							},
						},
					);
					delete globals[executionKey];
					const component = member ? namespace[exported][member] : namespace[exported];
					const owner = signals.createScope({ scopeKey: `${id}:document:${edited}` });
					const container = document.createElement('div');
					document.body.appendChild(container);
					const root = createRoot(container, { signalOwner: owner });
					try {
						flushSync(() => root.render(component));
						const button = container.querySelector('button')!;
						expect(button.textContent).toBe('1');
						flushSync(() => button.click());
						expect(button.textContent).toBe('2');
						if (name === 'unproven object export') expect(accepted).toBe(false);
					} finally {
						root.unmount();
						container.remove();
						owner.dispose();
					}
				}
			} finally {
				if (previous === undefined) delete globals[executionKey];
				else globals[executionKey] = previous;
			}
		},
	);

	it('executes server signal output without claiming a client hot module', async () => {
		const [{ compile }, signals] = await Promise.all([
			import('octane/compiler'),
			import('octane/signals'),
		]);
		const source = `import {signal$} from 'octane/signals'; const count$ = signal$(1); export function Counter() @{ <button>{count$.get() as string}</button> }`;
		const id = '/src/server-hot-signal.tsrx';
		const options = { hmr: 'webpack' as const, dev: true, mode: 'server' as const };
		expect(compile(source, id, options).hotSignalModule).toBeUndefined();
		const globals = globalThis as Record<symbol, unknown>;
		const executionKey = Symbol.for('octane.hot-signals.execution');
		const previous = globals[executionKey];
		const runtime: HotSignalRuntime = {
			modules: new Map(),
			features: new Set(['server']),
			executed: new Set(['server']),
			buildId: 'unadmitted',
			generationChanged: false,
		};
		try {
			for (const suffix of ['', '\n// reload']) {
				globals[executionKey] = {
					runtime,
					executableId: 'server',
					buildId: runtime.buildId,
					manifests: [],
					hot: true,
					requiresAdmission: true,
				} satisfies HotSignalExecutionFrame;
				const { Counter } = loadCompiledFixtureSource(source + suffix, {
					id,
					mode: 'server',
					compileOptions: options,
					runtimeModules: { 'octane/signals': signals },
				});
				delete globals[executionKey];
				expect(renderToString(Counter).html).toContain('<button>1</button>');
			}
		} finally {
			if (previous === undefined) delete globals[executionKey];
			else globals[executionKey] = previous;
		}
	});

	it.each([false, true])(
		'retries a suspended single root after a rolled-back reveal before hot replacement (boundary initially committed: %s)',
		async (committed) => {
			const source = (version: number) => `import { use } from 'octane';
import { useSignal$ } from 'octane/signals/client';
export function Widget(props) @{ const count$ = useSignal$(0); if (props.wait) use(props.wait); <button onClick={() => count$.set(count$.get() + 1)}>{'v${version}:' + count$.get() as string}</button> }`;
			const hot = webpackHotModule('/src/rolled-back-hot-single-root.tsrx', { dev: true });
			const initial = hot.load(source(1), 'Widget');
			const { App } = loadCompiledFixtureSource(
				`import { Suspense, use } from 'octane'; import { Widget } from './widget';
function Gate(props) @{ if (props.wait) use(props.wait); <i>gate</i> }
export function App(props) @{ <main><Suspense fallback={<p>pending</p>}><section>@if (props.show) { <><Widget wait={props.wait} /><i>row</i></> }<span>host</span></section></Suspense><Gate wait={props.gate} /></main> }`,
				{
					id: '/src/rolled-back-hot-host.tsrx',
					mode: 'client',
					runtimeModules: { './widget': { Widget: initial } },
				},
			);
			const never = new Promise<never>(() => {});
			const r = mount(App, { show: !committed, wait: committed ? null : never, gate: null });
			try {
				if (committed) r.update(App, { show: true, wait: never, gate: null });
				expect(r.find('p').textContent).toBe('pending');
				const pending = r.html();
				// Widget finishes its first insertion, then Gate suspends the root.
				// The discarded insertion must not remain the widget's live range.
				r.update(App, { show: true, wait: null, gate: never });
				expect(r.html()).toBe(pending);
				r.update(App, { show: true, wait: null, gate: null });
				expect(r.findAll('p')).toHaveLength(0);
				expect(r.find('button').textContent).toBe('v1:0');
				r.click('button');
				expect(r.find('button').textContent).toBe('v1:1');
				expect(hot.load(source(2), 'Widget')).toBe(initial);
				flushSync(() => {});
				expect(hot.accepted).toBe(true);
				expect(hot.invalidated).toBe(false);
				expect(r.find('button').textContent).toBe('v2:1');
				r.click('button');
				expect(r.find('button').textContent).toBe('v2:2');
			} finally {
				r.unmount();
			}
		},
	);

	it('retains admitted module signal state while rebinding derived and query producers', async () => {
		const [{ compile }, { createScope }] = await Promise.all([
			import('octane/compiler'),
			import('octane/signals'),
		]);
		const filename = '/remote/HotCounter.tsrx';
		const source = (version: number) => `import { signal$, derived$, query$ } from 'octane/signals';
const count$ = signal$(${version === 1 ? 1 : 9});
const total$ = derived$(() => count$.get() * ${version + 1}, { key: 'total' });
const result$ = query$(() => count$.get(), async count => count + ${version * 100}, { key: 'result', kind: 'promise' });
export function App() @{ <button onClick={() => count$.set(count$.get() + 1)}>{count$.get() + ':' + total$.get() + ':' + result$.get() as string}</button> }`;
		const runtime: HotSignalRuntime = {
			modules: new Map(),
			features: new Set(['counter']),
			executed: new Set(['counter']),
			buildId: 'build:1',
			generationChanged: false,
		};
		const hot = webpackHotModule(filename, { dev: true });
		const globals = globalThis as Record<symbol, any>;
		const executionKey = Symbol.for('octane.hot-signals.execution');
		const bridgeKey = Symbol.for('octane.hot-signals.bridge');
		const previous = globals[executionKey];
		const load = (version: number) => {
			const manifest = compile(source(version), filename, {
				hmr: 'webpack',
				dev: true,
			}).hotSignalModule!;
			expect(manifest.declarations.map(({ kind }) => kind)).toEqual(['signal', 'derived', 'async']);
			runtime.buildId = `build:${version}`;
			runtime.modules.set('counter', [manifest]);
			const frame: HotSignalExecutionFrame = {
				runtime,
				executableId: 'counter',
				buildId: runtime.buildId,
				manifests: [manifest],
				hot: version > 1,
				requiresAdmission: true,
			};
			globals[executionKey] = frame;
			try {
				if (frame.hot) frame.transaction = globals[bridgeKey].beforeFactory(frame);
				const component = hot.load(source(version));
				globals[bridgeKey].afterFactory(frame);
				return component;
			} catch (error) {
				globals[bridgeKey]?.abortFactory(frame);
				throw error;
			} finally {
				delete globals[executionKey];
			}
		};
		const owner = createScope({ scopeKey: 'hot-counter' });
		const container = document.createElement('div');
		document.body.appendChild(container);
		const root = createRoot(container, { signalOwner: owner });
		let release: (() => void) | undefined;
		try {
			const initial = await load(1);
			const { App } = loadCompiledFixtureSource(
				`import { Suspense } from 'octane'; import { Widget } from './widget'; export function App() @{ <Suspense fallback={<p>pending</p>}><section><Widget /><p>host</p></section></Suspense> }`,
				{
					id: '/src/HotHost.tsrx',
					mode: 'client',
					runtimeModules: { './widget': { Widget: initial } },
				},
			);
			flushSync(() => root.render(App));
			release = admitHotSignalPublisher(
				initial,
				createNativeHotSignalOwnerProof({
					publisherKey: 'hot/counter',
					documentId: 'hot-counter-document',
					ownerKey: owner.scopeKey,
					buildId: runtime.buildId,
					currentOwner: () => owner,
					acceptsComponent: (candidate) => candidate === initial,
					suspendIngress() {},
					rotateIngress() {},
					remount() {
						throw new Error('Compatible signal recipes must retain their owner');
					},
				}),
			);
			await drainProducers();
			flushSync(() => {});
			expect(container.querySelector('button')!.textContent).toBe('1:2:101');
			flushSync(() => container.querySelector('button')!.click());
			await drainProducers();
			flushSync(() => {});
			expect(container.querySelector('button')!.textContent).toBe('2:4:102');
			expect(await load(2)).toBe(initial);
			await drainProducers();
			flushSync(() => {});
			expect(hot.accepted).toBe(true);
			expect(hot.invalidated).toBe(false);
			expect(container.querySelector('button')!.textContent).toBe('2:6:202');
			flushSync(() => container.querySelector('button')!.click());
			await drainProducers();
			flushSync(() => {});
			expect(container.querySelector('button')!.textContent).toBe('3:9:203');
		} finally {
			release?.();
			root.unmount();
			container.remove();
			owner.dispose();
			if (previous === undefined) delete globals[executionKey];
			else globals[executionKey] = previous;
		}
	});

	it.each([
		{ dialect: 'vite', name: 'App', declaration: 'function App(props)' },
		{ dialect: 'webpack', name: 'App', declaration: 'function App(props)' },
		{ dialect: 'vite', name: 'module', declaration: 'function module(props)' },
		{ dialect: 'vite', name: '_$hmrModule', declaration: 'function _$hmrModule(props)' },
		// Anonymous default components, function or arrow, register under their export.
		{ dialect: 'vite', name: 'default', declaration: 'default function (props)' },
		{ dialect: 'webpack', name: 'default', declaration: 'default function (props)' },
		{ dialect: 'vite', name: 'default', declaration: 'default (props) =>' },
		{ dialect: 'webpack', name: 'default', declaration: 'default (props) =>' },
	] as const)(
		'preserves state and live events for export $declaration across consecutive $dialect replacements',
		async ({ dialect, name, declaration }) => {
			const data: Record<string, unknown> = {};
			let dispose: Parameters<TestHotContext['dispose']>[0] | undefined;
			let accept: Parameters<TestHotContext['accept']>[0];
			let invalidated = false;
			const load = async (version: number, incompatible = false) => {
				// The previous evaluation's callback receives this update. Vite then
				// keeps only the new evaluation's registration for the next save.
				const previousAccept = accept;
				dispose?.(data);
				dispose = undefined;
				accept = undefined;
				const App = await compileHmrComponent(
					`import { useState } from 'octane';
					 export ${declaration} @{
					   const [count, setCount] = useState(0);
					   ${incompatible ? "if (props.empty) return 'empty';" : ''}
					   <main><p>version ${version}</p><button onClick={() => setCount(count + 1)}>{count as string}</button></main>
					 }`,
					name,
					'/src/App.tsrx',
					{},
					{
						hmr: dialect,
						hot: {
							data,
							dispose(callback) {
								dispose = callback;
							},
							accept(callback) {
								accept = callback;
							},
							invalidate() {
								invalidated = true;
							},
						},
					},
				);
				flushSync(() => previousAccept?.({ [name]: App }));
				return App;
			};
			const r = mount(await load(1));
			try {
				r.click('button');
				r.click('button');
				for (const version of [2, 3, 4]) {
					await load(version);
					expect(r.find('p').textContent).toBe(`version ${version}`);
					expect(r.find('button').textContent).toBe(String(version));
					r.click('button');
					expect(r.find('button').textContent).toBe(String(version + 1));
				}
				expect(invalidated).toBe(false);
				if (dialect === 'vite') {
					// Vite supplies no namespace when evaluating an edit fails. Keep the
					// old boundary for recovery, but reload when its export disappears.
					accept?.(undefined);
					expect(invalidated).toBe(false);
					accept?.({});
					expect(invalidated).toBe(true);
					invalidated = false;
				}
				await load(5, true);
				expect(invalidated).toBe(true);
				expect(r.find('p').textContent).toBe('version 4');
				expect(r.find('button').textContent).toBe('5');
			} finally {
				r.unmount();
			}
		},
	);

	it.each(['constructor', '__proto__', 'toString'])(
		'can introduce an exported component named %s during a refresh',
		async (name) => {
			const hot: TestHotContext = {
				data: {},
				dispose() {},
				accept() {},
				invalidate() {
					throw new Error('Adding a component should not invalidate the existing boundary');
				},
			};
			const options = { hmr: 'vite' as const, hot };
			const initial = await compileHmrComponent(
				'export function App() @{ <p>before</p> }',
				'App',
				'/src/App.tsrx',
				{},
				options,
			);
			const r = mount(initial);
			let added: ReturnType<typeof mount> | undefined;
			try {
				const Added = await compileHmrComponent(
					`export function App() @{ <p>after</p> }
					 export function ${name}() @{ <p>added component</p> }`,
					name,
					'/src/App.tsrx',
					{},
					options,
				);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('after');
				added = mount(Added);
				expect(added.find('p').textContent).toBe('added component');
				await compileHmrComponent(
					`export function App() @{ <p>next revision</p> }
					 export function ${name}() @{ <p>updated addition</p> }`,
					name,
					'/src/App.tsrx',
					{},
					options,
				);
				flushSync(() => {});
				expect(r.find('p').textContent).toBe('next revision');
				expect(added.find('p').textContent).toBe('updated addition');
			} finally {
				added?.unmount();
				r.unmount();
			}
		},
	);

	it.each([
		['a declaration', 'label', (label: string) => `export const label = '${label}';`],
		[
			'a renamed binding',
			'value',
			(label: string) => `const value = '${label}';\nexport { value as label };`,
		],
		[
			'a destructuring',
			'label',
			(label: string) => `export const { label } = { label: '${label}' };`,
		],
	])(
		'sends a value exported by %s beside a component to its Vite importers',
		async (_form, local, exportLabel) => {
			let accept: Parameters<TestHotContext['accept']>[0];
			let invalidations = 0;
			const hot: TestHotContext = {
				data: {},
				dispose() {},
				accept(callback) {
					accept = callback;
				},
				invalidate() {
					invalidations++;
				},
			};
			const load = async (label: string, prefix: string) => {
				const previousAccept = accept;
				const module = await compileHmrModule(
					`${exportLabel(label)}
					 export function App() @{ <p>{'${prefix} ' + ${local}}</p> }`,
					['App', 'label'],
					'/src/App.tsrx',
					{},
					{ hmr: 'vite', hot },
				);
				flushSync(() => previousAccept?.(module));
				return module;
			};
			const r = mount((await load('v1', 'first'))['App']);
			try {
				// Importers still hold the previous evaluation's bindings. An unchanged
				// value keeps them current, so the module stays its own boundary.
				await load('v1', 'second');
				expect(r.find('p').textContent).toBe('second v1');
				expect(invalidations).toBe(0);
				// A changed value must propagate the update to those importers.
				await load('v2', 'second');
				expect(r.find('p').textContent).toBe('second v2');
				expect(invalidations).toBe(1);
			} finally {
				r.unmount();
			}
		},
	);

	it('lets webpack re-execute the importers of a module exporting values beside a component', async () => {
		const hot = webpackHotModule('/src/App.tsrx');
		const source = (label: string) =>
			`export const label = '${label}';
			 export function App() @{ <p>{label as string}</p> }`;
		const App = await hot.load(source('v1'));
		const r = mount(App);
		try {
			// A replacement cannot see what its importers last read, and comparing
			// against its previous evaluation would invalidate every re-execution.
			expect(hot.accepted).toBe(false);
			expect(await hot.load(source('v2'))).toBe(App);
			flushSync(() => {});
			expect(r.find('p').textContent).toBe('v2');
			expect(hot.accepted).toBe(false);
			expect(hot.invalidated).toBe(false);
		} finally {
			r.unmount();
		}
		// Another name for a component exports the same handed-off wrapper.
		const aliased = webpackHotModule('/src/Aliased.tsrx');
		await aliased.load(`export function App() @{ <p>app</p> }\nexport { App as Main };`);
		expect(aliased.accepted).toBe(true);
	});

	it('renders the initial component body', () => {
		const Foo = hmr(((_props: any, scope: Scope, _extra: any) => {
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf';
			root.textContent = 'initial';
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		}) as ComponentBody<any>);
		const r = mount(Foo);
		expect(r.find('.leaf').textContent).toBe('initial');
		r.unmount();
	});

	it('exposes the HMR meta via the HMR Symbol', () => {
		const Foo = hmr(((_scope: Scope, _props: any, _extra: any) => {}) as ComponentBody<any>);
		const meta = (Foo as any)[HMR];
		expect(meta).toBeDefined();
		expect(typeof meta.update).toBe('function');
		expect(meta.liveBlocks instanceof Set).toBe(true);
	});

	it('declines a handoff for a hookless inline child so the bundler can reload safely', async () => {
		// A same-module hookless child renders into its parent's element without a
		// range of its own, so there is nothing its replacement could reset.
		const source = (version: number) =>
			`export function Leaf() @{ <b>leaf v${version}</b> }
			 export function App() @{ <div><Leaf /></div> }`;
		const hot = webpackHotModule('/src/App.tsrx');
		const r = mount(await hot.load(source(1)));
		try {
			expect(r.find('b').textContent).toBe('leaf v1');
			await hot.load(source(2));
			expect(hot.invalidated).toBe(true);
		} finally {
			r.unmount();
		}
	});

	it('forwards direct calls verbatim and keeps later hot updates working', () => {
		const calls: unknown[][] = [];
		const initial = function (this: unknown, ...args: unknown[]) {
			calls.push([this, ...args]);
			return `v1/${args.length}`;
		};
		const renderRow = hmr(initial as unknown as ComponentBody<any>) as unknown as (
			...args: unknown[]
		) => unknown;
		let blockReads = 0;
		const lookalike = {
			get block() {
				blockReads++;
				return undefined;
			},
		};
		const receiver = { renderRow };

		// Arguments in the render-call positions are ordinary values here: an
		// index, a null placeholder while nothing renders, or an object whose
		// `block` getter belongs to the caller.
		expect(renderRow('a', 0)).toBe('v1/2');
		expect(renderRow('b', null)).toBe('v1/2');
		expect(renderRow('c', lookalike, 'x', 'y')).toBe('v1/4');
		expect(receiver.renderRow('d')).toBe('v1/1');
		expect(calls).toEqual([
			[undefined, 'a', 0],
			[undefined, 'b', null],
			[undefined, 'c', lookalike, 'x', 'y'],
			[receiver, 'd'],
		]);
		expect(blockReads).toBe(0);

		const next = (...args: unknown[]) => `v2/${args.join(',')}`;
		expect((renderRow as any)[HMR].update(hmr(next as unknown as ComponentBody<any>))).toBe(true);
		expect(renderRow('e', 1, 'x', 'y')).toBe('v2/e,1,x,y');
	});

	it('update() swaps the body of live blocks + re-renders', () => {
		const v1: ComponentBody<any> = ((_props: any, scope: Scope, _extra: any) => {
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf v1';
			root.textContent = 'A';
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		}) as ComponentBody<any>;
		const v2: ComponentBody<any> = ((_props: any, scope: Scope, _extra: any) => {
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf v2';
			root.textContent = 'B';
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		}) as ComponentBody<any>;

		const Foo = hmr(v1);
		const r = mount(Foo);
		expect(r.find('.leaf').textContent).toBe('A');
		expect(r.find('.leaf').classList.contains('v1')).toBe(true);

		// Simulate what `import.meta.hot.accept` does: hand `update` a wrapper
		// built around the new fn. The wrapper unwraps before storing.
		const NewFoo = hmr(v2);
		flushSync(() => {
			(Foo as any)[HMR].update(NewFoo);
		});
		expect(r.find('.leaf').textContent).toBe('B');
		expect(r.find('.leaf').classList.contains('v2')).toBe(true);

		r.unmount();
	});

	it('replaces compiled static output while preserving hook state', async () => {
		const initial = await compileHmrComponent(`
			import { useState } from 'octane';
			export function App(props) @{
				const [count, setCount] = useState(0);
				props.expose(setCount);
				<main><p id="lede">before</p><output>{count as string}</output></main>
			}
		`);
		const updated = await compileHmrComponent(`
			import { useState } from 'octane';
			export function App(props) @{
				const [count, setCount] = useState(0);
				props.expose(setCount);
				<main><p id="lede">after</p><output>{count as string}</output></main>
			}
		`);
		let setCount!: (value: number | ((current: number) => number)) => void;
		const r = mount(initial, { expose: (setter: typeof setCount) => (setCount = setter) });
		flushSync(() => setCount(7));

		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(r.find('#lede').textContent).toBe('after');
		expect(r.find('output').textContent).toBe('7');
		r.unmount();
	});

	it('replaces compiled static output after hydration', async () => {
		const initial = await compileHmrComponent(`
			export function App() @{
				<main><p id="lede">before</p></main>
			}
		`);
		const updated = await compileHmrComponent(`
			export function App() @{
				<main><p id="lede">after</p></main>
			}
		`);
		const container = document.createElement('div');
		container.innerHTML = '<main><p id="lede">before</p></main>';
		document.body.appendChild(container);
		const adopted = container.firstElementChild;
		const root = hydrateRoot(container, initial);
		flushSync(() => {});
		expect(container.firstElementChild).toBe(adopted);

		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(container.querySelector('#lede')?.textContent).toBe('after');
		root.unmount();
		container.remove();
	});

	it('mounts a component call introduced by a compiled update', async () => {
		const initial = await compileHmrComponent(`
			export function App() @{
				<main><h1>octane</h1></main>
			}
		`);
		const updated = await compileHmrComponent(`
			function Child() @{
				<p id="child">CHILD ONE</p>
			}
			export function App() @{
				<main><h1>octane</h1><Child /></main>
			}
		`);
		const r = mount(initial);

		expect(() => {
			flushSync(() => {
				expect((initial as any)[HMR].update(updated)).toBe(true);
			});
		}).not.toThrow();

		expect(r.find('#child').textContent).toBe('CHILD ONE');
		r.unmount();
	});

	// A component invoked as a plain function (`Row({ … })`) reaches the HMR
	// wrapper without a scope. The wrapper must stay call-transparent — the
	// wrapped module renders — and an edit still refreshes the call site's
	// output through the CALLER's update, exactly as the emitted accept block
	// drives it (callee first, then the caller whose new body closes over the
	// new callee).
	it('renders and refreshes a direct plain-function component call', async () => {
		const v1 = `/** @jsxImportSource octane */
			export function Row(props: { label: string }) {
				if (props.label === '') return <li className="row empty">(empty)</li>;
				return <li className="row">v1:{props.label}</li>;
			}
			export function App(props: { labels: string[] }) {
				return <ul className="rows">{props.labels.map((label) => Row({ label }))}</ul>;
			}
		`;
		const initialRow = await compileHmrComponent(v1, 'Row', '/src/App.tsx');
		const initial = await compileHmrComponent(v1, 'App', '/src/App.tsx');
		const v2 = v1.replace('v1:', 'v2:').replace('(empty)', '(none)');
		const updatedRow = await compileHmrComponent(v2, 'Row', '/src/App.tsx');
		const updated = await compileHmrComponent(v2, 'App', '/src/App.tsx');

		const r = mount(initial, { labels: ['a', ''] });
		expect(r.findAll('.row').map((el) => el.textContent)).toEqual(['v1:a', '(empty)']);

		flushSync(() => {
			// The direct-call-only component has no live blocks of its own; its
			// update must still succeed so the module is not force-reloaded.
			expect((initialRow as any)[HMR].update(updatedRow)).toBe(true);
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(r.findAll('.row').map((el) => el.textContent)).toEqual(['v2:a', '(none)']);
		r.unmount();
	});

	it('refreshes a return-JSX helper called directly with positional arguments', async () => {
		// Production has no wrapper, so each call must see exactly the arguments
		// it was given. The index in the second position must not break the edit.
		const source = (version: number) => `/** @jsxImportSource octane */
			export function renderRow(item: string, index: number, ...rest: string[]) {
				return <li key={item} className="row">{'v${version} ' + item + ' #' + index + ' +' + rest.length + ' ' + rest.join('|')}</li>;
			}
			export function App(props: { items: string[] }) {
				return (
					<ul>
						{props.items.map((item, index) =>
							index === 0 ? renderRow(item, index) : renderRow(item, index, 'x', 'y'),
						)}
					</ul>
				);
			}
		`;
		const hot = webpackHotModule('/src/App.tsx');
		const r = mount(await hot.load(source(1)), { items: ['a', 'b'] });
		try {
			expect(r.findAll('.row').map((el) => el.textContent)).toEqual([
				'v1 a #0 +0 ',
				'v1 b #1 +2 x|y',
			]);
			await hot.load(source(2));
			flushSync(() => {});
			expect(hot.invalidated).toBe(false);
			expect(r.findAll('.row').map((el) => el.textContent)).toEqual([
				'v2 a #0 +0 ',
				'v2 b #1 +2 x|y',
			]);
		} finally {
			r.unmount();
		}
	});

	it('refreshes a component in a root that fell back from hydration', async () => {
		// The server rendered the other arm, a mismatch with no boundary around
		// it, so the whole root renders on the client, as in React 19, and none
		// of the server's nodes stay. The hook keeps Leaf a component with a
		// Block of its own, which a handoff resets.
		const source = (label: string) => `
			import { useState } from 'octane';
			export function Leaf() @{
				useState(0);
				<i>{'${label}'}</i>
			}
			function Em() @{
				<em>{'e'}</em>
			}
			export function App(props: { server?: boolean }) @{
				<div>
					@if (props.server) {
						<>
							<b>{'server'}</b>
							<Em />
						</>
					} @else {
						<>
							<Leaf />
							<Em />
						</>
					}
				</div>
			}
		`;
		const filename = '/src/Rebuilt.tsrx';
		const server = loadCompiledFixtureSource(source('v1'), { id: filename, mode: 'server' });
		const container = document.createElement('div');
		container.innerHTML = renderToString(server['App'], { server: true }).html;
		document.body.appendChild(container);
		const serverNodes = [...container.querySelectorAll('*')];
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const hot = webpackHotModule(filename);
		const recoverable: unknown[] = [];
		const root = hydrateRoot(
			container,
			await hot.load(source('v1')),
			{},
			{
				onRecoverableError: (error) => recoverable.push(error),
			},
		);
		const children = () => Array.from(container.firstElementChild!.children, (el) => el.outerHTML);
		try {
			flushSync(() => {});
			expect(children()).toEqual(['<i>v1</i>', '<em>e</em>']);
			expect(serverNodes.filter((node) => node.isConnected)).toEqual([]);

			await hot.load(source('v2'));
			flushSync(() => {});
			expect(hot.invalidated).toBe(false);
			expect(children()).toEqual(['<i>v2</i>', '<em>e</em>']);
			expect(recoverable).toHaveLength(1);
		} finally {
			root.unmount();
			container.remove();
			errSpy.mockRestore();
		}
	});

	it('refreshes a component that a hydration fallback rendered past the server arm', async () => {
		// The server arm ends after its Em; the client's adds a Leaf, a mismatch
		// with no boundary around it, so the whole root renders on the client.
		// A handoff then resets the Leaf alone.
		const source = (label: string) => `
			import { useState } from 'octane';
			export function Leaf() @{
				useState(0);
				<i>{'${label}'}</i>
			}
			function Em() @{
				<em>{'e'}</em>
			}
			export function App(props: { server?: boolean }) @{
				<div>
					@if (props.server) {
						<>
							<Em />
						</>
					} @else {
						<>
							<Em />
							<Leaf />
						</>
					}
				</div>
			}
		`;
		const filename = '/src/Appended.tsrx';
		const server = loadCompiledFixtureSource(source('v1'), { id: filename, mode: 'server' });
		const container = document.createElement('div');
		container.innerHTML = renderToString(server['App'], { server: true }).html;
		document.body.appendChild(container);
		const serverNodes = [...container.querySelectorAll('*')];
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const hot = webpackHotModule(filename);
		const recoverable: unknown[] = [];
		const root = hydrateRoot(
			container,
			await hot.load(source('v1')),
			{},
			{
				onRecoverableError: (error) => recoverable.push(error),
			},
		);
		const children = () => Array.from(container.firstElementChild!.children, (el) => el.outerHTML);
		try {
			flushSync(() => {});
			expect(children()).toEqual(['<em>e</em>', '<i>v1</i>']);
			expect(serverNodes.filter((node) => node.isConnected)).toEqual([]);

			await hot.load(source('v2'));
			flushSync(() => {});
			expect(hot.invalidated).toBe(false);
			expect(children()).toEqual(['<em>e</em>', '<i>v2</i>']);
			expect(recoverable).toHaveLength(1);
		} finally {
			root.unmount();
			container.remove();
			errSpy.mockRestore();
		}
	});

	it('refreshes a compiled child in place without duplicating its single root', async () => {
		const initialChild = await compileHmrComponent(
			`
				import { useState } from 'octane';
				export function Child(props) @{
					const [count, setCount] = useState(0);
					props.expose(setCount);
					<p class="child">before:{count as string}</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const updatedChild = await compileHmrComponent(
			`
				import { useState } from 'octane';
				export function Child(props) @{
					const [count, setCount] = useState(0);
					props.expose(setCount);
					<p class="child">after:{count as string}</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const App = await compileHmrComponent(
			`
				import { Child } from './Child.tsrx';
				export function App(props) @{
					<main><Child expose={props.expose} /></main>
				}
			`,
			'App',
			'/src/App.tsrx',
			{ './Child.tsrx': { Child: initialChild } },
		);
		let setCount!: (value: number | ((current: number) => number)) => void;
		const r = mount(App, { expose: (setter: typeof setCount) => (setCount = setter) });
		flushSync(() => setCount(3));

		flushSync(() => {
			expect((initialChild as any)[HMR].update(updatedChild)).toBe(true);
		});

		expect(r.findAll('.child')).toHaveLength(1);
		expect(r.find('.child').textContent).toBe('after:3');
		r.unmount();
	});

	it('keeps a refreshed child hidden until its Activity reveals', async () => {
		const initialChild = await compileHmrComponent(
			`
				export function Child() @{
					<p class="child">before</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const updatedChild = await compileHmrComponent(
			`
				export function Child() @{
					<section class="child">after</section>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const App = await compileHmrComponent(
			`
				import { Activity } from 'octane';
				import { Child } from './Child.tsrx';
				export function App(props) @{
					<Activity mode={props.mode}><Child /></Activity>
				}
			`,
			'App',
			'/src/App.tsrx',
			{ './Child.tsrx': { Child: initialChild } },
		);
		const r = mount(App, { mode: 'hidden' });

		flushSync(() => {
			expect((initialChild as any)[HMR].update(updatedChild)).toBe(true);
		});

		expect(r.findAll('.child')).toHaveLength(1);
		expect(r.find('.child').tagName).toBe('SECTION');
		expect(r.find('.child').textContent).toBe('after');
		expect((r.find('.child') as HTMLElement).style.display).toBe('none');

		r.update(App, { mode: 'visible' });
		expect((r.find('.child') as HTMLElement).style.display).toBe('');
		r.unmount();
	});

	it.each([
		{
			construct: '@if branch',
			setup: `const [value, setValue] = useState(true);`,
			output: `@if (value) { <Child /> } @else { <span id="fallback">fallback</span> }`,
			next: false,
		},
		{
			construct: '@switch branch',
			setup: `const [value, setValue] = useState('child');`,
			output: `
				@switch (value) {
					@case 'child': { <Child /> }
					@default: { <span id="fallback">fallback</span> }
				}
			`,
			next: 'fallback',
		},
		{
			construct: '@for item',
			setup: `const [value, setValue] = useState([{ id: 'child' }]);`,
			output: `
				@for (const item of value; key item.id) { <Child /> }
				@empty { <span id="fallback">fallback</span> }
			`,
			next: [],
		},
	])('falls back to reload when a hot child is the sole root of an $construct', async (test) => {
		const initialChild = await compileHmrComponent(
			`
				export function Child() @{
					<p id="child">before</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const updatedChild = await compileHmrComponent(
			`
				export function Child() @{
					<p id="child">after</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const App = await compileHmrComponent(
			`
				import { useState } from 'octane';
				import { Child } from './Child.tsrx';
				export function App(props) @{
					${test.setup}
					props.expose(setValue);
					<main>
						${test.output}
					</main>
				}
			`,
			'App',
			'/src/App.tsrx',
			{ './Child.tsrx': { Child: initialChild } },
		);
		let setValue!: (value: unknown) => void;
		const r = mount(App, { expose: (setter: typeof setValue) => (setValue = setter) });

		expect((initialChild as any)[HMR].update(updatedChild)).toBe(false);
		expect(r.find('#child').textContent).toBe('before');
		expect(() => flushSync(() => setValue(test.next))).not.toThrow();
		expect(r.find('#fallback').textContent).toBe('fallback');
		expect(r.findAll('#child')).toHaveLength(0);
		r.unmount();
	});

	it('refreshes a compiled child that borrows the root container range', async () => {
		const initialChild = await compileHmrComponent(
			`
				import { useState } from 'octane';
				export function Child(props) @{
					const [count, setCount] = useState(0);
					props.expose(setCount);
					<p>before:{count as string}</p>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const updatedChild = await compileHmrComponent(
			`
				import { useState } from 'octane';
				export function Child(props) @{
					const [count, setCount] = useState(0);
					props.expose(setCount);
					<section>after:{count as string}</section>
				}
			`,
			'Child',
			'/src/Child.tsrx',
		);
		const App = await compileHmrComponent(
			`
				import { Child } from './Child.tsrx';
				export function App(props) @{
					<Child expose={props.expose} />
				}
			`,
			'App',
			'/src/App.tsrx',
			{ './Child.tsrx': { Child: initialChild } },
		);
		let setCount!: (value: number | ((current: number) => number)) => void;
		const r = mount(App, { expose: (setter: typeof setCount) => (setCount = setter) });
		flushSync(() => setCount(4));
		const [block] = (initialChild as any)[HMR].liveBlocks as Set<Scope['block']>;
		expect(block.startMarker).toBeNull();
		expect(block.endMarker).toBeNull();
		expect(block.exclusiveMarkers).toBe(true);

		flushSync(() => {
			expect((initialChild as any)[HMR].update(updatedChild)).toBe(true);
		});

		expect(r.find('section').textContent).toBe('after:4');
		r.unmount();
	});

	it('publishes edited memo and effect closures during refresh', async () => {
		const initial = await compileHmrComponent(`
			import { useLayoutEffect, useMemo } from 'octane';
			export function App(props) @{
				const label = useMemo(() => 'memo before', []);
				useLayoutEffect(() => {
					props.log('mount before');
					return () => props.log('cleanup before');
				}, []);
				<p>{label as string}</p>
			}
		`);
		const updated = await compileHmrComponent(`
			import { useLayoutEffect, useMemo } from 'octane';
			export function App(props) @{
				const label = useMemo(() => 'memo after', []);
				useLayoutEffect(() => {
					props.log('mount after');
					return () => props.log('cleanup after');
				}, []);
				<p>{label as string}</p>
			}
		`);
		const log: string[] = [];
		const r = mount(initial, { log: (entry: string) => log.push(entry) });
		expect(log.splice(0)).toEqual(['mount before']);

		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(r.find('p').textContent).toBe('memo after');
		expect(log.splice(0)).toEqual(['cleanup before', 'mount after']);
		r.unmount();
	});

	it('publishes an edited signal declaration closure during refresh', async () => {
		const modules = { 'octane/signals': await import('octane/signals') };
		const source = (suffix: string) => `
			import { derived$ } from 'octane/signals';
			export function App(props) @{
				const label$ = derived$(() => props.label + '${suffix}');
				<p>{label$.get() as string}</p>
			}
		`;
		const initial = await compileHmrComponent(source(' before'), 'App', '/src/App.tsrx', modules);
		const updated = await compileHmrComponent(source(' after'), 'App', '/src/App.tsrx', modules);
		const r = mount(initial, { label: 'a' });
		expect(r.find('p').textContent).toBe('a before');

		// The captured props are unchanged, but the edited closure replaces the old one.
		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(r.find('p').textContent).toBe('a after');
		r.unmount();
	});

	it('keeps hook-owned resources active while replacing render-owned output', async () => {
		const initial = await compileHmrComponent(`
			import { useEffectEvent } from 'octane';
			export function App(props) @{
				const record = useEffectEvent(() => props.log('before'));
				<button onClick={record}>before</button>
			}
		`);
		const updated = await compileHmrComponent(`
			import { useEffectEvent } from 'octane';
			export function App(props) @{
				const record = useEffectEvent(() => props.log('after'));
				<button onClick={record}>after</button>
			}
		`);
		const log: string[] = [];
		const r = mount(initial, { log: (entry: string) => log.push(entry) });
		r.click('button');

		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});
		r.click('button');

		expect(r.find('button').textContent).toBe('after');
		expect(log).toEqual(['before', 'after']);
		r.unmount();
	});

	it('detaches outgoing refs before attaching refreshed output', async () => {
		const initial = await compileHmrComponent(`
			export function App(props) @{
				<div ref={props.track}>before</div>
			}
		`);
		const updated = await compileHmrComponent(`
			export function App(props) @{
				<span ref={props.track}>after</span>
			}
		`);
		const seen: Array<string | null> = [];
		const r = mount(initial, {
			track: (node: Element | null) => seen.push(node?.tagName ?? null),
		});
		expect(seen.splice(0)).toEqual(['DIV']);

		flushSync(() => {
			expect((initial as any)[HMR].update(updated)).toBe(true);
		});

		expect(r.find('span').textContent).toBe('after');
		expect(seen.splice(0)).toEqual([null, 'SPAN']);
		r.unmount();
	});

	it('rejects an update whose compiled output ABI is incompatible', () => {
		const v1: ComponentBody<any> = ((_props: any, scope: Scope) => {
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf';
			root.textContent = 'committed';
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		}) as ComponentBody<any>;
		const v2: ComponentBody<any> = ((_props: any, scope: Scope) => {
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf';
			root.textContent = 'incompatible';
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		}) as ComponentBody<any>;
		(v2 as any).__octaneReturnedOutput = true;

		const Foo = hmr(v1);
		const r = mount(Foo);
		let accepted = true;
		flushSync(() => {
			accepted = (Foo as any)[HMR].update(hmr(v2));
		});
		expect(accepted).toBe(false);
		expect((Foo as any)[HMR].fn).toBe(v1);
		expect(r.find('.leaf').textContent).toBe('committed');
		r.unmount();
	});

	it('preserves hook state across update() — stable Symbol.for keys', () => {
		// Both bodies use the SAME hook symbol (simulating the compiler's
		// `Symbol.for('octane:file.tsrx:Foo.useState#0')`-stable emit). The manual
		// provider transform keeps the test host from adding different call-site
		// identities to these deliberately hand-written component bodies.
		const { v1, v2 } = loadPlainHookFixtureSource<{
			v1: ComponentBody<any>;
			v2: ComponentBody<any>;
		}>(
			`import { useState } from 'octane';
import { clearBlockRange } from './range';
const HOOK_SYM = Symbol.for('octane:hmr.test.ts:Counter.useState#0');
export const v1 = (_props: any, scope: any, _extra: any) => {
			const [n] = useState(0, HOOK_SYM as any);
			clearBlockRange(scope);
			const root = document.createElement('span');
			root.className = 'leaf';
			root.textContent = 'v1:' + n;
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		};
export const v2 = (_props: any, scope: any, _extra: any) => {
			const [n, setN] = useState(0, HOOK_SYM as any);
			clearBlockRange(scope);
			const root = document.createElement('button');
			root.className = 'leaf';
			root.id = 'bump';
			root.textContent = 'v2:' + n;
			root.onclick = () => setN((c: number) => c + 1);
			scope.block.parentNode.insertBefore(root, scope.block.endMarker);
		};`,
			{
				id: '/src/manual-hmr-state.ts',
				inlineHookMemo: false,
				manualSlots: true,
				runtimeModules: { './range': { clearBlockRange } },
			},
		);

		const Counter = hmr(v1);
		const r = mount(Counter);
		expect(r.find('.leaf').textContent).toBe('v1:0');

		// First push state forward via a "new module" v1' that increments.
		// We achieve that here by swapping to v2 (which uses the same Symbol),
		// bumping via click, then swapping back to v1.
		flushSync(() => {
			(Counter as any)[HMR].update(hmr(v2));
		});
		expect(r.find('.leaf').textContent).toBe('v2:0');
		// Click to bump the state.
		r.click('#bump');
		expect(r.find('.leaf').textContent).toBe('v2:1');

		// Now swap BACK to v1 — the state should still be 1 (NOT reset to 0),
		// proving the hooks Map survived the body swap because both versions
		// used the same Symbol.for() key.
		flushSync(() => {
			(Counter as any)[HMR].update(hmr(v1));
		});
		expect(r.find('.leaf').textContent).toBe('v1:1');

		r.unmount();
	});

	it('refreshes null-guarded output but declines incompatible returned-value edits', async () => {
		const direct = await compileHmrComponent(
			`export function Foo(p) @{ <span>{p.label as string}</span> }`,
			'Foo',
		);
		const mixed = await compileHmrComponent(
			`export function Foo(p) @{ if (p.empty) return null; <span>{p.label as string}</span> }`,
			'Foo',
		);
		const returned = await compileHmrComponent(
			`export function Foo(p) @{ if (p.empty) return 'empty'; <span>{p.label as string}</span> }`,
			'Foo',
		);
		const r = mount(direct, { label: 'before', empty: false });
		try {
			flushSync(() => expect((direct as any)[HMR].update(mixed)).toBe(true));
			expect(r.find('span').textContent).toBe('before');
			r.update(direct, { label: 'hidden', empty: true });
			expect(r.container.textContent).toBe('');
			r.update(direct, { label: 'after', empty: false });
			expect(r.find('span').textContent).toBe('after');
			flushSync(() => expect((direct as any)[HMR].update(returned)).toBe(false));
			expect(r.find('span').textContent).toBe('after');
		} finally {
			r.unmount();
		}
	});

	it('webpack HMR preserves named and default wrapper identity across repeated updates', async () => {
		const { compile } = await import('octane/compiler');
		const signals = await import('octane/signals');
		const runtime = new Proxy(
			{ hmr, HMR },
			{
				get(target, property) {
					return (target as any)[property] ?? (() => undefined);
				},
			},
		);
		const compileVersion = (version: number) =>
			compile(
				`export function Named() @{ <span>{'named ${version}'}</span> }\n` +
					`export default function Default() @{ <b>{'default ${version}'}</b> }\n`,
				'file.tsrx',
				{ hmr: 'webpack' },
			).code;
		const evaluate = (code: string, data: Record<string, any> | undefined) => {
			const transformed =
				code
					.replace(/^import\s*\{([^}]*)\}\s*from\s*(['"])octane\2;/m, (_match, imports: string) => {
						const properties = imports
							.split(',')
							.map((specifier) => specifier.trim().replace(/\s+as\s+/, ': '))
							.join(', ');
						return `const { ${properties} } = runtime;`;
					})
					.replace(
						/^import\s*\{([^}]*)\}\s*from\s*(['"])octane\/signals\2;/gm,
						(_match, imports: string) => {
							const properties = imports
								.split(',')
								.map((specifier) => specifier.trim().replace(/\s+as\s+/, ': '))
								.join(', ');
							return `const { ${properties} } = signals;`;
						},
					)
					.replace(/\bexport let /g, 'let ')
					.replace(/export\s*\{\s*Default\s+as\s+default\s*\};/g, '')
					.replaceAll('import.meta.webpackHot', 'hot') + '\nreturn { Named, default: Default };';
			let dispose: ((value: Record<string, any>) => void) | undefined;
			let accepted = false;
			let invalidated = false;
			const hot = {
				data,
				dispose(callback: (value: Record<string, any>) => void) {
					dispose = callback;
				},
				accept() {
					accepted = true;
				},
				invalidate() {
					invalidated = true;
				},
			};
			const exports = Function('runtime', 'signals', 'hot', transformed)(runtime, signals, hot) as {
				Named: any;
				default: any;
			};
			const nextData: Record<string, any> = {};
			dispose?.(nextData);
			expect(accepted).toBe(true);
			expect(invalidated).toBe(false);
			return { exports, data: nextData };
		};

		const first = evaluate(compileVersion(1), undefined);
		const firstNamedBody = first.exports.Named[HMR].fn;
		const firstDefaultBody = first.exports.default[HMR].fn;
		const second = evaluate(compileVersion(2), first.data);
		expect(second.exports.Named).toBe(first.exports.Named);
		expect(second.exports.default).toBe(first.exports.default);
		expect(second.exports.Named[HMR].fn).not.toBe(firstNamedBody);
		expect(second.exports.default[HMR].fn).not.toBe(firstDefaultBody);

		const secondNamedBody = second.exports.Named[HMR].fn;
		const secondDefaultBody = second.exports.default[HMR].fn;
		const third = evaluate(compileVersion(3), second.data);
		expect(third.exports.Named).toBe(first.exports.Named);
		expect(third.exports.default).toBe(first.exports.default);
		expect(third.exports.Named[HMR].fn).not.toBe(secondNamedBody);
		expect(third.exports.default[HMR].fn).not.toBe(secondDefaultBody);

		const output = compileVersion(3);
		expect(output).toContain('const _$webpackHot = import.meta.webpackHot;');
		expect(output).toContain('_$webpackHot.dispose');
		expect(output).toContain('_$webpackHot.accept();');
		expect(output).not.toContain('import.meta.webpackHot.data');
		expect(output).not.toContain('import.meta.hot');
	});

	it('wraps plain return-JSX exports for both HMR dialects', async () => {
		const { compile } = await import('octane/compiler');
		const source =
			`export function Named() { return <span>{'named'}</span>; }\n` +
			`export default function Default() { return <b>{'default'}</b>; }\n`;
		const vite = compile(source, 'file.tsx', { hmr: 'vite' }).code;
		expect(vite).toContain('Named = _$hmr(Named);');
		expect(vite).toContain('Default = _$hmr(Default);');
		expect(vite).toContain('import.meta.hot.accept');

		const webpack = compile(source, 'file.tsx', { hmr: 'webpack' }).code;
		expect(webpack).toContain('export { Named };');
		expect(webpack).toContain('export { Default as default };');
		expect(webpack).toContain('_$webpackHot.dispose');
	});

	it('hmr option off → no wrapping, no accept block', async () => {
		const { compile } = await import('octane/compiler');
		const src = "export function Foo() @{ <span>{'hi'}</span> }\n";
		const { code } = compile(src, 'file.tsrx'); // no { hmr: true }
		expect(code).not.toMatch(/hmr\(/);
		expect(code).not.toMatch(/import\.meta\.hot/);
	});

	it('hmr option off omits registry identities and source paths for direct hooks', async () => {
		// Production module ownership must not embed absolute development paths
		// or retain HMR's global Symbol registry entries.
		const { compile } = await import('octane/compiler');
		const src =
			"import { useState } from 'octane';\n" +
			'export function Foo() @{\n' +
			'  const [n, setN] = useState(0);\n' +
			'  <button onClick={() => setN(n + 1)}>{n as string}</button>\n' +
			'}\n';
		const { code } = compile(src, '/abs/path/to/file.tsrx'); // no { hmr: true }
		expect(code).not.toMatch(/Symbol\(/);
		expect(code).not.toMatch(/Symbol\.for/);
		expect(code).not.toMatch(/abs\/path/);
	});

	it('slotHooks (plain .ts pass) follows the same gate', async () => {
		const { slotHooks } = await import('../src/compiler/slot-hooks.js');
		const src =
			"import { useState } from 'octane';\n" +
			'export function useCounter() {\n' +
			'  const [n, setN] = useState(0);\n' +
			'  return [n, setN];\n' +
			'}\n';
		const dev = slotHooks(src, '/abs/custom.ts', { hmr: true });
		expect(dev?.code).toMatch(/Symbol\.for\("octane:\/abs\/custom\.ts:useCounter\.useState#0"\)/);
		const prod = slotHooks(src, '/abs/custom.ts');
		expect(prod?.code).toMatch(/_\$hookSlots\(1\)/);
		expect(prod?.code).toMatch(/const _h\$0 = \/\* @__PURE__ \*\/ Symbol\(_hs\$\);/);
		expect(prod?.code).not.toMatch(/Symbol\.for|abs\/custom/);
	});

	it('slots first-class subtemplate hooks once with the callable-helper ABI', async () => {
		const { compile } = await import('octane/compiler');
		const { code } = compile(
			`import { useState } from 'octane';
			 export function App() @{
			   const child = () => @{ const [value] = useState(1); <span>{value as string}</span> };
			   <div>{child}</div>
			 }`,
			'subtemplate-slots.tsrx',
			{ hmr: false },
		);
		const call = code.match(/useState\(1, ([^)]+)\)/);
		expect(call?.[1]).toMatch(/^_h\$\d+$/);
		expect(code).not.toMatch(/useState\(1, _h\$\d+, _h\$\d+\)/);
		expect(code).toMatch(/const _h\$\d+ = \/\* @__PURE__ \*\/ Symbol\(_hs\$(?: \+ \d+)?\);/);
	});

	it('avoids user bindings when naming full-compiler and surgical slot declarations', async () => {
		const { compile } = await import('octane/compiler');
		const source = `import { useState } from 'octane';
			const _hs$ = 'user base';
			const _$hookSlots = 'user helper';
			export function helper() { const _h$0 = 'user site'; return useState(1); }`;
		const full = compile(source, 'slot-names.tsrx', { hmr: false }).code;
		expect(full).toContain('hookSlots as _$hookSlots$');
		expect(full).toContain('const _hs$$ = /* @__PURE__ */ _$hookSlots$(1);');
		expect(full).toMatch(/const _h\$0\$ = \/\* @__PURE__ \*\/ Symbol\(_hs\$\$\);/);
		expect(full).toContain('useStateWithGetter(1, _h$0$)');

		const { slotHooks } = await import('../src/compiler/slot-hooks.js');
		const surgical = slotHooks(source, 'slot-names.ts')!.code;
		expect(surgical).toContain('hookSlots as _$hookSlots$');
		expect(surgical).toContain('const _hs$$ = /* @__PURE__ */ _$hookSlots$(1);');
		expect(surgical).toMatch(/const _h\$0\$ = \/\* @__PURE__ \*\/ Symbol\(_hs\$\$\);/);
		expect(surgical).toContain('useStateWithGetter(1, _h$0$)');
	});

	it('avoids a hookSlots helper collision in client and server component output', async () => {
		const { compile } = await import('octane/compiler');
		const source = `import { useState } from 'octane';
			const _$hookSlots = 'user helper';
			export function App() {
				const state = useState(1);
				return <div>{state[0] as string}</div>;
			}`;
		for (const mode of ['client', 'server'] as const) {
			const code = compile(source, `slot-helper-${mode}.tsrx`, { mode, hmr: false }).code;
			expect(code).toContain('hookSlots as _$hookSlots$');
			expect(code).toContain('/* @__PURE__ */ _$hookSlots$(1)');
		}
	});
});
