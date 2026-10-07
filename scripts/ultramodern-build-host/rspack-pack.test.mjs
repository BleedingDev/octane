import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { packRspackCandidate } from './rspack-pack.mjs';

const pluginPath = 'packages/rspack-plugin-octane';
const runtimePath = 'packages/octane';
const sourceIndex = 'export const generation = "publisher-v2";\n';
const sourceTypes = 'export declare const generation: "publisher-v2";\n';
const license = 'MIT License\n\nCopyright (c) fixture authors\n';
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') =>
	createHash(algorithm).update(bytes).digest(encoding);

function write(root, path, value) {
	const target = resolve(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, value);
}

function writeJSON(root, path, value) {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root, ...args) {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function commit(root, message) {
	git(root, 'add', '--all');
	execFileSync('git', ['commit', '--quiet', '-m', message], {
		cwd: root,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: '2026-10-07T12:00:00Z',
			GIT_COMMITTER_DATE: '2026-10-07T12:00:00Z',
		},
	});
	return git(root, 'rev-parse', 'HEAD');
}

function sourcePatch(root, upstreamCommit, implementationCommit, paths) {
	return execFileSync('git', ['diff', upstreamCommit, implementationCommit, '--', ...paths], {
		cwd: root,
	});
}

function runtimeArchive(fixture, publishedManifest) {
	const stage = resolve(fixture.directory, 'runtime-stage');
	mkdirSync(resolve(stage, 'package'), { recursive: true });
	try {
		writeJSON(stage, 'package/package.json', publishedManifest);
		write(stage, 'package/README.md', '# Native runtime fixture\n');
		write(stage, 'package/LICENSE', license);
		for (const path of [
			'dist/index.js',
			'dist/node/index.js',
			'dist/cjs/index.cjs',
			'dist/compiler/index.js',
			'dist/compiler/parser.js',
			'dist/compiler/volar.js',
		])
			write(stage, `package/${path}`, 'export {};\n');
		write(stage, 'package/dist/index.d.ts', 'export {};\n');
		execFileSync('tar', ['-czf', fixture.runtimeArtifact, '-C', stage, 'package']);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

function createFixture(t, { implementation, beforeMetadata } = {}) {
	const owned = process.env.OWNED_TEMP_DIR;
	assert(owned && isAbsolute(owned), 'Run this suite inside owned-temp-dir.');
	const directory = mkdtempSync(resolve(owned, 'rspack-pack-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = resolve(directory, 'source');
	mkdirSync(root);
	git(root, 'init', '--quiet', '-b', 'fixture-candidate');
	git(root, 'config', 'user.name', 'Pack fixture');
	git(root, 'config', 'user.email', 'pack-fixture@example.invalid');
	git(root, 'config', 'commit.gpgsign', 'false');
	git(root, 'config', 'core.hooksPath', '/dev/null');
	write(root, 'LICENSE', license);
	write(root, '.gitignore', 'node_modules/\n');
	writeJSON(root, 'package.json', {
		name: 'rspack-source-fixture',
		private: true,
		type: 'module',
		packageManager: 'pnpm@11.15.1',
	});
	write(
		root,
		'pnpm-workspace.yaml',
		"packages:\n  - packages/*\ncatalogs:\n  default:\n    '@jridgewell/remapping': ^2.3.5\n",
	);
	write(root, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
	writeJSON(root, 'scripts/ultramodern-build-host/package.json', {
		name: 'rspack-fixture-host',
		private: true,
		type: 'module',
		packageManager: 'pnpm@11.15.1',
	});
	write(root, 'scripts/ultramodern-build-host/pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
	write(
		root,
		'scripts/ultramodern-build-host/rspack-pack.mjs',
		readFileSync(new URL('./rspack-pack.mjs', import.meta.url)),
	);
	const pluginManifest = {
		name: '@octanejs/rspack-plugin',
		version: '0.1.55',
		license: 'MIT',
		type: 'module',
		engines: { node: '>=22.22.2' },
		publishConfig: { access: 'public' },
		repository: {
			type: 'git',
			url: 'git+https://github.com/octanejs/octane.git',
			directory: pluginPath,
		},
		files: ['src', 'types', 'README.md', 'LICENSE'],
		main: 'src/index.js',
		module: 'src/index.js',
		types: 'types/index.d.ts',
		exports: {
			'.': { types: './types/index.d.ts', import: './src/index.js', default: './src/index.js' },
			'./loader': {
				types: './types/loader.d.ts',
				import: './src/loader.js',
				default: './src/loader.js',
			},
		},
		dependencies: { '@jridgewell/remapping': 'catalog:default' },
		peerDependencies: { '@rspack/core': '^2.0.0', octane: 'workspace:^' },
	};
	writeJSON(root, `${pluginPath}/package.json`, pluginManifest);
	write(root, `${pluginPath}/src/index.js`, 'export const generation = "upstream";\n');
	write(
		root,
		`${pluginPath}/src/loader.js`,
		'export default function loader(value) { return value; }\n',
	);
	write(root, `${pluginPath}/types/index.d.ts`, 'export declare const generation: "upstream";\n');
	write(
		root,
		`${pluginPath}/types/loader.d.ts`,
		'export default function loader(value: string): string;\n',
	);
	write(root, `${pluginPath}/README.md`, '# Rspack source fixture\n');
	write(root, `${pluginPath}/LICENSE`, license);
	const runtimeManifest = {
		name: 'octane',
		version: '0.7.1',
		license: 'MIT',
		type: 'module',
		main: 'src/index.ts',
		module: 'src/index.ts',
		types: 'src/index.ts',
		imports: { '#octane/compiler-parser': './src/compiler/parser.js' },
		exports: { '.': './src/index.ts', './compiler': './src/compiler/index.js' },
		dependencies: {},
		publishConfig: {
			main: './dist/index.js',
			module: './dist/index.js',
			types: './dist/index.d.ts',
			imports: { '#octane/compiler-parser': './dist/compiler/parser.js' },
			exports: { '.': './dist/index.js', './compiler': './dist/compiler/index.js' },
		},
	};
	writeJSON(root, `${runtimePath}/package.json`, runtimeManifest);
	write(root, `${runtimePath}/src/index.ts`, 'export * from "./runtime.js";\n');
	write(root, `${runtimePath}/src/runtime.ts`, 'export const nativeOwner = "upstream";\n');
	write(root, `${runtimePath}/src/version.ts`, 'export const VERSION = "0.7.1";\n');
	const upstreamCommit = commit(root, 'Fixture upstream');
	write(root, `${pluginPath}/src/index.js`, sourceIndex);
	write(root, `${pluginPath}/types/index.d.ts`, sourceTypes);
	write(root, `${runtimePath}/src/runtime.ts`, 'export const nativeOwner = "publisher";\n');
	implementation?.(root);
	const implementationCommit = commit(root, 'Fixture authored implementation');
	const pluginVersion = `0.1.55+ultramodern.${implementationCommit.slice(0, 12)}`;
	const runtimeVersion = `0.7.1+ultramodern.${implementationCommit.slice(0, 12)}`;
	runtimeManifest.version = runtimeVersion;
	runtimeManifest.ultramodernSource = {
		upstreamCommit,
		implementationCommit,
		runtimePatchSha256: digest(
			sourcePatch(root, upstreamCommit, implementationCommit, [`${runtimePath}/src/runtime.ts`]),
		),
		authoredSourcePatchSha256: digest(
			sourcePatch(root, upstreamCommit, implementationCommit, [
				`${runtimePath}/src`,
				`:(exclude)${runtimePath}/src/version.ts`,
			]),
		),
	};
	writeJSON(root, `${runtimePath}/package.json`, runtimeManifest);
	write(
		root,
		`${runtimePath}/src/version.ts`,
		`export const VERSION = ${JSON.stringify(runtimeVersion)};\n`,
	);
	const publishedRuntime = { ...runtimeManifest, ...runtimeManifest.publishConfig };
	delete publishedRuntime.publishConfig;
	const fixture = {
		directory,
		root,
		upstreamCommit,
		implementationCommit,
		pluginVersion,
		runtimeVersion,
		pluginManifest,
		runtimeManifest,
		runtimeArtifact: resolve(directory, `octane-${runtimeVersion}.tgz`),
		runtimeProvenancePath: resolve(directory, `octane-${runtimeVersion}.tgz.provenance.json`),
	};
	runtimeArchive(fixture, publishedRuntime);
	const runtimeBytes = readFileSync(fixture.runtimeArtifact);
	fixture.runtimeProvenance = {
		schemaVersion: 1,
		package: { name: 'octane', version: runtimeVersion },
		upstream: {
			repository: 'https://github.com/octanejs/octane',
			tag: 'octane@0.7.1',
			commit: upstreamCommit,
		},
		source: {
			repository: 'https://github.com/bleedingdev/octane',
			commit: implementationCommit,
			implementationCommit,
			runtimePatchSha256: runtimeManifest.ultramodernSource.runtimePatchSha256,
			authoredSourcePatchSha256: runtimeManifest.ultramodernSource.authoredSourcePatchSha256,
		},
		producer: {
			sourceManifestSha256: digest(readFileSync(resolve(root, `${runtimePath}/package.json`))),
		},
		artifact: {
			file: basename(fixture.runtimeArtifact),
			sha256: digest(runtimeBytes),
			integrity: `sha512-${digest(runtimeBytes, 'sha512', 'base64')}`,
			publishManifestSha256: digest(
				execFileSync('tar', ['-xOf', fixture.runtimeArtifact, 'package/package.json']),
			),
		},
	};
	writeJSON(directory, basename(fixture.runtimeProvenancePath), fixture.runtimeProvenance);
	pluginManifest.version = pluginVersion;
	pluginManifest.ultramodernSource = {
		upstreamCommit,
		implementationCommit,
		authoredSourcePatchSha256: digest(
			sourcePatch(root, upstreamCommit, implementationCommit, [
				`${pluginPath}/src`,
				`${pluginPath}/types`,
			]),
		),
		nativeRuntime: nativeRuntime(fixture),
	};
	writeJSON(root, `${pluginPath}/package.json`, pluginManifest);
	beforeMetadata?.(root);
	fixture.sourceCommit = commit(root, 'Fixture publication metadata');
	fixture.runtimeProvenance.source.commit = fixture.sourceCommit;
	writeJSON(directory, basename(fixture.runtimeProvenancePath), fixture.runtimeProvenance);
	pluginManifest.ultramodernSource.nativeRuntime = nativeRuntime(fixture);
	writeJSON(root, `${pluginPath}/package.json`, pluginManifest);
	fixture.sourceCommit = commit(root, 'Bind frozen runtime provenance');
	return fixture;
}

function nativeRuntime(fixture) {
	return {
		name: 'octane',
		version: fixture.runtimeVersion,
		artifactSha256: digest(readFileSync(fixture.runtimeArtifact)),
		provenanceSha256: digest(readFileSync(fixture.runtimeProvenancePath)),
	};
}

function rebindRuntime(fixture) {
	writeJSON(fixture.directory, basename(fixture.runtimeProvenancePath), fixture.runtimeProvenance);
	fixture.pluginManifest.ultramodernSource.nativeRuntime = nativeRuntime(fixture);
	writeJSON(fixture.root, `${pluginPath}/package.json`, fixture.pluginManifest);
	fixture.sourceCommit = commit(fixture.root, 'Bind changed runtime fixture');
}

function pack(fixture, output) {
	packRspackCandidate({
		root: fixture.root,
		output,
		runtimeProvenancePath: fixture.runtimeProvenancePath,
		upstreamCommit: fixture.upstreamCommit,
	});
}

function reject(fixture) {
	const before = git(fixture.root, 'status', '--porcelain', '--untracked-files=all');
	const output = resolve(fixture.directory, 'rejected');
	assert.throws(() => pack(fixture, output));
	assert.equal(git(fixture.root, 'status', '--porcelain', '--untracked-files=all'), before);
	if (existsSync(output)) assert.deepEqual(readdirSync(output), []);
}

function assertArchiveEpoch(bytes, epoch) {
	const tar = gunzipSync(bytes);
	let offset = 0;
	let members = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(header.toString('ascii', 124, 136).replace(/\0/g, '').trim(), 8);
		const mtime = Number.parseInt(header.toString('ascii', 136, 148).replace(/\0/g, '').trim(), 8);
		assert.equal(mtime, epoch, 'Archive member timestamps come from the frozen source commit.');
		assert(Number.isSafeInteger(size) && size >= 0);
		members++;
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	assert(members > 0);
}

test('packs real committed source with resolved peers and deterministic provenance', async (t) => {
	const fixture = createFixture(t);
	const first = resolve(fixture.directory, 'first');
	const second = resolve(fixture.directory, 'second');
	pack(fixture, first);
	for (const path of ['src/index.js', 'types/index.d.ts', 'README.md'])
		utimesSync(resolve(fixture.root, pluginPath, path), 946684800, 946684800);
	pack(fixture, second);
	const names = readdirSync(first).sort();
	assert.equal(names.length, 2);
	const archiveName = names.find((name) => name.endsWith('.tgz'));
	assert(archiveName);
	assert.deepEqual(readdirSync(second).sort(), names);
	const artifact = resolve(first, archiveName);
	const bytes = readFileSync(artifact);
	assertArchiveEpoch(
		bytes,
		Number(git(fixture.root, 'show', '-s', '--format=%ct', fixture.sourceCommit)),
	);
	assert.deepEqual(readFileSync(resolve(second, archiveName)), bytes);
	const provenanceName = `${archiveName}.provenance.json`;
	assert.deepEqual(
		readFileSync(resolve(second, provenanceName)),
		readFileSync(resolve(first, provenanceName)),
	);
	const contents = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
	const files = contents.filter((entry) => !entry.endsWith('/')).sort();
	assert.deepEqual(files, [
		'package/LICENSE',
		'package/README.md',
		'package/package.json',
		'package/src/index.js',
		'package/src/loader.js',
		'package/types/index.d.ts',
		'package/types/loader.d.ts',
	]);
	assert.equal(
		execFileSync('tar', ['-xOf', artifact, 'package/src/index.js'], { encoding: 'utf8' }),
		sourceIndex,
	);
	assert.equal(
		execFileSync('tar', ['-xOf', artifact, 'package/types/index.d.ts'], { encoding: 'utf8' }),
		sourceTypes,
	);
	assert.equal(
		execFileSync('tar', ['-xOf', artifact, 'package/LICENSE'], { encoding: 'utf8' }),
		license,
	);
	const publishBytes = execFileSync('tar', ['-xOf', artifact, 'package/package.json']);
	const published = JSON.parse(publishBytes);
	assert.equal(published.name, '@octanejs/rspack-plugin');
	assert.equal(published.version, fixture.pluginVersion);
	assert.deepEqual(published.ultramodernSource, fixture.pluginManifest.ultramodernSource);
	assert.deepEqual(published.exports, fixture.pluginManifest.exports);
	assert.deepEqual(published.dependencies, { '@jridgewell/remapping': '^2.3.5' });
	assert.deepEqual(published.peerDependencies, {
		'@rspack/core': '^2.0.0',
		octane: `^${fixture.runtimeVersion}`,
	});
	const provenance = JSON.parse(readFileSync(resolve(first, provenanceName)));
	assert.equal(provenance.schemaVersion, 1);
	assert.deepEqual(provenance.package, {
		name: '@octanejs/rspack-plugin',
		version: fixture.pluginVersion,
	});
	assert.equal(provenance.source.commit, fixture.sourceCommit);
	assert.equal(provenance.source.implementationCommit, fixture.implementationCommit);
	assert.deepEqual(provenance.producer.nativeRuntime, nativeRuntime(fixture));
	assert.equal(provenance.artifact.file, archiveName);
	assert.equal(provenance.artifact.sha256, digest(bytes));
	assert.equal(provenance.artifact.integrity, `sha512-${digest(bytes, 'sha512', 'base64')}`);
	assert.equal(provenance.artifact.publishManifestSha256, digest(publishBytes));
	assert.deepEqual(provenance.inventory.map((entry) => `package/${entry.file}`).sort(), files);
	for (const entry of provenance.inventory)
		assert.equal(
			entry.sha256,
			digest(execFileSync('tar', ['-xOf', artifact, `package/${entry.file}`])),
		);
	assert.equal(git(fixture.root, 'status', '--porcelain', '--untracked-files=all'), '');

	await t.test('never overwrites a frozen archive', () => {
		const provenanceBytes = readFileSync(resolve(first, provenanceName));
		assert.throws(() => pack(fixture, first));
		assert.deepEqual(readFileSync(artifact), bytes);
		assert.deepEqual(readFileSync(resolve(first, provenanceName)), provenanceBytes);
		assert.deepEqual(readdirSync(first).sort(), names);
	});
	await t.test('never overwrites an archive when its provenance is absent', () => {
		const output = resolve(fixture.directory, 'existing-archive');
		write(output, archiveName, 'frozen archive');
		assert.throws(() => pack(fixture, output));
		assert.equal(readFileSync(resolve(output, archiveName), 'utf8'), 'frozen archive');
		assert.deepEqual(readdirSync(output), [archiveName]);
	});
	await t.test('never overwrites provenance even when its archive is absent', () => {
		const output = resolve(fixture.directory, 'existing-provenance');
		write(output, provenanceName, 'frozen provenance');
		assert.throws(() => pack(fixture, output));
		assert.equal(readFileSync(resolve(output, provenanceName), 'utf8'), 'frozen provenance');
		assert.deepEqual(readdirSync(output), [provenanceName]);
	});
});

for (const path of [
	`${pluginPath}/src/index.js`,
	`${pluginPath}/types/index.d.ts`,
	`${pluginPath}/README.md`,
	`${pluginPath}/package.json`,
	'scripts/ultramodern-build-host/rspack-pack.mjs',
	'package.json',
	'pnpm-workspace.yaml',
])
	test(`rejects uncommitted changes in ${path}`, (t) => {
		const fixture = createFixture(t);
		write(fixture.root, path, `${readFileSync(resolve(fixture.root, path), 'utf8')}\n`);
		reject(fixture);
	});

for (const path of [`${pluginPath}/src/index.js`, `${pluginPath}/types/index.d.ts`])
	test(`rejects post-implementation source changes in ${path}`, (t) => {
		const fixture = createFixture(t);
		write(fixture.root, path, 'export {};\n');
		commit(fixture.root, 'Unpinned authored change');
		reject(fixture);
	});

test('rejects metadata selecting a newer implementation than its frozen runtime', (t) => {
	const fixture = createFixture(t);
	fixture.pluginManifest.ultramodernSource.implementationCommit = fixture.sourceCommit;
	fixture.pluginManifest.version = `0.1.55+ultramodern.${fixture.sourceCommit.slice(0, 12)}`;
	writeJSON(fixture.root, `${pluginPath}/package.json`, fixture.pluginManifest);
	commit(fixture.root, 'Select a newer plugin implementation');
	reject(fixture);
});

test('rejects a runtime sidecar declaring another implementation', (t) => {
	const fixture = createFixture(t);
	fixture.runtimeProvenance.source.implementationCommit = fixture.upstreamCommit;
	rebindRuntime(fixture);
	reject(fixture);
});

test('rejects a real runtime source commit outside the candidate ancestry', (t) => {
	const fixture = createFixture(t);
	const tree = git(fixture.root, 'rev-parse', 'HEAD^{tree}');
	fixture.runtimeProvenance.source.commit = git(
		fixture.root,
		'commit-tree',
		tree,
		'-m',
		'Unrelated runtime source',
	);
	rebindRuntime(fixture);
	reject(fixture);
});

test('rejects changed runtime producer source even when a later candidate restores the implementation', (t) => {
	const fixture = createFixture(t);
	const path = `${runtimePath}/src/runtime.ts`;
	const original = readFileSync(resolve(fixture.root, path));
	write(fixture.root, path, 'export const nativeOwner = "unrecorded-producer-change";\n');
	fixture.runtimeProvenance.source.commit = commit(
		fixture.root,
		'Change selected runtime producer source',
	);
	write(fixture.root, path, original);
	commit(fixture.root, 'Restore candidate implementation source');
	rebindRuntime(fixture);
	assert.deepEqual(readFileSync(resolve(fixture.root, path)), original);
	assert.equal(git(fixture.root, 'diff', fixture.implementationCommit, 'HEAD', '--', path), '');
	assert.notEqual(
		git(
			fixture.root,
			'diff',
			fixture.implementationCommit,
			fixture.runtimeProvenance.source.commit,
			'--',
			path,
		),
		'',
	);
	reject(fixture);
});

test('rejects wrong packed runtime metadata with honestly rebound archive and provenance hashes', (t) => {
	const fixture = createFixture(t);
	const published = {
		...fixture.runtimeManifest,
		...fixture.runtimeManifest.publishConfig,
		ultramodernSource: {
			...fixture.runtimeManifest.ultramodernSource,
			implementationCommit: fixture.upstreamCommit,
		},
	};
	delete published.publishConfig;
	runtimeArchive(fixture, published);
	const bytes = readFileSync(fixture.runtimeArtifact);
	fixture.runtimeProvenance.artifact.sha256 = digest(bytes);
	fixture.runtimeProvenance.artifact.integrity = `sha512-${digest(bytes, 'sha512', 'base64')}`;
	fixture.runtimeProvenance.artifact.publishManifestSha256 = digest(
		execFileSync('tar', ['-xOf', fixture.runtimeArtifact, 'package/package.json']),
	);
	rebindRuntime(fixture);
	assert.deepEqual(fixture.pluginManifest.ultramodernSource.nativeRuntime, nativeRuntime(fixture));
	assert.notDeepEqual(published.ultramodernSource, fixture.runtimeManifest.ultramodernSource);
	reject(fixture);
});

test('rejects altered runtime archive bytes', (t) => {
	const fixture = createFixture(t);
	writeFileSync(
		fixture.runtimeArtifact,
		Buffer.concat([readFileSync(fixture.runtimeArtifact), Buffer.from('changed')]),
	);
	reject(fixture);
});

test('rejects altered provenance bytes without changing its admitted hash', (t) => {
	const fixture = createFixture(t);
	writeFileSync(
		fixture.runtimeProvenancePath,
		`${readFileSync(fixture.runtimeProvenancePath, 'utf8')}\n`,
	);
	reject(fixture);
});

test('rejects a changed public source export contract', (t) => {
	const fixture = createFixture(t);
	fixture.pluginManifest.exports['.'].import = './src/loader.js';
	writeJSON(fixture.root, `${pluginPath}/package.json`, fixture.pluginManifest);
	commit(fixture.root, 'Change public exports');
	reject(fixture);
});

test('rejects a committed symlink in the authored source inventory', (t) => {
	const fixture = createFixture(t, {
		implementation(root) {
			rmSync(resolve(root, `${pluginPath}/src/index.js`));
			symlinkSync('./loader.js', resolve(root, `${pluginPath}/src/index.js`));
		},
	});
	reject(fixture);
});

test('packs the authenticated root license when the package has no local license', (t) => {
	const fixture = createFixture(t, {
		beforeMetadata(root) {
			rmSync(resolve(root, pluginPath, 'LICENSE'));
		},
	});
	const output = resolve(fixture.directory, 'root-license');
	pack(fixture, output);
	const artifact = resolve(
		output,
		readdirSync(output).find((name) => name.endsWith('.tgz')),
	);
	assert.equal(
		execFileSync('tar', ['-xOf', artifact, 'package/LICENSE'], { encoding: 'utf8' }),
		license,
	);
	assert.equal(git(fixture.root, 'status', '--porcelain', '--untracked-files=all'), '');
	assert.equal(readdirSync(output).length, 2);
});

test('rejects a package license that differs from its authenticated root license', (t) => {
	const fixture = createFixture(t, {
		beforeMetadata(root) {
			write(root, `${pluginPath}/LICENSE`, 'Different license\n');
		},
	});
	reject(fixture);
});

for (const path of [`${pluginPath}/README.md`, 'LICENSE'])
	test(`rejects a candidate missing ${path}`, (t) => {
		const fixture = createFixture(t, {
			beforeMetadata(root) {
				rmSync(resolve(root, path));
			},
		});
		reject(fixture);
	});
