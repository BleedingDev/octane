/**
 * Runtime evidence for Strong state purity diagnostics. Each rejected pattern
 * compiles in compatibility mode here so the test observes what it actually
 * does; the replacement named by the diagnostic compiles under Strong.
 */
import { describe, expect, it } from 'vitest';
import { act, mount } from './_helpers';
import { loadCompiledFixtureSource } from './_server-fixture.js';

function fixture(body: string, strong = false) {
	return loadCompiledFixtureSource(
		`/** @jsxImportSource octane */\n${strong ? '"use strong";\n' : ''}import { memo, useEffect, useLayoutEffect, useOptimistic, useState, useSyncExternalStore, useTransition } from 'octane';\n${body}`,
		{
			id: '/src/strong-state-runtime.tsx',
			mode: 'client',
			compileOptions: { dev: process.env.OCTANE_TEST_COMPILE_MODE !== 'prod', hmr: false },
		},
	);
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe('mutating state outside render', () => {
	it('does not re-render when the mutated array is passed back to its setter', async () => {
		const { A } = fixture(
			`export function A() { const [items, setItems] = useState([]); return <button onClick={() => { items.push(1); setItems(items); }}>{items.length}</button>; }`,
		);
		const root = mount(A);
		try {
			root.click('button');
			root.click('button');
			await act(() => {});
			expect(root.find('button').textContent).toBe('0');
		} finally {
			root.unmount();
		}
	});

	it('leaves identity-based consumers stale when only the outer object is copied', async () => {
		const { A } = fixture(
			`const Count = memo(function Count({ list }) { return <i>{list.length}</i>; });
export function A() { const [s, setS] = useState({ list: [], n: 0 }); return <button onClick={() => { s.list.push(1); setS({ ...s, n: s.n + 1 }); }}><Count list={s.list} />{s.n}</button>; }`,
		);
		const root = mount(A);
		try {
			root.click('button');
			root.click('button');
			await act(() => {});
			expect(root.find('button').textContent).toBe('02');
		} finally {
			root.unmount();
		}
	});

	it('changes the value useOptimistic reverts to after a failed Action', async () => {
		const body = `export function A({ save, mutate }) {
  const [s, setS] = useState({ list: ['a'] });
  const [shown, add] = useOptimistic(s, (current, item) => ({ list: [...current.list, item] }));
  const [pending, start] = useTransition();
  return <button onClick={() => start(async () => {
    add('b');
    if (mutate) s.list.push('b');
    try { await save(); setS({ ...s }); } catch {}
  })}>{shown.list.join(',') + (pending ? '...' : '')}</button>;
}`;
		const results: Record<string, string> = {};
		for (const mutate of [false, true]) {
			const { A } = fixture(body);
			const request = deferred();
			const root = mount(A, { save: () => request.promise, mutate });
			try {
				root.click('button');
				await act(() => {});
				await act(async () => {
					request.reject(new Error('offline'));
					await Promise.resolve();
				});
				await act(() => {});
				results[String(mutate)] = root.find('button').textContent!;
			} finally {
				root.unmount();
			}
		}
		expect(results).toEqual({ false: 'a', true: 'a,b' });
	});

	it('never renders a mutation made by an effect', async () => {
		const { A } = fixture(
			`export function A() { const [s] = useState({ list: [] }); useEffect(() => { s.list.push(1); }); return <p>{s.list.length}</p>; }`,
		);
		const root = mount(A);
		try {
			await act(() => {});
			expect(root.find('p').textContent).toBe('0');
		} finally {
			root.unmount();
		}
	});
});
