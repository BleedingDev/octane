import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { compileToVolarMappings } from '../../packages/octane/src/compiler/volar.js';
import { checkTsrxProject } from './check-tsrx-project.mjs';

const identity = `export function identity<Value extends { title: string }>(value: Value): Value {
	return value;
}`;

function fixture(files, selection, run) {
	const root = mkdtempSync(join(tmpdir(), 'octane-native-public-project-'));
	try {
		for (const [name, source] of Object.entries(files)) {
			mkdirSync(dirname(join(root, name)), { recursive: true });
			writeFileSync(join(root, name), source);
		}
		writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
		const configPath = join(root, 'tsconfig.json');
		const config = JSON.stringify({
			compilerOptions: {
				strict: true,
				target: 'esnext',
				module: 'preserve',
				moduleResolution: 'bundler',
				jsx: 'preserve',
				resolveJsonModule: true,
				allowImportingTsExtensions: true,
				esModuleInterop: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				noEmit: true,
				skipLibCheck: false,
				types: [],
			},
			...selection,
		});
		writeFileSync(configPath, config);
		run(checkTsrxProject({ configPath, compileToVolarMappings }), root);
		assert.equal(readFileSync(configPath, 'utf8'), config, 'Keep the frozen config unchanged.');
		assert(
			readdirSync(root, { recursive: true }).every(
				(file) => !file.endsWith('.tsrx.tsx') || Object.hasOwn(files, file),
			),
			'Native checker projections must never be written into the package.',
		);
		for (const [name, source] of Object.entries(files))
			assert.equal(readFileSync(join(root, name), 'utf8'), source, 'Preserve authored inputs.');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('preserves generic public signatures imported from authored TSRX', () => {
	fixture(
		{
			'identity.tsrx': identity,
			'consumer.ts': `import { identity } from './identity.tsrx';
const value = identity({ title: 'native', count: 7 });
const title: string = value.title;
const count: number = value.count;
// @ts-expect-error the original generic signature requires a string title
identity({ title: 7 });`,
		},
		{ include: ['**/*'] },
		(result, root) => {
			assert.deepEqual(result.diagnostics, []);
			assert.deepEqual(result.projectedFiles, [join(root, 'identity.tsrx')]);
		},
	);
});

test('reports a consumer type error through the native TSRX signature', () => {
	fixture(
		{
			'identity.tsrx': identity,
			'consumer.ts': `import { identity } from './identity.tsrx';
const title: number = identity({ title: 'native' }).title;`,
		},
		{ include: ['**/*'] },
		(result) =>
			assert.deepEqual(
				result.diagnostics.map((diagnostic) => diagnostic.code),
				[2322],
			),
	);
});

test('keeps extension-specific include and exclude selectors exact', () => {
	fixture(
		{
			'src/view.tsrx': identity,
			'src/excluded.tsrx': 'export const broken: string = 7;',
			'src/ordinary.tsx': 'export const ordinary: string = "native";',
			'src/other.ts': 'export const excludedOrdinary: string = 7;',
		},
		{ include: ['src/**/*.tsrx'], exclude: ['src/excluded.tsrx'] },
		(result, root) => {
			assert.deepEqual(result.diagnostics, []);
			assert.deepEqual(result.rootFiles, [join(root, 'src/view.tsrx')]);
		},
	);
	fixture(
		{
			'src/view.tsrx': 'export const broken: string = 7;',
			'src/ordinary.tsx': 'export const ordinary: string = "native";',
		},
		{ include: ['src/**/*.tsx'] },
		(result, root) => {
			assert.deepEqual(result.diagnostics, []);
			assert.deepEqual(result.rootFiles, [join(root, 'src/ordinary.tsx')]);
			assert.deepEqual(result.projectedFiles, []);
		},
	);
});

test('checks explicit TSRX roots while preserving the complete imported declaration graph', () => {
	fixture(
		{
			'view.tsrx': `import type { Derived } from './dependency.js';
export function identity(value: Derived): Derived { return value; }`,
			'dependency.d.ts': 'export interface Derived extends MissingType {}',
			'ignored.ts': 'export const ignored: string = 7;',
		},
		{ files: ['view.tsrx'], include: [], exclude: ['**/*'] },
		(result, root) => {
			assert.deepEqual(result.rootFiles, [join(root, 'view.tsrx')]);
			assert(result.checkedFiles.includes(join(root, 'dependency.d.ts')));
			assert.deepEqual(
				result.diagnostics.map((diagnostic) => diagnostic.code),
				[2304],
			);
		},
	);
});

test('keeps imported JSON arrays and objects as typed application data', () => {
	fixture(
		{
			'array.json': '[{"title":"native","count":7}]',
			'object.json': '{"files":["view.tsrx"],"compilerOptions":{"strict":false},"count":7}',
			'view.tsrx': `import entries from './array.json';
import options from './object.json';
export function read(index: number): { title: string; count: number; files: string[]; strict: boolean } {
	return {
		title: entries[index]?.title ?? '',
		count: options.count,
		files: options.files,
		strict: options.compilerOptions.strict,
	};
}`,
			'consumer.ts': `import { read } from './view.tsrx';
const result = read(0);
const title: string = result.title;
const files: string[] = result.files;
const strict: boolean = result.strict;
// @ts-expect-error JSON imports keep their property types
const count: string = result.count;`,
		},
		{ include: ['**/*'] },
		(result, root) => {
			assert.deepEqual(result.diagnostics, []);
			assert(result.checkedFiles.includes(join(root, 'array.json')));
			assert(result.checkedFiles.includes(join(root, 'object.json')));
			assert.equal(
				result.authoredContents[join(root, 'array.json')],
				'[{"title":"native","count":7}]',
			);
			assert.equal(
				result.authoredContents[join(root, 'object.json')],
				'{"files":["view.tsrx"],"compilerOptions":{"strict":false},"count":7}',
			);
		},
	);
});

test('keeps an authored TSRX-suffixed TSX module ordinary and preserves its public type', () => {
	fixture(
		{
			'view.tsrx.tsx': 'export function read(): number { return 7; }',
			'consumer.ts': `import { read } from './view.tsrx.tsx';
const value: string = read();`,
		},
		{ include: ['**/*'] },
		(result, root) => {
			assert.deepEqual(result.projectedFiles, []);
			assert(result.rootFiles.includes(join(root, 'view.tsrx.tsx')));
			assert.equal(
				result.authoredContents[join(root, 'view.tsrx.tsx')],
				'export function read(): number { return 7; }',
			);
			assert.deepEqual(
				result.diagnostics.map((diagnostic) => diagnostic.code),
				[2322],
			);
		},
	);
});

test('rejects a projection that would hide an existing authored module', () => {
	const root = mkdtempSync(join(tmpdir(), 'octane-native-projection-conflict-'));
	try {
		writeFileSync(join(root, 'view.tsrx'), identity);
		writeFileSync(join(root, 'view.tsrx.tsx'), 'export const original = true;');
		const configPath = join(root, 'tsconfig.json');
		for (const selection of [{ include: ['*'] }, { files: ['view.tsrx'], include: [] }]) {
			writeFileSync(
				configPath,
				JSON.stringify({ compilerOptions: { strict: true }, ...selection }),
			);
			assert.throws(
				() => checkTsrxProject({ configPath, compileToVolarMappings }),
				/A projection conflicts with authored source/,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
