import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { transform } from 'esbuild';
import { specializeErrorCalls } from '../../packages/octane/scripts/specialize-error-calls.mjs';
import { formatProdErrorMessage } from '../../packages/octane/src/error-message.ts';

const catalog = JSON.parse(
	readFileSync(new URL('../../packages/octane/error-codes/codes.json', import.meta.url), 'utf8'),
);
const importFormatter = "import { formatClientError } from './error-codes.client.generated.js';";

async function execute(source) {
	const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'esnext' });
	const module = { exports: {} };
	const process = { env: {} };
	const context = vm.createContext({ module, exports: module.exports, process });
	vm.runInContext(compiled.code, context);
	return { exports: module.exports, process, context };
}

test('specialized errors retain exact messages, classes and call-time environment', async () => {
	const source = `${importFormatter}\nexport function fail() { throw new TypeError(formatClientError(313)); }`;
	const specialized = specializeErrorCalls(source, 'dom-bindings.ts', catalog);
	assert.notEqual(specialized, source);
	const result = await execute(specialized);
	for (const mode of ['development', 'production', 'test', undefined, 'production']) {
		if (mode === undefined) delete result.process.env.NODE_ENV;
		else result.process.env.NODE_ENV = mode;
		assert.throws(result.exports.fail, (error) => {
			assert.equal(error.name, 'TypeError');
			assert.equal(
				error.message,
				mode === 'production' ? formatProdErrorMessage(313, []) : catalog.codes['313'].message,
			);
			return true;
		});
	}
	delete result.context.process;
	assert.throws(result.exports.fail, { name: 'ReferenceError' });
});

test('all active zero-argument client and server codes retain their messages', async () => {
	for (const runtime of ['client', 'server']) {
		const name = runtime === 'client' ? 'formatClientError' : 'formatServerError';
		const filename = runtime === 'client' ? 'dom-bindings.ts' : 'runtime.server.ts';
		const entries = Object.entries(catalog.codes).filter(
			([, entry]) =>
				entry.status === 'active' && entry.argumentCount === 0 && entry.runtime.includes(runtime),
		);
		const source =
			`import { ${name} } from './error-codes.${runtime}.generated.js';\n` +
			`export function messages() { return [${entries.map(([code]) => `${name}(${code})`).join(',')}]; }`;
		const specialized = specializeErrorCalls(source, filename, catalog);
		assert.notEqual(specialized, source);
		const result = await execute(specialized);
		for (const mode of ['development', 'production', 'development']) {
			result.process.env.NODE_ENV = mode;
			const messages = result.exports.messages();
			for (let index = 0; index < entries.length; index++) {
				const [code, entry] = entries[index];
				assert.equal(
					messages[index],
					mode === 'production' ? formatProdErrorMessage(Number(code), []) : entry.message,
					`${runtime} ${code} ${mode}`,
				);
			}
		}
	}
});

test('leaves unsupported bindings, mixed calls and environment shadows unchanged', () => {
	for (const source of [
		`${importFormatter} function fail(process) { return formatClientError(313); }`,
		`${importFormatter} const process = {}; formatClientError(313);`,
		`${importFormatter} try {} catch ({ process }) { formatClientError(313); }`,
		`${importFormatter} function f(formatClientError) { return formatClientError(313); }`,
		`${importFormatter} const fn = formatClientError; fn(313);`,
		`${importFormatter} formatClientError(313); formatClientError(3, 'argument');`,
		`${importFormatter} formatClientError(3);`,
		`${importFormatter} formatClientError(999999);`,
		`${importFormatter} formatClientError(313 + 0);`,
		`${importFormatter} formatClientError?.(313);`,
		`${importFormatter} const __octaneNoArgError = 1; formatClientError(313);`,
		"import { formatClientError as format } from './error-codes.client.generated.js'; format(313);",
		"import { formatClientError } from 'error-codes.client.generated.js'; formatClientError(313);",
		"import { formatClientError } from '/error-codes.client.generated.js'; formatClientError(313);",
		"import { formatClientError, other } from './error-codes.client.generated.js'; formatClientError(313);",
	]) {
		assert.equal(specializeErrorCalls(source, 'dom-bindings.ts', catalog), source);
	}
	assert.equal(
		specializeErrorCalls(`${importFormatter} formatClientError(313);`, 'uncovered.ts', catalog),
		`${importFormatter} formatClientError(313);`,
	);
});

test('preserves module directives and pure annotations on surrounding expressions', async () => {
	const source = `'use client';\n${importFormatter}
		const unused = /* @__PURE__ */ sideEffect();
		export function fail() { throw new Error(formatClientError(313)); }`;
	const specialized = specializeErrorCalls(source, 'dom-bindings.ts', catalog);
	assert.match(specialized, /^['"]use client['"];?/);
	assert.match(specialized, /\/\*\s*@__PURE__\s*\*\//);
	const compiled = await transform(specialized, {
		loader: 'ts',
		format: 'esm',
		minify: true,
		treeShaking: true,
	});
	assert.doesNotMatch(compiled.code, /sideEffect/);
});

test('replacements preserve precedence, escaped messages and surrounding source comments', async () => {
	const source = `'use client';
${importFormatter}
// 🐙 Preserve this heading and its UTF-16 offsets.
export function values() {
	/* Keep this comment before the expressions. */
	return [
		formatClientError(313).length,
		2 * formatClientError(313).length,
		!formatClientError(313),
		'prefix:' + formatClientError(313),
	]; // Preserve the trailing comment.
}
/* Preserve the final comment. */`;
	const specialized = specializeErrorCalls(source, 'dom-bindings.ts', catalog);
	assert.equal(specializeErrorCalls(source, 'dom-bindings.ts', catalog), specialized);
	for (const comment of [
		'// 🐙 Preserve this heading and its UTF-16 offsets.',
		'/* Keep this comment before the expressions. */',
		'// Preserve the trailing comment.',
		'/* Preserve the final comment. */',
	])
		assert.ok(specialized.includes(comment), comment);
	const result = await execute(specialized);
	for (const mode of ['development', 'production']) {
		result.process.env.NODE_ENV = mode;
		const message =
			mode === 'production' ? formatProdErrorMessage(313, []) : catalog.codes['313'].message;
		assert.deepEqual(
			[...result.exports.values()],
			[message.length, 2 * message.length, !message, 'prefix:' + message],
		);
	}
	const malformed = `${importFormatter} export const broken = formatClientError(313 + ;`;
	assert.equal(specializeErrorCalls(malformed, 'dom-bindings.ts', catalog), malformed);
});
