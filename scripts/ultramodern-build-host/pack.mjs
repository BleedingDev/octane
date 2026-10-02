import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = resolve(root, 'packages/octane');
const upstreamCommit = '676a4ee6db59854d6b711921f4ac808845dcdbcd';
const output = process.argv[2];
assert(output && isAbsolute(output), 'Pass an absolute owned artifact directory.');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert(
	!['main', 'master'].includes(git('branch', '--show-current')),
	'Use the source fork branch.',
);
const corpus = [
	'packages/octane',
	'scripts/ultramodern-build-host',
	'scripts/error-codes',
	'scripts/build-package-commonjs.mjs',
	'benchmarks/scoped-signals/native-presentation',
	'LICENSE',
	'.prettierrc',
];
assert.equal(
	git('status', '--porcelain', '--', ...corpus),
	'',
	'Commit the complete producer source before packing.',
);
const sourceCommit = git('rev-parse', 'HEAD');
execFileSync('git', ['merge-base', '--is-ancestor', upstreamCommit, sourceCommit], { cwd: root });

const sourceManifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const { ultramodernSource: source, version } = sourceManifest;
assert.equal(sourceManifest.name, 'octane');
assert.equal(source.upstreamCommit, upstreamCommit);
assert.match(source.implementationCommit, /^[a-f0-9]{40}$/);
assert.equal(version, `0.7.1+ultramodern.${source.implementationCommit.slice(0, 12)}`);
execFileSync('git', ['merge-base', '--is-ancestor', source.implementationCommit, sourceCommit], {
	cwd: root,
});
execFileSync(
	'git',
	[
		'diff',
		'--exit-code',
		source.implementationCommit,
		sourceCommit,
		'--',
		'packages/octane/src',
		':(exclude)packages/octane/src/version.ts',
	],
	{ cwd: root },
);
const runtimePatch = execFileSync(
	'git',
	['diff', upstreamCommit, source.implementationCommit, '--', 'packages/octane/src/runtime.ts'],
	{ cwd: root },
);
const digest = (algorithm, bytes, encoding = 'hex') =>
	createHash(algorithm).update(bytes).digest(encoding);
assert(runtimePatch.length > 0, 'A maintained source fix must contain an authored runtime diff.');
assert.equal(source.runtimePatchSha256, digest('sha256', runtimePatch));
const authoredSourcePatch = execFileSync(
	'git',
	[
		'diff',
		upstreamCommit,
		source.implementationCommit,
		'--',
		'packages/octane/src',
		':(exclude)packages/octane/src/version.ts',
	],
	{ cwd: root },
);
assert.equal(source.authoredSourcePatchSha256, digest('sha256', authoredSourcePatch));

mkdirSync(output, { recursive: true });
const artifact = resolve(output, `octane-${version}.tgz`);
// Run exact native prepack gates. Package managers strip SemVer build metadata,
// so apply the native publishConfig directly in the npm-format source artifact.
assert.equal(
	sourceManifest.scripts.prepack,
	'node ../../scripts/error-codes/generate.mjs --check && node scripts/build.mjs',
);
execFileSync(process.execPath, [resolve(root, 'scripts/error-codes/generate.mjs'), '--check'], {
	cwd: packageRoot,
	stdio: 'inherit',
});
execFileSync(process.execPath, [resolve(packageRoot, 'scripts/build.mjs')], {
	cwd: packageRoot,
	stdio: 'inherit',
});
execFileSync(
	process.execPath,
	[resolve(root, 'scripts/ultramodern-build-host/check-public-types.mjs')],
	{ cwd: root, stdio: 'inherit' },
);
const stage = resolve(output, `.native-stage-${process.pid}`);
const packageStage = resolve(stage, 'package');
mkdirSync(stage);
mkdirSync(packageStage);
try {
	for (const file of ['dist', 'README.md', 'LICENSE']) {
		if (process.platform === 'darwin')
			execFileSync('cp', ['-cR', resolve(packageRoot, file), resolve(packageStage, file)]);
		else cpSync(resolve(packageRoot, file), resolve(packageStage, file), { recursive: true });
	}
	const published = { ...sourceManifest };
	for (const key of ['main', 'module', 'types', 'imports', 'exports'])
		published[key] = sourceManifest.publishConfig[key];
	delete published.publishConfig;
	delete published.scripts;
	delete published.devDependencies;
	writeFileSync(resolve(packageStage, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
	const epoch = Number(git('show', '-s', '--format=%ct', sourceCommit));
	const normalize = (path) => {
		const directory = statSync(path).isDirectory();
		if (directory) for (const file of readdirSync(path).sort()) normalize(resolve(path, file));
		chmodSync(path, directory ? 0o755 : 0o644);
		utimesSync(path, epoch, epoch);
	};
	normalize(packageStage);
	const members = [];
	const collect = (path, member) => {
		members.push(member);
		if (statSync(path).isDirectory())
			for (const file of readdirSync(path).sort())
				collect(resolve(path, file), `${member}/${file}`);
	};
	collect(packageStage, 'package');
	const archive = execFileSync(
		'tar',
		[
			'-cf',
			'-',
			'--format=ustar',
			'--uid',
			'0',
			'--gid',
			'0',
			'--uname',
			'root',
			'--gname',
			'root',
			'--no-recursion',
			...(process.platform === 'darwin' ? ['--no-xattrs', '--no-acls', '--no-fflags'] : []),
			'-C',
			stage,
			'-T',
			'-',
		],
		{ input: `${members.join('\n')}\n`, maxBuffer: 128 * 1024 * 1024 },
	);
	const bytes = execFileSync('gzip', ['-n', '-c'], {
		input: archive,
		maxBuffer: 128 * 1024 * 1024,
	});
	writeFileSync(artifact, bytes);
} finally {
	// Only this invocation's freshly created, task-owned stage is removed.
	rmSync(stage, { recursive: true, force: true });
}
const packedManifest = JSON.parse(
	execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }),
);
assert.equal(packedManifest.name, 'octane');
assert.equal(packedManifest.version, version);
assert.deepEqual(packedManifest.ultramodernSource, source);
for (const key of ['main', 'module', 'types', 'imports', 'exports']) {
	assert.deepEqual(
		packedManifest[key],
		sourceManifest.publishConfig[key],
		`Native ${key} publish contract`,
	);
}
for (const [name, pin] of Object.entries(sourceManifest.dependencies)) {
	assert.match(pin, /^\d+\.\d+\.\d+$/, `Exact native dependency ${name}`);
	assert.equal(packedManifest.dependencies[name], pin);
}
const entries = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
assert(entries.includes('package/LICENSE'), 'Retain the upstream MIT license.');
assert(entries.includes('package/dist/index.js'), 'Native browser output is required.');
assert(entries.includes('package/dist/node/index.js'), 'Native Node output is required.');
assert(entries.includes('package/dist/cjs/index.cjs'), 'Native CommonJS output is required.');
assert(entries.includes('package/dist/index.d.ts'), 'Native declarations are required.');
assert(
	entries.includes('package/dist/compiler/index.js'),
	'Native authored compiler output is required.',
);
assert(!entries.some((entry) => entry.startsWith('package/node_modules/')));

const bytes = readFileSync(artifact);
const file = basename(artifact);
const releaseTag = `octane@${version}`;
const provenance = {
	schemaVersion: 1,
	package: { name: 'octane', version },
	upstream: {
		repository: 'https://github.com/octanejs/octane',
		tag: 'octane@0.7.1',
		commit: upstreamCommit,
	},
	source: {
		repository: 'https://github.com/bleedingdev/octane',
		commit: sourceCommit,
		implementationCommit: source.implementationCommit,
		runtimePatchSha256: source.runtimePatchSha256,
		authoredSourcePatchSha256: source.authoredSourcePatchSha256,
	},
	producer: {
		node: process.version,
		pnpm: execFileSync('pnpm', ['--version'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
		hostLockSha256: digest(
			'sha256',
			readFileSync(resolve(root, 'scripts/ultramodern-build-host/pnpm-lock.yaml')),
		),
		sourceManifestSha256: digest('sha256', readFileSync(resolve(packageRoot, 'package.json'))),
	},
	artifact: {
		file,
		sha256: digest('sha256', bytes),
		integrity: `sha512-${digest('sha512', bytes, 'base64')}`,
		publishManifestSha256: digest(
			'sha256',
			execFileSync('tar', ['-xOf', artifact, 'package/package.json']),
		),
		intendedReleaseURI: `https://github.com/bleedingdev/octane/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(file)}`,
	},
};
const provenancePath = resolve(output, `${file}.provenance.json`);
const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
writeFileSync(provenancePath, provenanceBytes);
console.log(
	JSON.stringify(
		{
			artifact,
			provenancePath,
			provenanceSha256: digest('sha256', provenanceBytes),
			...provenance.artifact,
		},
		null,
		2,
	),
);
