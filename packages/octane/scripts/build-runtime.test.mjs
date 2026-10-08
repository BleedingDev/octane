import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { buildPublishedRuntime, COMMONJS_ENTRIES } from './build-runtime.mjs';
import { verifyDist } from './verify-dist.mjs';

test('published server dynamic imports resolve in all three native runtime trees', async () => {
	const packageDir = await mkdtemp(join(tmpdir(), 'octane-runtime-build-'));
	try {
		const publishedExports = {
			'.': {
				node: {
					import: './dist/node/index.js',
					require: './dist/cjs/index.cjs',
					default: './dist/node/index.js',
				},
				import: './dist/index.js',
				require: './dist/cjs/index.cjs',
				default: './dist/index.js',
			},
		};
		const files = {
			...Object.fromEntries(COMMONJS_ENTRIES.map((file) => [file, 'export {};'])),
			'package.json': JSON.stringify({
				name: 'fixture',
				type: 'module',
				exports: publishedExports,
				publishConfig: { exports: publishedExports },
			}),
			'src/index.ts':
				"export { load } from './runtime.server.js'; export { state } from './state.js';",
			'src/server/index.ts': "export { load } from '../runtime.server.js';",
			'src/runtime.server.ts': `export async function load() {
 const { createAutomaticStreamedSignalInjection } = await import('./server/streamed-signals.js');
 return createAutomaticStreamedSignalInjection();
}`,
			'src/state.ts': 'export const state = { loads: 0 };',
			'src/server/streamed-signals.ts': `import { state } from '../state.js';
state.loads++;
export function createAutomaticStreamedSignalInjection() { return 'native:' + state.loads; }`,
		};
		await Promise.all(
			Object.entries(files).map(async ([file, contents]) => {
				const path = join(packageDir, file);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, contents);
			}),
		);
		await buildPublishedRuntime(packageDir);
		await verifyDist(packageDir);
		for (const directory of ['dist', 'dist/node']) {
			assert.match(
				await readFile(join(packageDir, directory, 'runtime.server.js'), 'utf8'),
				/import\("\.\/server\/streamed-signals\.js"\)/,
			);
			const emitted = await import(pathToFileURL(join(packageDir, directory, 'index.js')).href);
			assert.equal(emitted.state.loads, 0);
			assert.equal(await emitted.load(), 'native:1');
			assert.equal(await emitted.load(), 'native:1');
			assert.equal(emitted.state.loads, 1);
		}
		assert.match(
			await readFile(join(packageDir, 'dist/cjs/runtime.server.cjs'), 'utf8'),
			/import\("\.\/server\/streamed-signals\.cjs"\)/,
		);
		const require = createRequire(join(packageDir, 'package.json'));
		assert.equal(require.resolve('fixture'), join(packageDir, 'dist/cjs/index.cjs'));
		const emitted = require('fixture');
		assert.equal(emitted.state.loads, 0);
		assert.equal(await emitted.load(), 'native:1');
		assert.equal(await emitted.load(), 'native:1');
		assert.equal(emitted.state.loads, 1);
	} finally {
		await rm(packageDir, { recursive: true, force: true });
	}
});
