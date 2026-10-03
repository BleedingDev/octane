import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkTsrxProject } from './check-tsrx-project.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = resolve(root, 'packages/tanstack-router');
const nativePackageRoot = resolve(root, 'packages/octane');
const upstreamCommit = '676a4ee6db59854d6b711921f4ac808845dcdbcd';
const [output, runtimeProvenancePath] = process.argv.slice(2);
assert(output && isAbsolute(output), 'Pass an absolute owned artifact directory.');
assert(
	runtimeProvenancePath && isAbsolute(runtimeProvenancePath),
	'Pass the frozen runtime provenance.',
);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (algorithm, bytes, encoding = 'hex') =>
	createHash(algorithm).update(bytes).digest(encoding);
assert(
	!['main', 'master'].includes(git('branch', '--show-current')),
	'Use the source fork branch.',
);
assert.equal(
	git(
		'status',
		'--porcelain',
		'--',
		'packages/tanstack-router',
		'scripts/ultramodern-build-host',
		'LICENSE',
	),
	'',
	'Commit the complete router and producer source before packing.',
);
const sourceCommit = git('rev-parse', 'HEAD');
const assertFrozenSource = () => {
	assert.equal(
		git('rev-parse', 'HEAD'),
		sourceCommit,
		'The producer source commit changed while packing.',
	);
	assert.equal(
		git(
			'status',
			'--porcelain',
			'--',
			'packages/tanstack-router',
			'scripts/ultramodern-build-host',
			'LICENSE',
		),
		'',
		'The router or producer source changed while packing.',
	);
};
execFileSync('git', ['merge-base', '--is-ancestor', upstreamCommit, sourceCommit], { cwd: root });
const sourceManifestBytes = execFileSync(
	'git',
	['show', `${sourceCommit}:packages/tanstack-router/package.json`],
	{ cwd: root },
);
const licenseBytes = execFileSync('git', ['show', `${sourceCommit}:LICENSE`], { cwd: root });
assert.deepEqual(
	licenseBytes,
	execFileSync('git', ['show', `${upstreamCommit}:LICENSE`], { cwd: root }),
	'Preserve the authoritative upstream MIT license.',
);
const sourceManifest = JSON.parse(sourceManifestBytes);
const { ultramodernSource: source, version } = sourceManifest;
assert.equal(sourceManifest.name, '@octanejs/tanstack-router');
const upstreamManifest = JSON.parse(
	git('show', `${upstreamCommit}:packages/tanstack-router/package.json`),
);
for (const key of [
	'main',
	'module',
	'types',
	'exports',
	'octane',
	'sideEffects',
	'type',
	'engines',
	'license',
])
	assert.deepEqual(
		sourceManifest[key],
		upstreamManifest[key],
		`Preserve the released native ${key} contract`,
	);
assert.equal(source.upstreamCommit, upstreamCommit);
assert.match(source.implementationCommit, /^[a-f0-9]{40}$/);
assert.equal(version, `0.1.60+ultramodern.${source.implementationCommit.slice(0, 12)}`);
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
		'packages/tanstack-router/src',
	],
	{ cwd: root },
);
const sourcePatch = execFileSync(
	'git',
	['diff', upstreamCommit, source.implementationCommit, '--', 'packages/tanstack-router/src'],
	{ cwd: root },
);
assert(sourcePatch.length > 0, 'The maintained router requires an authored source fix.');
assert.equal(source.authoredSourcePatchSha256, digest('sha256', sourcePatch));

const runtimeProvenanceBytes = readFileSync(runtimeProvenancePath);
const runtimeProvenance = JSON.parse(runtimeProvenanceBytes);
assert.equal(runtimeProvenance.package.name, 'octane');
const runtimeArtifact = resolve(runtimeProvenancePath, '..', runtimeProvenance.artifact.file);
const runtimeBytes = readFileSync(runtimeArtifact);
assert.equal(digest('sha256', runtimeBytes), runtimeProvenance.artifact.sha256);
assert.equal(
	`sha512-${digest('sha512', runtimeBytes, 'base64')}`,
	runtimeProvenance.artifact.integrity,
);
const runtime = {
	name: 'octane',
	version: runtimeProvenance.package.version,
	artifactSha256: runtimeProvenance.artifact.sha256,
	provenanceSha256: digest('sha256', runtimeProvenanceBytes),
};
assert.deepEqual(source.nativeRuntime, runtime, 'Bind the selected immutable native runtime.');
assert.equal(sourceManifest.peerDependencies.octane, 'workspace:^0.7.0');
assert.deepEqual(
	Object.keys(sourceManifest.dependencies).sort(),
	Object.keys(upstreamManifest.dependencies).sort(),
	'Preserve the native production dependency names.',
);
for (const [name, pin] of Object.entries(sourceManifest.dependencies))
	assert.match(pin, /^\d+\.\d+\.\d+$/, `Exact native dependency ${name}`);

mkdirSync(output, { recursive: true });
const artifact = resolve(output, `octanejs-tanstack-router-${version}.tgz`);
assert(!existsSync(artifact), 'Use a fresh artifact output; never overwrite a frozen artifact.');
const stage = resolve(output, `.router-stage-${process.pid}`);
const packageStage = resolve(stage, 'package');
const runtimeStage = resolve(stage, 'native-runtime');
mkdirSync(stage);
try {
	mkdirSync(packageStage);
	mkdirSync(runtimeStage);
	const runtimeEntries = execFileSync('tar', ['-tzf', runtimeArtifact], { encoding: 'utf8' })
		.trim()
		.split('\n');
	assert(
		runtimeEntries.every(
			(entry) =>
				/^package(?:\/[A-Za-z0-9@._+/-]+)?\/?$/.test(entry) && !entry.split('/').includes('..'),
		),
		'Validate the frozen native archive paths.',
	);
	execFileSync('tar', ['-xzf', runtimeArtifact, '-C', runtimeStage]);
	const runtimeManifestBytes = readFileSync(resolve(runtimeStage, 'package/package.json'));
	assert.equal(
		digest('sha256', runtimeManifestBytes),
		runtimeProvenance.artifact.publishManifestSha256,
	);
	const runtimeManifest = JSON.parse(runtimeManifestBytes);
	assert.equal(runtimeManifest.name, 'octane');
	assert.equal(runtimeManifest.version, runtime.version);
	assert(
		runtimeEntries.some((entry) => entry === 'package/dist/compiler/volar.js'),
		'Use the actual frozen native compiler.',
	);
	// Materialize only committed authored Git objects. The same immutable source
	// snapshot is checked and published, independent of later working-tree edits.
	const tree = execFileSync(
		'git',
		[
			'ls-tree',
			'-r',
			'-z',
			sourceCommit,
			'--',
			'packages/tanstack-router/src',
			'packages/tanstack-router/README.md',
		],
		{ cwd: root },
	)
		.toString('utf8')
		.split('\0')
		.filter(Boolean);
	for (const entry of tree) {
		const match =
			/^(100644|100755) blob ([a-f0-9]{40})\t(packages\/tanstack-router\/(?:src\/.*|README\.md))$/.exec(
				entry,
			);
		assert(match, `Only regular committed source files may be published: ${entry}`);
		const [, , object, path] = match;
		const target = resolve(packageStage, path.slice('packages/tanstack-router/'.length));
		assert(target.startsWith(`${packageStage}/`));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, execFileSync('git', ['cat-file', 'blob', object], { cwd: root }));
	}
	writeFileSync(resolve(packageStage, 'LICENSE'), licenseBytes);
	const published = { ...sourceManifest };
	published.peerDependencies = { ...sourceManifest.peerDependencies, octane: '^0.7.0' };
	delete published.publishConfig;
	delete published.scripts;
	delete published.devDependencies;
	const publishManifestBytes = Buffer.from(`${JSON.stringify(published, null, 2)}\n`);
	writeFileSync(resolve(packageStage, 'package.json'), publishManifestBytes);
	const stagedModules = resolve(stage, 'node_modules');
	mkdirSync(stagedModules);
	const linkPackage = (name, target) => {
		const destination = resolve(stagedModules, name);
		mkdirSync(dirname(destination), { recursive: true });
		symlinkSync(target, destination, 'dir');
	};
	linkPackage('octane', resolve(runtimeStage, 'package'));
	linkPackage('@octanejs/tanstack-router', packageStage);
	for (const [dependencies, context] of [
		[runtimeManifest.dependencies, nativePackageRoot],
		[sourceManifest.dependencies, packageRoot],
	]) {
		for (const [name, pin] of Object.entries(dependencies)) {
			assert.match(pin, /^\d+\.\d+\.\d+$/, `Exact checker dependency ${name}`);
			const installed = realpathSync(resolve(context, 'node_modules', name));
			const installedManifest = JSON.parse(readFileSync(resolve(installed, 'package.json')));
			assert.equal(installedManifest.name, name);
			assert.equal(installedManifest.version, pin, `Checker dependency ${name}`);
			linkPackage(name, installed);
		}
	}
	linkPackage('@types/node', realpathSync(resolve(root, 'node_modules/@types/node')));
	linkPackage('typescript', realpathSync(resolve(root, 'node_modules/typescript')));
	const checkerConfig = JSON.parse(
		execFileSync(
			'git',
			['show', `${sourceCommit}:scripts/ultramodern-build-host/router.tsconfig.json`],
			{ cwd: root },
		),
	);
	// Resolve the public native exports from the complete frozen package. There
	// are no compiler or view-module aliases in this staged consumer.
	delete checkerConfig.compilerOptions.paths;
	checkerConfig.compilerOptions.typeRoots = [resolve(root, 'node_modules/@types')];
	checkerConfig.files = [realpathSync(resolve(root, 'node_modules/@types/node/index.d.ts'))];
	checkerConfig.include = [resolve(packageStage, 'src/**/*')];
	const checkerPath = resolve(stage, 'tsconfig.json');
	writeFileSync(checkerPath, `${JSON.stringify(checkerConfig, null, 2)}\n`);
	const nativeCompiler = await import(
		pathToFileURL(resolve(runtimeStage, 'package', runtimeManifest.exports['./compiler/volar']))
			.href
	);
	const checked = checkTsrxProject({
		configPath: checkerPath,
		compileToVolarMappings: nativeCompiler.compileToVolarMappings,
	});
	if (checked.diagnostics.length) console.error(JSON.stringify(checked.diagnostics, null, 2));
	assert.equal(
		checked.diagnostics.length,
		0,
		'The frozen native router must pass its complete strict TypeScript 7 project.',
	);
	assertFrozenSource();
	const inventory = [];
	const epoch = Number(git('show', '-s', '--format=%ct', sourceCommit));
	const members = [];
	const normalize = (path, member) => {
		const directory = statSync(path).isDirectory();
		members.push(member);
		if (directory)
			for (const file of readdirSync(path).sort())
				normalize(resolve(path, file), `${member}/${file}`);
		else
			inventory.push({
				file: member.slice('package/'.length),
				sha256: digest('sha256', readFileSync(path)),
			});
		chmodSync(path, directory ? 0o755 : 0o644);
		utimesSync(path, epoch, epoch);
	};
	normalize(packageStage, 'package');
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
	assertFrozenSource();
	const bytes = execFileSync('gzip', ['-n', '-c'], {
		input: archive,
		maxBuffer: 128 * 1024 * 1024,
	});
	writeFileSync(artifact, bytes);
	const file = basename(artifact);
	const provenance = {
		schemaVersion: 1,
		package: { name: '@octanejs/tanstack-router', version },
		upstream: {
			repository: 'https://github.com/octanejs/octane',
			tag: 'octane@0.7.1',
			commit: upstreamCommit,
			packageVersion: '0.1.60',
		},
		source: {
			repository: 'https://github.com/bleedingdev/octane',
			commit: sourceCommit,
			implementationCommit: source.implementationCommit,
			authoredSourcePatchSha256: source.authoredSourcePatchSha256,
		},
		producer: {
			node: process.version,
			pnpm: execFileSync('pnpm', ['--version'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
			hostLockSha256: digest(
				'sha256',
				readFileSync(resolve(root, 'scripts/ultramodern-build-host/pnpm-lock.yaml')),
			),
			sourceManifestSha256: digest('sha256', sourceManifestBytes),
			nativeRuntime: runtime,
		},
		artifact: {
			file,
			sha256: digest('sha256', bytes),
			integrity: `sha512-${digest('sha512', bytes, 'base64')}`,
			publishManifestSha256: digest('sha256', publishManifestBytes),
			sourceInventorySha256: digest('sha256', Buffer.from(`${JSON.stringify(inventory)}\n`)),
			intendedReleaseURI: `https://github.com/bleedingdev/octane/releases/download/${encodeURIComponent(`@octanejs/tanstack-router@${version}`)}/${encodeURIComponent(file)}`,
		},
		inventory,
	};
	const provenancePath = `${artifact}.provenance.json`;
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
} finally {
	// Only this invocation's fresh task-owned stage is removed.
	rmSync(stage, { recursive: true, force: true });
}
