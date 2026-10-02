import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, cpSync, existsSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Install this bounded host with its frozen lock and clone-or-copy package
// imports first. Native build scripts intentionally resolve tools at the
// released repository root; give them an independent dependency tree.
const host = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(host, '../..');
const destination = resolve(root, 'node_modules');
assert(existsSync(resolve(host, 'node_modules/.pnpm')), 'Install the bounded host first.');
assert(
	!existsSync(destination),
	'Preserve existing root dependencies; use a fresh source worktree.',
);
if (process.platform === 'darwin') {
	// APFS CoW failure is terminal. Never silently replace this with a full copy.
	execFileSync('cp', ['-cR', resolve(host, 'node_modules'), destination], { stdio: 'inherit' });
} else {
	cpSync(resolve(host, 'node_modules'), destination, {
		recursive: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
	});
}
// Normal workspace package identity, shared by the native compiler and tests.
symlinkSync('../packages/octane', resolve(destination, 'octane'), 'dir');
console.log(`Prepared independent native source tools at ${destination}`);
