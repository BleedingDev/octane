import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The unmodified corpus generator reads these installed peer manifests from
// their workspace packages. Link the exact bounded-host installations there.
for (const [workspace, name, version] of [
	['i18next', 'i18next', '26.3.6'],
	['tanstack-query', '@tanstack/query-core', '5.102.8'],
]) {
	const installed = realpathSync(resolve(root, 'node_modules', name));
	const manifest = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
	assert.equal(manifest.name, name);
	assert.equal(manifest.version, version);
	const link = resolve(root, 'packages', workspace, 'node_modules', name);
	if (existsSync(link)) {
		assert.equal(realpathSync(link), installed, `Preserve installed ${name}`);
		continue;
	}
	mkdirSync(dirname(link), { recursive: true });
	symlinkSync(relative(dirname(link), installed), link, 'dir');
}
