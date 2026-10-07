import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
	assertRequiredPublicValueExports,
	REQUIRED_PUBLIC_VALUE_EXPORTS,
	verifyDist,
} from './verify-dist.mjs';

const fixtures = [];

afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function fixture(cjsDependency) {
	const directory = await mkdtemp(join(tmpdir(), 'octane-dist-'));
	fixtures.push(directory);
	const files = {
		'package.json': JSON.stringify({
			name: 'fixture',
			type: 'module',
			exports: { './signals': './src/signals/index.ts' },
			publishConfig: {
				exports: {
					'./signals': {
						types: './dist/signals/index.d.ts',
						node: './dist/node/signals/index.js',
						default: './dist/signals/index.js',
					},
				},
			},
		}),
		'dist/signals/index.d.ts': 'export declare const helper: object;',
		'dist/signals/index.js': "export { helper } from './hot-declarations.js';",
		'dist/signals/hot-declarations.js': "export { helper } from '../native-hot-owner.js';",
		'dist/native-hot-owner.js': 'export const helper = {};',
		'dist/node/signals/index.js': "export { helper } from './hot-declarations.js';",
		'dist/node/signals/hot-declarations.js': "export { helper } from '../native-hot-owner.js';",
		'dist/node/native-hot-owner.js': 'export const helper = {};',
		'dist/cjs/signals/hot-declarations.cjs': `exports.load = () => require('${cjsDependency}');`,
		'dist/cjs/native-hot-owner.cjs': 'exports.helper = {};',
	};
	await Promise.all(
		Object.entries(files).map(async ([relativePath, contents]) => {
			const path = join(directory, relativePath);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents);
		}),
	);
	return directory;
}

describe('verifyDist parser', () => {
	test('accepts a resolved private CommonJS helper', async () => {
		const directory = await fixture('../native-hot-owner.cjs');
		await assert.doesNotReject(() => verifyDist(directory));
	});

	test('rejects a deferred missing private CommonJS dependency', async () => {
		const directory = await fixture('../missing-native-hot-owner.cjs');
		await assert.rejects(
			() => verifyDist(directory),
			(error) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /unresolvable imports in dist/);
				assert.match(error.message, /hot-declarations\.cjs/);
				assert.match(error.message, /missing-native-hot-owner\.cjs/);
				return true;
			},
		);
	});
});

describe('public hot declaration exports', () => {
	const requiredNames = {
		'.': ['publisherBoundary'],
		'./server': [
			'prepareExternalSnapshotRequest',
			'renderExternalSnapshot',
			'releasePreparedExternalSnapshotRequest',
		],
		'./signals': [
			'__hotSignalModule',
			'__registerHotSignalComponent',
			'__remountHotSignalComponent',
			'__signalAt',
			'__derivedScalarAt',
			'__derivedAt',
			'__queryAt',
		],
	};

	for (const [subpath, names] of Object.entries(requiredNames)) {
		for (const name of names) {
			test(`rejects omitted ${subpath} ${name}`, () => {
				const actualNames = REQUIRED_PUBLIC_VALUE_EXPORTS[subpath].filter(
					(actual) => actual !== name,
				);
				assert.throws(
					() => assertRequiredPublicValueExports(subpath, actualNames),
					(error) => {
						assert.ok(error instanceof Error);
						assert.match(error.message, /omitted required named exports/);
						assert.ok(error.message.includes(name));
						return true;
					},
				);
			});
		}
	}

	test('accepts complete namespaces with harmless additional exports', () => {
		for (const subpath of Object.keys(requiredNames)) {
			assert.doesNotThrow(() =>
				assertRequiredPublicValueExports(subpath, [
					...REQUIRED_PUBLIC_VALUE_EXPORTS[subpath],
					'additionalExport',
				]),
			);
		}
	});

	for (const name of ['createNativeHotSignalOwnerProof', 'admitHotSignalPublisher']) {
		test(`rejects public signals authority ${name}`, () => {
			assert.throws(
				() =>
					assertRequiredPublicValueExports('./signals', [
						...REQUIRED_PUBLIC_VALUE_EXPORTS['./signals'],
						name,
					]),
				(error) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.includes(name));
					return true;
				},
			);
		});
	}
});
