import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [inputPath, destination] = process.argv.slice(2);
assert(
	inputPath && destination,
	'Usage: node prepare.mjs <archive-inputs.json> <new-consumer-directory>',
);
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
assert.deepEqual(Object.keys(input).sort(), [
	'dependencies',
	'expectedCoreRequest',
	'packageManager',
]);
assert.match(input.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+$/);
const requiredArchives = [
	'octane',
	'@octanejs/rspack-plugin',
	'@octanejs/tanstack-router',
	'@octanejs/tanstack-start',
	'@tanstack/router-core',
	'@tanstack/start-client-core',
	'@tanstack/start-server-core',
	'@tanstack/start-storage-context',
];
const tools = ['@rsbuild/core', '@rspack/core', 'playwright'];
assert.deepEqual(
	Object.keys(input.dependencies ?? {}).sort(),
	[...requiredArchives, ...tools].sort(),
);
for (const name of requiredArchives) {
	const request = input.dependencies?.[name];
	assert.equal(typeof request, 'string', `An actual archive request is required for ${name}`);
	assert(
		/^https:\/\/[^?#]+\.tgz$/.test(request) || /^file:\/[^?#]+\.tgz$/.test(request),
		`${name} must name an HTTPS archive or an absolute file: archive`,
	);
}
assert.equal(input.expectedCoreRequest, input.dependencies['@tanstack/router-core']);
for (const name of tools) {
	assert.match(
		input.dependencies[name] ?? '',
		/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/,
		`${name} needs an exact version`,
	);
}
for (const [name, request] of Object.entries(input.dependencies)) {
	assert.equal(typeof request, 'string', `${name} has no dependency request`);
	assert(!/[\r\n]/.test(request), `${name} has a multiline dependency request`);
}
const root = path.resolve(destination);
const repository = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const parent = realpathSync(path.dirname(root));
assert(
	parent !== repository && !parent.startsWith(repository + path.sep),
	'Create the consumer outside the source workspace',
);
// The caller owns this durable qualification directory and its dependency/build
// outputs. Never overwrite or delete an earlier operation's consumer.
mkdirSync(root);
cpSync(fileURLToPath(new URL('./fixture/', import.meta.url)), root, { recursive: true });
writeFileSync(path.join(root, 'archive-inputs.json'), JSON.stringify(input, null, 2) + '\n');
writeFileSync(
	path.join(root, 'package.json'),
	JSON.stringify(
		{
			name: 'octane-installed-start-acceptance',
			private: true,
			type: 'module',
			packageManager: input.packageManager,
			scripts: { build: 'rsbuild build', acceptance: 'node acceptance.mjs' },
			dependencies: input.dependencies,
		},
		null,
		2,
	) + '\n',
);
// The consumer supplies every authenticated archive directly. Shared runtime
// authorities are required peers, never exotic transitive dependency requests.
writeFileSync(
	path.join(root, 'pnpm-workspace.yaml'),
	'packages: []\npackageImportMethod: clone-or-copy\nautoInstallPeers: false\nblockExoticSubdeps: true\nminimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude: []\n',
);
console.log(`Prepared ${root}. Install normally, check dependencies, build, then run acceptance.`);
