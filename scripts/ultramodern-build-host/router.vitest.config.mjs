import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { octane } from '../../packages/octane/src/compiler/vite.js';
import { octaneServerFixtures } from '../react-parity/server-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const routerAliases = [
	{
		find: /^@octanejs\/tanstack-router$/,
		replacement: resolve(root, 'packages/tanstack-router/src/index.ts'),
	},
	{
		find: /^@octanejs\/tanstack-router\/(.*)$/,
		replacement: resolve(root, 'packages/tanstack-router/src') + '/$1.ts',
	},
];

export default defineConfig({
	root,
	test: {
		projects: [
			{
				root,
				test: {
					name: 'ultramodern-native-router',
					include: ['packages/tanstack-router/tests/**/*.test.ts'],
					exclude: [
						'packages/tanstack-router/tests/differential/**/*.test.ts',
						'packages/tanstack-router/tests/ssr/**/*.test.ts',
					],
					environment: 'jsdom',
					globals: false,
				},
				plugins: [octaneServerFixtures(root), octane()],
				resolve: { alias: routerAliases },
			},
			{
				root,
				test: {
					name: 'ultramodern-native-router-ssr',
					include: ['packages/tanstack-router/tests/ssr/**/*.test.ts'],
					environment: 'node',
					globals: false,
				},
				plugins: [octane({ ssr: true })],
				resolve: {
					alias: [
						{ find: /^octane$/, replacement: resolve(root, 'packages/octane/src/server/index.ts') },
						...routerAliases,
					],
				},
			},
		],
	},
});
