import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as tsrxPlugin from '@tsrx/prettier-plugin';
import * as prettier from 'prettier';

// The repository formats `.tsrx` with @tsrx/prettier-plugin, patched in
// patches/@tsrx__prettier-plugin@0.4.10.patch. The printer re-emits every node
// from scratch, so a statement it cannot print used to become a placeholder
// comment, an empty loop body used to vanish so the next statement became the
// body, and the parentheses around an `as` cast were dropped so the cast took
// in the surrounding operator. These rewrites pass `prettier --check` once
// committed, so these tests pin the output and compare the AST before and
// after formatting.

const FIXTURE = fileURLToPath(new URL('./fixtures/tsrx-prettier-statements.tsrx', import.meta.url));
const CAST_FIXTURE = fileURLToPath(new URL('./fixtures/tsrx-prettier-casts.tsrx', import.meta.url));
const IGNORE_FILE = fileURLToPath(new URL('../.prettierignore', import.meta.url));
// Plugin names resolve from the working directory, so pass the module itself.
const { plugins: configuredPlugins, ...config } = await prettier.resolveConfig(FIXTURE);

/** @param {string} source */
async function format(source) {
	const options = { ...config, plugins: [tsrxPlugin], filepath: FIXTURE };
	const once = await prettier.format(source, options);
	const twice = await prettier.format(once, options);
	assert.equal(twice, once, 'formatting must be idempotent');
	return once;
}

const POSITION_KEYS = new Set([
	'start',
	'end',
	'loc',
	'range',
	'metadata',
	'leadingComments',
	'trailingComments',
	'innerComments',
	'comments',
]);

/** @param {unknown} node */
function withoutPositions(node) {
	if (Array.isArray(node)) return node.map(withoutPositions);
	if (!node || typeof node !== 'object') return node;
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => !POSITION_KEYS.has(key))
			.map(([key, value]) => [key, withoutPositions(value)]),
	);
}

/** @param {string} source */
async function parse(source) {
	return tsrxPlugin.parsers.tsrx.parse(source, { filepath: FIXTURE });
}

/**
 * @param {unknown} node
 * @param {string} type
 * @returns {number}
 */
function countNodes(node, type) {
	if (Array.isArray(node)) return node.reduce((sum, child) => sum + countNodes(child, type), 0);
	if (!node || typeof node !== 'object') return 0;
	let count = /** @type {{ type?: unknown }} */ (node).type === type ? 1 : 0;
	for (const [key, value] of Object.entries(node)) {
		if (!POSITION_KEYS.has(key)) count += countNodes(value, type);
	}
	return count;
}

/**
 * @param {string} input
 * @param {string} expected
 */
async function assertFormats(input, expected) {
	const output = await format(input);
	assert.equal(output, `${expected}\n`);
	assert.deepEqual(withoutPositions(await parse(output)), withoutPositions(await parse(input)));
}

describe('@tsrx/prettier-plugin statements', () => {
	test('keeps the committed fixture byte-identical under the repository config', async () => {
		const info = await prettier.getFileInfo(FIXTURE, { ignorePath: IGNORE_FILE });
		assert.deepEqual(info, { ignored: false, inferredParser: 'tsrx' });
		assert.ok(configuredPlugins.includes('@tsrx/prettier-plugin'));

		const source = readFileSync(FIXTURE, 'utf8');
		assert.equal(await format(source), source);
		const ast = await parse(source);
		assert.equal(countNodes(ast, 'LabeledStatement'), 6);
		assert.equal(countNodes(ast, 'EmptyStatement'), 4);
	});

	test('keeps a labeled block in an @for body', async () => {
		const source = `export function Rows({ rows }: { rows: string[] }) @{
	<ul>
		@for (const row of rows; key row) {
			label: {
				if (row !== 'label') break label;
			}
			<li>{row}</li>
		}
	</ul>
}`;
		await assertFormats(source, source);
	});

	test('keeps labeled loops, blocks, stacked labels, and empty labeled statements', async () => {
		for (const source of [
			'outer: for (const row of rows) {\n\tfor (const cell of row) {\n\t\tif (cell) continue outer;\n\t}\n}',
			'block: {\n\tbreak block;\n}',
			'a: b: while (true) break a;',
			'loop: do {\n\tcontinue loop;\n} while (next());',
			'attempt: try {\n\tbreak attempt;\n} finally {\n\tdone();\n}',
			'switch (x) {\n\tcase 1:\n\t\tinner: for (;;) break inner;\n}',
			'label:;',
		]) {
			await assertFormats(source, source);
		}
		await assertFormats(
			'outer:for(const x of xs){continue outer}',
			'outer: for (const x of xs) {\n\tcontinue outer;\n}',
		);
		await assertFormats('empty: {}', 'empty: {\n}');
	});

	test('places comments around a label like Prettier', async () => {
		await assertFormats(
			'a: // loop\nfor (;;) {\n\tbreak a;\n}',
			'// loop\na: for (;;) {\n\tbreak a;\n}',
		);
		await assertFormats('b: /* after */ run();', 'b: /* after */ run();');
		await assertFormats(
			'c /* before */: for (;;) {\n\tbreak c;\n}',
			'c /* before */: for (;;) {\n\tbreak c;\n}',
		);
		await assertFormats(
			'd: // prettier-ignore\nfor (  ;; ) {  break d }',
			'd: // prettier-ignore\nfor (  ;; ) {  break d }',
		);
	});

	test('keeps an empty statement body instead of adopting the next statement', async () => {
		for (const source of [
			'while (next());\ncount++;',
			'for (let i = 0; i < n; i++);\ncount++;',
			'for (const x of xs);\ncount++;',
			'for (const k in o);\ncount++;',
			'if (a);\nelse b();',
			'if (a) b();\nelse;\ncount++;',
			'do; while (a--);',
		]) {
			await assertFormats(source, source);
		}
	});

	test('throws on a node type it cannot print instead of writing a placeholder', async () => {
		const tsrx = tsrxPlugin.parsers.tsrx;
		const futureParser = {
			...tsrx,
			/** @param {string} text @param {import('prettier').ParserOptions} options */
			async parse(text, options) {
				const ast = await tsrx.parse(text, options);
				return { ...ast, body: [{ ...ast.body[0], type: 'FutureStatement' }] };
			},
		};
		await assert.rejects(
			prettier.format('run();\n', {
				parser: 'tsrx-future',
				plugins: [tsrxPlugin, { parsers: { 'tsrx-future': futureParser } }],
			}),
			/@tsrx\/prettier-plugin has no printer for FutureStatement \(1:1\)/,
		);
	});
});

/**
 * The AST of `source`, or its parse error.
 * @param {string} source
 */
async function parseOutcome(source) {
	try {
		return withoutPositions(await parse(source));
	} catch (error) {
		return String(/** @type {Error} */ (error).message);
	}
}

describe('@tsrx/prettier-plugin casts', () => {
	test('keeps the committed fixture byte-identical under the repository config', async () => {
		const info = await prettier.getFileInfo(CAST_FIXTURE, { ignorePath: IGNORE_FILE });
		assert.deepEqual(info, { ignored: false, inferredParser: 'tsrx' });

		const source = readFileSync(CAST_FIXTURE, 'utf8');
		assert.equal(await format(source), source);
		const ast = await parse(source);
		assert.equal(countNodes(ast, 'TSAsExpression'), 15);
		assert.equal(countNodes(ast, 'TSSatisfiesExpression'), 1);
	});

	test('keeps the parentheses a cast needs as an operand', async () => {
		// Each pair is the source and the reading without the parentheses,
		// which parses differently or not at all.
		for (const [source, regrouped] of [
			["x = 'name' in (e.target as Element);", "x = 'name' in e.target as Element;"],
			['x = y < (z as number);', 'x = y < z as number;'],
			['x = w instanceof (v as any);', 'x = w instanceof v as any;'],
			['x = a + (b as number);', 'x = a + b as number;'],
			['x = a * (b satisfies number);', 'x = a * b satisfies number;'],
			['x = 2 ** (n as number);', 'x = 2 ** n as number;'],
			['x = (n as number) ** 2;', 'x = n as number ** 2;'],
			[
				'f = async () => await (p as Promise<number>);',
				'f = async () => await p as Promise<number>;',
			],
			['x = new (X as any)();', 'x = new X as any();'],
			['x = (tag as any)`x`;', 'x = tag as any`x`;'],
			['x = (f as any)<T>;', 'x = f as any<T>;'],
			['(x as any)++;', 'x as any++;'],
			['--(x as any);', '--x as any;'],
			['class K extends (B as any) {}', 'class K extends B as any {}'],
			['x = class extends (B as any) {};', 'x = class extends B as any {};'],
		]) {
			await assertFormats(source, source);
			assert.notDeepEqual(await parseOutcome(regrouped), await parseOutcome(source), regrouped);
		}
	});

	test('keeps the readability parentheses Prettier prints around a cast only where written', async () => {
		// Each pair parses the same, so the source's choice stands.
		for (const [source, bare] of [
			['x = a && (b as T);', 'x = a && b as T;'],
			['x = a ?? (b as T);', 'x = a ?? b as T;'],
			['x = a === (b satisfies number);', 'x = a === b satisfies number;'],
			['x = (a as number) + 1;', 'x = a as number + 1;'],
			['x = c ? (a as T) : (b as T);', 'x = c ? a as T : b as T;'],
			['x = (c as boolean) ? a : b;', 'x = c as boolean ? a : b;'],
			['x = [...(xs as T[])];', 'x = [...xs as T[]];'],
			['x = <div {...(p as object)} />;', 'x = <div {...p as object} />;'],
			['x = (a + b) as T;', 'x = a + b as T;'],
			['f = async () => (await p) as T;', 'f = async () => await p as T;'],
		]) {
			assert.deepEqual(await parseOutcome(bare), await parseOutcome(source), bare);
			await assertFormats(source, source);
			await assertFormats(bare, bare);
		}
	});

	test('drops the parentheses Prettier drops around a cast', async () => {
		await assertFormats('f((x as T));', 'f(x as T);');
		await assertFormats('x = (y as T);', 'x = y as T;');
		await assertFormats('x = (y as unknown) as T;', 'x = y as unknown as T;');
		await assertFormats('x = { a: (y as T) };', 'x = { a: y as T };');
	});

	test('keeps a cast object that starts an arrow body or a statement an object', async () => {
		await assertFormats('f = () => ({} as T);', 'f = () => ({}) as T;');
		await assertFormats(
			'f = () => ({ a: 1 }) satisfies T as U;',
			'f = () => ({ a: 1 }) satisfies T as U;',
		);
		await assertFormats('({} as T);', '({}) as T;');
		await assertFormats('(function () {}) as T;', '(function () {}) as T;');
		await assertFormats('(class {}) as T;', '(class {}) as T;');
		await assertFormats('f = () => ({} as T).a;', 'f = () => ({} as T).a;');
	});
});
