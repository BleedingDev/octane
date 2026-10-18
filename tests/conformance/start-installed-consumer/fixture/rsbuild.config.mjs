import { defineConfig } from '@rsbuild/core';
import { tanstackStart } from '@octanejs/tanstack-start/plugin/rsbuild';

export default defineConfig({
	plugins: [tanstackStart({ octane: { hmr: false, parallel: false } })],
});
