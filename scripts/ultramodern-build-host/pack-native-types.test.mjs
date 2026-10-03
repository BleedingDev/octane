import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import {
	checkNativeTypes,
	fetchNativeTypesUpstream,
	nativeTypesConsumer,
	nativeTypesRecipe,
	nativeTypesReleaseURI,
	packNativeTypes,
	verifyNativeTypeDependency,
} from './pack-native-types.mjs';

const require = createRequire(import.meta.url);
const installed = dirname(require.resolve('@typescript-eslint/types/package.json'));
let directory;
let upstreamBytes;
before(async () => {
	assert(process.env.OWNED_TEMP_DIR, 'Run this suite through owned-temp-dir --run.');
	directory = mkdtempSync(join(process.env.OWNED_TEMP_DIR, 'native-types-test-'));
	upstreamBytes = await fetchNativeTypesUpstream();
});
after(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

function fixture(name) {
	const source = join(directory, `${name}-source`);
	cpSync(installed, source, { recursive: true });
	const output = join(directory, `${name}-output`);
	return { source, output };
}

test('publishes the complete canonical package and checks its actual unpacked native7 declarations', async () => {
	const { source, output } = fixture('published');
	const result = await packNativeTypes({ output, packageDir: source, upstreamBytes });
	assert.equal(result.package.name, '@typescript-eslint/types');
	assert.equal(result.package.version, '8.71.0');
	assert.equal(result.producer.typescript, '7.0.2');
	assert.equal(
		result.artifact.intendedReleaseURI,
		'https://github.com/bleedingdev/octane/releases/download/typescript-eslint-types%408.71.0%2Bnative7.0.2/typescript-eslint-types-8.71.0-native7.0.2.tgz',
	);
	const unpacked = join(directory, 'published-unpacked');
	mkdirSync(unpacked);
	execFileSync('tar', ['-xzf', join(output, nativeTypesRecipe.file), '-C', unpacked]);
	const payload = join(unpacked, 'package');
	assert.deepEqual(
		readFileSync(join(payload, 'package.json')),
		readFileSync(join(installed, 'package.json')),
		'Keep all canonical metadata, including name, exports, license and version.',
	);
	assert.deepEqual(
		readFileSync(join(payload, 'LICENSE')),
		readFileSync(join(installed, 'LICENSE')),
	);
	const checked = await checkNativeTypes(payload);
	assert.deepEqual(checked.diagnostics, []);
	assert(
		checked.sourceFiles.some(
			(file) => file.includes('/typescript@7.0.2/') && file.endsWith('/dist/api/sync/api.d.ts'),
		),
		'Check ParserOptions.programs against the actual stable native Program declaration.',
	);
	assert.deepEqual(readdirSync(output).sort(), [
		nativeTypesRecipe.file,
		`${nativeTypesRecipe.file}.provenance.json`,
	]);
});

test('rejects unpatched packages and reproduces their native7 declaration errors', async () => {
	const source = join(directory, 'unpatched');
	mkdirSync(source);
	execFileSync('tar', ['-xzf', '-', '-C', source], { input: upstreamBytes });
	const packageDir = join(source, 'package');
	const checked = await checkNativeTypes(packageDir);
	assert(checked.diagnostics.some((diagnostic) => diagnostic.code === 2305));
	const output = join(directory, 'unpatched-output');
	await assert.rejects(
		packNativeTypes({ output, packageDir, upstreamBytes }),
		/Verified native type payload: dist\/generated\/ast-spec\.d\.ts/,
	);
	assert.deepEqual(
		readdirSync(output),
		[],
		'A rejected source leaves no stage or publishable artifact.',
	);
});

test('rejects modified runtime payload instead of certifying only the two patched declarations', async () => {
	const { source, output } = fixture('modified');
	writeFileSync(join(source, 'dist/index.js'), '// replaced published runtime\n');
	await assert.rejects(
		packNativeTypes({ output, packageDir: source, upstreamBytes }),
		/Verified native type payload: dist\/index\.js/,
	);
	assert.deepEqual(readdirSync(output), []);
});

test('rejects missing published declarations and retains native operator type errors', async () => {
	const { source, output } = fixture('missing');
	const checked = await checkNativeTypes(
		source,
		`${nativeTypesConsumer}\nconst broken: TSESTree.AssignmentOperatorToText[SyntaxKind.PlusEqualsToken] = '=';\n`,
	);
	assert.equal(checked.diagnostics.length, 1);
	assert.equal(checked.diagnostics[0].code, 2322);
	rmSync(join(source, 'dist/lib.d.ts'));
	await assert.rejects(
		packNativeTypes({ output, packageDir: source, upstreamBytes }),
		/Preserve the complete upstream package payload/,
	);
	assert.deepEqual(readdirSync(output), []);
});

test('accepts only the maintained canonical dependency descriptor and rejects substituted releases', async () => {
	const output = join(directory, 'dependency-policy');
	mkdirSync(output);
	const descriptor = {
		name: '@typescript-eslint/types',
		version: '8.71.0',
		url: nativeTypesReleaseURI,
		integrity:
			'sha512-ZQUottpsqIEFaMZ7VcAh+p7untkBJXToCINtlwu7PdISnX/ZfkSboKZDkMTHrtbmhIhGj5xGNdZQKEZyxQDRwg==',
	};
	await verifyNativeTypeDependency(nativeTypesReleaseURI, descriptor, output);
	for (const altered of [
		{ ...descriptor, name: '@different/types' },
		{ ...descriptor, version: '8.70.0' },
		{ ...descriptor, url: 'https://example.test/types.tgz' },
	]) {
		await assert.rejects(verifyNativeTypeDependency(nativeTypesReleaseURI, altered, output));
	}
	await assert.rejects(verifyNativeTypeDependency('8.71.0', descriptor, output));
	assert.deepEqual(readdirSync(output), []);
});

test('rejects a valid-looking dependency integrity that differs from the actual authenticated artifact', async () => {
	const output = join(directory, 'dependency-integrity');
	mkdirSync(output);
	await assert.rejects(
		verifyNativeTypeDependency(
			nativeTypesReleaseURI,
			{
				name: '@typescript-eslint/types',
				version: '8.71.0',
				url: nativeTypesReleaseURI,
				integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
			},
			output,
		),
		/The native type-package descriptor must match the complete verified artifact/,
	);
	assert.deepEqual(readdirSync(output), []);
});
