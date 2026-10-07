import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = readFileSync(
	resolve(root, '.github/workflows/ultramodern-native-source.yml'),
	'utf8',
);

function step(name) {
	const marker = `      - name: ${name}\n`;
	const start = workflow.indexOf(marker);
	assert.notEqual(start, -1, `Missing source gate: ${name}`);
	const end = workflow.indexOf('\n      - name:', start + marker.length);
	return workflow.slice(start, end === -1 ? undefined : end);
}

function selects(source, files) {
	for (const file of files) {
		assert(source.includes(file), `The source gate must run ${file}`);
		assert(
			existsSync(resolve(root, file)),
			`The source gate must select an existing test: ${file}`,
		);
	}
	assert.doesNotMatch(source, /--passWithNoTests|--exclude|--testNamePattern|(?:^|\s)-t(?:\s|$)/m);
}

test('runs on the reviewed branches and the native HMR pull request and push', () => {
	const triggers = workflow.slice(
		workflow.indexOf('\non:\n'),
		workflow.indexOf('\npermissions:\n'),
	);
	const pullRequest = triggers.slice(
		triggers.indexOf('  pull_request:'),
		triggers.indexOf('  push:'),
	);
	const push = triggers.slice(
		triggers.indexOf('  push:'),
		triggers.indexOf('  workflow_dispatch:'),
	);
	for (const branch of [
		'ultramodern/signal-owner-0.7.1',
		'fix/ultramodern-devalue-5.9.3',
		'feat/ultramodern-external-snapshot',
	])
		assert(pullRequest.includes(branch), `Missing pull request base ${branch}`);
	for (const branch of [
		'ultramodern/signal-owner-0.7.1',
		'fix/ultramodern-*',
		'feat/ultramodern-external-snapshot',
		'feat/ultramodern-native-hmr-20261007',
	])
		assert(push.includes(branch), `Missing push branch ${branch}`);
	assert(pullRequest.includes('ready_for_review'));
	assert.doesNotMatch(
		workflow,
		/pull_request_target|continue-on-error|skipLibCheck|skipDefaultLibCheck/,
	);
	assert.match(workflow, /^permissions:\n  contents: read$/m);
});

test('installs the two frozen hosts and retains repository sync and source integrity', () => {
	for (const [name, directory] of [
		['Install frozen native build host', 'scripts/ultramodern-build-host'],
		['Install frozen supported TSRX checker', 'scripts/ultramodern-build-host/tsrx-check-host'],
	]) {
		const source = step(name);
		assert(source.includes(`working-directory: ${directory}\n`));
		assert(source.includes('pnpm install --frozen-lockfile'));
		assert(source.includes('--store-dir "$RUNNER_TEMP/pnpm-store"'));
		assert(source.includes('--package-import-method clone-or-copy'));
	}
	assert(step('Prepare installed peers for repository sync').includes('prepare-sync.mjs'));
	assert(
		step('Synchronize generated repository metadata').includes(
			'pnpm --config.verify-deps-before-run=warn sync',
		),
	);
	assert(
		step('Test native build helpers').includes('scripts/ultramodern-build-host/workflow.test.mjs'),
	);
	assert(
		step('Test Rspack source pack contract').includes(
			'node --test scripts/ultramodern-build-host/rspack-pack.test.mjs',
		),
	);
	assert.match(
		step('Verify source and frozen lockfiles stayed unchanged'),
		/^      - name: Verify source and frozen lockfiles stayed unchanged\n        run: git diff --exit-code\n?$/,
	);
	assert.equal(workflow.trimEnd().split('\n').at(-1), '        run: git diff --exit-code');
});

test('retains RPC and all reviewed and new document suites in both compiler modes', () => {
	const documentFiles = [
		'hydration/external-snapshot',
		'hydration/all-component-root',
		'hydration/streamed-authority',
		'hydration/provider-ssr-hydrate',
		'hydration/initial-document-signals',
		'hydration/stream-delivery',
		'hydration/automatic-signal-stream',
		'hydration/document-lifecycle',
		'hydration/document-signal-owner',
		'hydration/independent-parent',
		'hydration/nested-head',
		'ssr-render-phase-state',
		'hydration/prepared-external-snapshot',
		'hydration/external-snapshot-budget',
		'hydration/native-streamed-authority',
		'hydration/publisher-boundary',
		'hydration/publisher-boundary-server',
		'hydration/publisher-boundary-protocol',
		'hydration/publisher-component-contract',
		'hydration/publisher-document-authority',
		'scoped-jsx-values',
	].map((name) => `packages/octane/tests/${name}.test.ts`);
	for (const [mode, label] of [
		['dev', 'development'],
		['prod', 'production'],
	]) {
		const rpc = step(`Test RPC and private compiler entrypoints in ${label}`);
		assert(rpc.includes(`OCTANE_TEST_COMPILE_MODE: ${mode}\n`));
		selects(rpc, [
			'packages/octane/tests/server-rpc.test.ts',
			'packages/octane/tests/compiler/private-runtime-entrypoints.test.ts',
		]);
		const documents = step(`Test snapshot and document ownership in ${label}`);
		assert(documents.includes(`OCTANE_TEST_COMPILE_MODE: ${mode}\n`));
		assert(documents.includes('--config scripts/ultramodern-build-host/vitest.config.mjs'));
		selects(documents, documentFiles);
	}
});

test('runs native effect and signal HMR, neighboring signals, and compiler diagnostics', () => {
	const hotFiles = [
		'hmr',
		'effect-callback-contract',
		'signals-hot-declarations',
		'signals-hot-queries',
		'signals-hot-mailbox',
		'signals-hot-cancellation',
		'signals-unified',
		'signals-async',
		'signals-query-attempt-observer',
		'signals-state',
		'signals-local',
		'signals-native-plain-module',
	].map((name) => `packages/octane/tests/${name}.test.ts`);
	for (const [mode, label] of [
		['dev', 'development'],
		['prod', 'production'],
	]) {
		const source = step(`Test native effects and signal HMR in ${label}`);
		assert(source.includes(`OCTANE_TEST_COMPILE_MODE: ${mode}\n`));
		assert(source.includes('--config scripts/ultramodern-build-host/vitest.config.mjs'));
		selects(source, hotFiles);
	}
	selects(
		step('Test native signal compiler and diagnostics'),
		[
			'hot-signal-modules',
			'signal-declarations',
			'compiler-ast-emit-audit',
			'compiler-ast-immutability',
			'bundler-compiler',
			'compile-errors',
			'hook-method-diagnostics',
			'context-provider-errors',
		].map((name) => `packages/octane/tests/compiler/${name}.test.ts`),
	);
	selects(step('Test native error diagnostics'), [
		'scripts/error-codes/generate.test.mjs',
		'scripts/error-codes/specialize-error-calls.test.mjs',
		'scripts/error-codes/compile-node-env.test.mjs',
	]);
	assert(
		step('Check native error codes').includes('node scripts/error-codes/generate.mjs --check'),
	);
});

test('uses the real Rspack loader and watch configuration and both router modes', () => {
	const rspack = step('Test real Rspack loader and watch HMR');
	assert(rspack.includes('working-directory: packages/rspack-plugin-octane\n'));
	assert(rspack.includes('--config vitest.config.js'));
	for (const file of [
		'loader.test.ts',
		'loader.integration.test.ts',
		'streamed-signals-hmr.test.ts',
	]) {
		assert(rspack.includes(`tests/${file}`));
		assert(existsSync(resolve(root, 'packages/rspack-plugin-octane/tests', file)));
	}
	for (const [mode, label] of [
		['dev', 'development'],
		['prod', 'production'],
	]) {
		const router = step(`Test real router snapshot and ownership in ${label}`);
		assert(router.includes(`OCTANE_TEST_COMPILE_MODE: ${mode}\n`));
		assert(router.includes('--config scripts/ultramodern-build-host/router.vitest.config.mjs'));
		assert.match(router, /^          packages\/tanstack-router\/tests$/m);
		assert.doesNotMatch(router, /--exclude|--passWithNoTests|--testNamePattern/);
	}
});

test('checks built native types and supported strict TSRX types with compiler diagnostics fatal', () => {
	const buildPosition = workflow.indexOf('      - name: Build native package\n');
	const checkerPosition = workflow.indexOf(
		'      - name: Check router public types with the supported TSRX checker\n',
	);
	assert(buildPosition > 0 && checkerPosition > buildPosition);
	assert(step('Build native package').includes('node packages/octane/scripts/build.mjs'));
	assert(
		step('Check built public types').includes(
			'node scripts/ultramodern-build-host/check-public-types.mjs',
		),
	);
	const checker = step('Check router public types with the supported TSRX checker');
	assert(
		checker.includes('scripts/ultramodern-build-host/tsrx-check-host/node_modules/.bin/tsrx-tsc'),
	);
	assert(checker.includes('scripts/ultramodern-build-host/router-public-types.tsconfig.json'));
	assert(checker.includes("['--noEmit', '-p', project]"));
	assert(checker.includes("from './scripts/tsrx-typecheck.mjs'"));
	assert(checker.includes('assertTsrxTypecheckSucceeded(result, project)'));
	const manifest = JSON.parse(
		readFileSync(
			resolve(root, 'scripts/ultramodern-build-host/tsrx-check-host/package.json'),
			'utf8',
		),
	);
	assert.equal(manifest.dependencies['@tsrx/typescript-plugin'], '0.6.0');
	assert.equal(manifest.dependencies.typescript, '6.0.3');
	const routerConfig = JSON.parse(
		readFileSync(resolve(root, 'scripts/ultramodern-build-host/router.tsconfig.json'), 'utf8'),
	);
	assert.equal(routerConfig.compilerOptions.strict, true);
	assert.equal(routerConfig.compilerOptions.skipLibCheck, false);
	assert(
		step('Exercise built Node RPC with patched devalue').includes(
			"assert.equal(dependency.version, '5.9.3')",
		),
	);
});
