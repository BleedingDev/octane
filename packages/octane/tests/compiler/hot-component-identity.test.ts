// @vitest-environment node

import { describe, expect, it } from 'vitest';
import * as Signals from '../../src/signals/index.js';
import { loadCompiledFixtureSource } from '../_server-fixture.js';

describe('hot component module bindings', () => {
	it.each(['vite', 'webpack'] as const)(
		'evaluates %s modules without using shadowed authored globals',
		(hmr) => {
			const hot = { data: {}, dispose() {}, accept() {}, invalidate() {} };
			const module = loadCompiledFixtureSource<{ inspect: () => unknown[]; Counter: unknown }>(
				`const Object = null, Symbol = null, globalThis = null, _$__stampHmrComponent = null;
export function inspect() { return [Object, Symbol, globalThis, _$__stampHmrComponent]; }
export function Counter() @{ <p/> }`,
				{
					id: `/src/shadowed-hot-component-${hmr}.tsrx`,
					mode: 'client',
					compileOptions: { hmr, dev: true },
					importMeta: { hot, webpackHot: hot },
					runtimeModules: { 'octane/signals': Signals },
				},
			);
			expect(module.inspect()).toEqual([null, null, null, null]);
			expect(module.Counter).toBeTypeOf('function');
		},
	);
});
