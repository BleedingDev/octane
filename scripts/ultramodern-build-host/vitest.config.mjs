import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { octane } from '../../packages/octane/src/compiler/vite.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const production = process.env.OCTANE_TEST_COMPILE_MODE === 'prod';

// The native compiler and per-test cleanup are the released Octane project
// setup. This bounded host avoids loading unrelated binding/oracle projects.
export default defineConfig({
	root,
	plugins: [octane({ hmr: !production })],
	cacheDir: resolve(
		root,
		'node_modules/.vite',
		production ? 'ultramodern-prod' : 'ultramodern-dev',
	),
	test: {
		name: 'ultramodern-native-source',
		include: ['packages/octane/tests/**/*.test.ts', 'packages/octane/tests/**/*.test.tsrx'],
		environment: 'jsdom',
		setupFiles: [resolve(root, 'packages/octane/tests/_per-test-setup.ts')],
		globals: false,
		env: { OCTANE_TEST_COMPILE_MODE: production ? 'prod' : 'dev' },
	},
});
