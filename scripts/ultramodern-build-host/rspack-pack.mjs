import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const upstream = '676a4ee6db59854d6b711921f4ac808845dcdbcd';
const pluginPath = 'packages/rspack-plugin-octane';
const runtimePath = 'packages/octane';
const producerPath = 'scripts/ultramodern-build-host';
const corpus = [
	pluginPath,
	runtimePath,
	producerPath,
	'package.json',
	'pnpm-workspace.yaml',
	'pnpm-lock.yaml',
	'LICENSE',
];
const sourceRepository = 'https://github.com/bleedingdev/octane';
const upstreamRepository = 'https://github.com/octanejs/octane';
const digest = (algorithm, bytes, encoding = 'hex') =>
	createHash(algorithm).update(bytes).digest(encoding);

function removeOwnedFile(path, identity) {
	let current;
	try {
		current = lstatSync(path);
	} catch (error) {
		if (error.code === 'ENOENT') return;
		throw error;
	}
	if (current.dev === identity.dev && current.ino === identity.ino) rmSync(path);
}

function writeExclusive(path, bytes) {
	const descriptor = openSync(path, 'wx');
	const identity = fstatSync(descriptor);
	try {
		writeFileSync(descriptor, bytes);
	} catch (error) {
		removeOwnedFile(path, identity);
		throw error;
	} finally {
		closeSync(descriptor);
	}
	return identity;
}

function archiveEntries(path) {
	const entries = execFileSync('tar', ['-tzf', path], {
		encoding: 'utf8',
		maxBuffer: 128 * 1024 * 1024,
	})
		.trim()
		.split('\n');
	assert.equal(
		new Set(entries.map((entry) => entry.replace(/\/$/, ''))).size,
		entries.length,
		'Reject duplicate archive members.',
	);
	for (const entry of entries) {
		assert(/^package(?:\/[A-Za-z0-9@._+/-]+)?\/?$/.test(entry), `Unsafe archive member: ${entry}`);
		assert(
			!entry
				.replace(/\/$/, '')
				.split('/')
				.some((part) => part === '..' || part === '.' || part === ''),
			`Unsafe archive member: ${entry}`,
		);
	}
	const listing = execFileSync('tar', ['-tvzf', path], {
		encoding: 'utf8',
		maxBuffer: 128 * 1024 * 1024,
	})
		.trim()
		.split('\n');
	assert.equal(listing.length, entries.length, 'Read every archive member type.');
	assert(
		listing.every((entry) => /^[-d]/.test(entry)),
		'Only regular archive files and directories are permitted.',
	);
	return entries;
}

function archiveFile(path, member) {
	return execFileSync('tar', ['-xOf', path, member], { maxBuffer: 128 * 1024 * 1024 });
}

// USTAR fields and gzip timestamps are canonical, independent of filesystem
// metadata and the host tar implementation. The package contains authored files.
function archivePackage(files, epoch) {
	assert(
		Number.isSafeInteger(epoch) && epoch >= 0 && epoch < 8 ** 11,
		'Invalid source commit timestamp.',
	);
	const directories = new Set(['package']);
	for (const name of files.keys()) {
		let directory = dirname(`package/${name}`);
		while (directory !== '.') {
			directories.add(directory);
			directory = dirname(directory);
		}
	}
	const members = [
		...[...directories].map((name) => ({
			name: `${name}/`,
			bytes: Buffer.alloc(0),
			directory: true,
		})),
		...[...files].map(([name, bytes]) => ({ name: `package/${name}`, bytes, directory: false })),
	].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	const chunks = [];
	for (const member of members) {
		const header = Buffer.alloc(512);
		const field = (value, offset, size) => {
			assert(Buffer.byteLength(value) <= size, `USTAR field overflow: ${member.name}`);
			header.write(value, offset, size, 'utf8');
		};
		const number = (value, offset, size) => {
			const encoded = value.toString(8);
			assert(encoded.length < size, `USTAR numeric field overflow: ${member.name}`);
			field(`${encoded.padStart(size - 1, '0')}\0`, offset, size);
		};
		let name = member.name;
		if (Buffer.byteLength(name) > 100) {
			const split = name.lastIndexOf('/', name.endsWith('/') ? name.length - 2 : name.length - 1);
			assert(split > 0, `USTAR path overflow: ${name}`);
			field(name.slice(0, split), 345, 155);
			name = name.slice(split + 1);
		}
		field(name, 0, 100);
		number(member.directory ? 0o755 : 0o644, 100, 8);
		number(0, 108, 8);
		number(0, 116, 8);
		number(member.bytes.length, 124, 12);
		number(epoch, 136, 12);
		header.fill(0x20, 148, 156);
		field(member.directory ? '5' : '0', 156, 1);
		field('ustar\0', 257, 6);
		field('00', 263, 2);
		field('root', 265, 32);
		field('root', 297, 32);
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		field(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
		chunks.push(header, member.bytes);
		if (member.bytes.length % 512) chunks.push(Buffer.alloc(512 - (member.bytes.length % 512)));
	}
	chunks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

export function packRspackCandidate({
	root,
	output,
	runtimeProvenancePath,
	upstreamCommit = upstream,
}) {
	assert(
		isAbsolute(root) && isAbsolute(output),
		'Pass an absolute source root and owned artifact directory.',
	);
	assert(isAbsolute(runtimeProvenancePath), 'Pass the frozen runtime provenance.');
	const gitBytes = (...args) =>
		execFileSync('git', args, {
			cwd: root,
			stdio: ['ignore', 'pipe', 'pipe'],
			maxBuffer: 128 * 1024 * 1024,
		});
	const git = (...args) =>
		gitBytes(...args)
			.toString('utf8')
			.trim();
	const ancestor = (before, after) => gitBytes('merge-base', '--is-ancestor', before, after);
	const blob = (commit, path) => gitBytes('show', `${commit}:${path}`);
	assert(
		!['', 'main', 'master'].includes(git('branch', '--show-current')),
		'Use a named source fork branch.',
	);
	assert.equal(
		git('status', '--porcelain', '--', ...corpus),
		'',
		'Commit the complete plugin, runtime, workspace and producer source before packing.',
	);
	const sourceCommit = git('rev-parse', 'HEAD');
	const assertFrozenSource = () => {
		assert.equal(
			git('rev-parse', 'HEAD'),
			sourceCommit,
			'The source commit changed while packing.',
		);
		assert.equal(
			git('status', '--porcelain', '--', ...corpus),
			'',
			'The source or producer changed while packing.',
		);
	};
	ancestor(upstreamCommit, sourceCommit);
	const sourceManifestBytes = blob(sourceCommit, `${pluginPath}/package.json`);
	const sourceManifest = JSON.parse(sourceManifestBytes);
	const upstreamManifest = JSON.parse(blob(upstreamCommit, `${pluginPath}/package.json`));
	assert.equal(sourceManifest.name, '@octanejs/rspack-plugin');
	const source = sourceManifest.ultramodernSource;
	assert(source, 'Pin the maintained plugin source.');
	assert.equal(source.upstreamCommit, upstreamCommit);
	assert.match(source.implementationCommit, /^[a-f0-9]{40}$/);
	assert.equal(
		sourceManifest.version,
		`0.1.55+ultramodern.${source.implementationCommit.slice(0, 12)}`,
	);
	ancestor(source.implementationCommit, sourceCommit);
	gitBytes(
		'diff',
		'--exit-code',
		source.implementationCommit,
		sourceCommit,
		'--',
		`${pluginPath}/src`,
		`${pluginPath}/types`,
	);
	const sourcePatch = gitBytes(
		'diff',
		upstreamCommit,
		source.implementationCommit,
		'--',
		`${pluginPath}/src`,
		`${pluginPath}/types`,
	);
	assert(
		sourcePatch.length > 0,
		'The maintained plugin requires an authored source or type change.',
	);
	assert.equal(source.authoredSourcePatchSha256, digest('sha256', sourcePatch));
	for (const key of [
		'main',
		'module',
		'types',
		'exports',
		'files',
		'bin',
		'browser',
		'imports',
		'typesVersions',
		'type',
		'sideEffects',
		'engines',
		'license',
	])
		assert.deepEqual(
			sourceManifest[key],
			upstreamManifest[key],
			`Preserve the native ${key} publication contract.`,
		);
	assert.deepEqual(sourceManifest.files, ['src', 'types', 'README.md', 'LICENSE']);
	assert.deepEqual(
		sourceManifest.publishConfig,
		{ access: 'public' },
		'No alternate publication directory or entrypoints.',
	);
	for (const name of ['prepack', 'postpack', 'prepare', 'prepublish', 'prepublishOnly'])
		assert(
			!Object.hasOwn(sourceManifest.scripts ?? {}, name),
			`No source-rewriting package lifecycle: ${name}`,
		);
	assert(
		!sourceManifest.bundleDependencies && !sourceManifest.bundledDependencies,
		'Do not bundle a private dependency tree.',
	);
	for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies'])
		assert.deepEqual(
			Object.keys(sourceManifest[group] ?? {}).sort(),
			Object.keys(upstreamManifest[group] ?? {}).sort(),
			`Preserve native ${group} names.`,
		);
	assert.equal(sourceManifest.peerDependencies.octane, 'workspace:^');
	assert.equal(
		sourceManifest.peerDependencies['@rspack/core'],
		upstreamManifest.peerDependencies['@rspack/core'],
	);
	assert(
		!Object.hasOwn(sourceManifest.dependencies ?? {}, 'octane'),
		'Octane must remain a singleton peer.',
	);
	const license = blob(sourceCommit, 'LICENSE');
	assert.deepEqual(
		license,
		blob(upstreamCommit, 'LICENSE'),
		'Preserve the authoritative upstream MIT license.',
	);
	const workspaceBytes = blob(sourceCommit, 'pnpm-workspace.yaml');
	const rootManifestBytes = blob(sourceCommit, 'package.json');
	const runtimeManifestBytes = blob(sourceCommit, `${runtimePath}/package.json`);
	const runtimeManifest = JSON.parse(runtimeManifestBytes);
	const runtimeProvenanceBytes = readFileSync(runtimeProvenancePath);
	const provenance = JSON.parse(runtimeProvenanceBytes);
	assert.equal(provenance.schemaVersion, 1);
	assert.deepEqual(provenance.package, { name: 'octane', version: runtimeManifest.version });
	assert.equal(provenance.upstream.repository, upstreamRepository);
	assert.equal(provenance.upstream.commit, upstreamCommit);
	assert.equal(provenance.source.repository, sourceRepository);
	assert.equal(
		provenance.source.implementationCommit,
		source.implementationCommit,
		'Use runtime and plugin from the same implementation commit.',
	);
	assert.match(provenance.source.commit, /^[a-f0-9]{40}$/);
	ancestor(source.implementationCommit, provenance.source.commit);
	ancestor(provenance.source.commit, sourceCommit);
	gitBytes(
		'diff',
		'--exit-code',
		source.implementationCommit,
		provenance.source.commit,
		'--',
		`${runtimePath}/src`,
		`:(exclude)${runtimePath}/src/version.ts`,
	);
	assert.equal(
		runtimeManifest.version,
		`0.7.1+ultramodern.${source.implementationCommit.slice(0, 12)}`,
	);
	assert.equal(runtimeManifest.ultramodernSource.implementationCommit, source.implementationCommit);
	assert.equal(runtimeManifest.ultramodernSource.upstreamCommit, upstreamCommit);
	assert.deepEqual(
		blob(provenance.source.commit, `${runtimePath}/package.json`),
		runtimeManifestBytes,
		'The selected runtime manifest must remain immutable.',
	);
	assert.equal(provenance.producer.sourceManifestSha256, digest('sha256', runtimeManifestBytes));
	gitBytes(
		'diff',
		'--exit-code',
		source.implementationCommit,
		sourceCommit,
		'--',
		`${runtimePath}/src`,
		`:(exclude)${runtimePath}/src/version.ts`,
	);
	const runtimePatch = gitBytes(
		'diff',
		upstreamCommit,
		source.implementationCommit,
		'--',
		`${runtimePath}/src/runtime.ts`,
	);
	const nativePatch = gitBytes(
		'diff',
		upstreamCommit,
		source.implementationCommit,
		'--',
		`${runtimePath}/src`,
		`:(exclude)${runtimePath}/src/version.ts`,
	);
	for (const [field, patch] of [
		['runtimePatchSha256', runtimePatch],
		['authoredSourcePatchSha256', nativePatch],
	]) {
		assert.equal(
			provenance.source[field],
			digest('sha256', patch),
			`Authenticate the runtime ${field}.`,
		);
		assert.equal(runtimeManifest.ultramodernSource[field], provenance.source[field]);
	}
	assert.equal(
		basename(provenance.artifact.file),
		provenance.artifact.file,
		'The runtime artifact must be a local filename.',
	);
	assert(
		/^octane-[A-Za-z0-9.+-]+\.tgz$/.test(provenance.artifact.file),
		'Invalid native archive filename.',
	);
	assert.equal(provenance.artifact.file, `octane-${runtimeManifest.version}.tgz`);
	const runtimeBytes = readFileSync(
		resolve(dirname(runtimeProvenancePath), provenance.artifact.file),
	);
	assert.equal(digest('sha256', runtimeBytes), provenance.artifact.sha256);
	assert.equal(`sha512-${digest('sha512', runtimeBytes, 'base64')}`, provenance.artifact.integrity);
	const runtime = {
		name: 'octane',
		version: runtimeManifest.version,
		artifactSha256: provenance.artifact.sha256,
		provenanceSha256: digest('sha256', runtimeProvenanceBytes),
	};
	assert.deepEqual(source.nativeRuntime, runtime, 'Bind the selected immutable native runtime.');
	const artifact = resolve(output, `octanejs-rspack-plugin-${sourceManifest.version}.tgz`);
	const provenancePath = `${artifact}.provenance.json`;
	assert(
		!existsSync(artifact) && !existsSync(provenancePath),
		'Use fresh archive and provenance paths; never overwrite frozen assets.',
	);
	mkdirSync(output, { recursive: true });
	const stage = mkdtempSync(resolve(output, '.rspack-stage-'));
	try {
		const runtimeArchive = resolve(stage, 'runtime.tgz');
		writeFileSync(runtimeArchive, runtimeBytes);
		const runtimeEntries = archiveEntries(runtimeArchive);
		assert(
			runtimeEntries.includes('package/package.json'),
			'The runtime archive must include its manifest.',
		);
		const packedRuntimeBytes = archiveFile(runtimeArchive, 'package/package.json');
		assert.equal(digest('sha256', packedRuntimeBytes), provenance.artifact.publishManifestSha256);
		const packedRuntime = JSON.parse(packedRuntimeBytes);
		assert.equal(packedRuntime.name, 'octane');
		assert.equal(packedRuntime.version, runtime.version);
		assert.deepEqual(
			packedRuntime.ultramodernSource,
			runtimeManifest.ultramodernSource,
			'The packed runtime must carry the admitted source metadata.',
		);
		for (const key of ['main', 'module', 'types', 'imports', 'exports'])
			assert.deepEqual(
				packedRuntime[key],
				runtimeManifest.publishConfig?.[key] ?? runtimeManifest[key],
				`Preserve the selected runtime ${key}.`,
			);
		const packageStage = resolve(stage, pluginPath);
		const sourceFiles = new Map();
		const tree = gitBytes(
			'ls-tree',
			'-r',
			'-z',
			sourceCommit,
			'--',
			`${pluginPath}/src`,
			`${pluginPath}/types`,
			`${pluginPath}/README.md`,
			`${pluginPath}/LICENSE`,
		)
			.toString('utf8')
			.split('\0')
			.filter(Boolean);
		for (const entry of tree) {
			const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
			assert(match, `Only regular committed source files may be published: ${entry}`);
			const path = match[3].slice(`${pluginPath}/`.length);
			assert(
				/^(?:src\/|types\/|README\.md$|LICENSE$)/.test(path) &&
					/^[A-Za-z0-9@._+/-]+$/.test(path) &&
					!path.split('/').includes('..'),
				`Invalid authored package path: ${path}`,
			);
			sourceFiles.set(path, gitBytes('cat-file', 'blob', match[2]));
		}
		assert(sourceFiles.has('README.md'), 'Publish the committed native README.');
		if (sourceFiles.has('LICENSE')) assert.deepEqual(sourceFiles.get('LICENSE'), license);
		sourceFiles.set('LICENSE', license);
		for (const required of [
			'src/index.js',
			'src/loader.js',
			'types/index.d.ts',
			'types/loader.d.ts',
		])
			assert(sourceFiles.has(required), `Missing native public entry: ${required}`);
		for (const [path, bytes] of sourceFiles) {
			const target = resolve(packageStage, path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, bytes);
		}
		writeFileSync(resolve(packageStage, 'package.json'), sourceManifestBytes);
		writeFileSync(resolve(stage, 'package.json'), rootManifestBytes);
		writeFileSync(resolve(stage, 'pnpm-workspace.yaml'), workspaceBytes);
		const stagedRuntime = resolve(stage, runtimePath);
		mkdirSync(stagedRuntime, { recursive: true });
		writeFileSync(resolve(stagedRuntime, 'package.json'), runtimeManifestBytes);
		mkdirSync(resolve(packageStage, 'node_modules'));
		symlinkSync(stagedRuntime, resolve(packageStage, 'node_modules/octane'), 'dir');
		const ordinaryOutput = resolve(stage, 'ordinary-pack');
		mkdirSync(ordinaryOutput);
		const isolatedUserConfig = resolve(stage, 'user.npmrc');
		writeFileSync(isolatedUserConfig, '');
		const isolatedConfigDirectory = resolve(stage, 'config');
		mkdirSync(isolatedConfigDirectory);
		const pnpmOptions = {
			cwd: stage,
			encoding: 'utf8',
			timeout: 120_000,
			maxBuffer: 128 * 1024 * 1024,
			env: {
				...process.env,
				npm_config_userconfig: isolatedUserConfig,
				pnpm_config_userconfig: isolatedUserConfig,
				XDG_CONFIG_HOME: isolatedConfigDirectory,
				pnpm_config_verify_deps_before_run: 'warn',
				pnpm_config_ignore_pnpmfile: 'true',
				pnpm_config_pm_on_fail: 'ignore',
			},
		};
		const pnpmFlags = [
			'--config.verify-deps-before-run=warn',
			'--config.ignore-pnpmfile=true',
			'--pm-on-fail=ignore',
		];
		execFileSync(
			'pnpm',
			[...pnpmFlags, '--dir', packageStage, 'pack', '--pack-destination', ordinaryOutput],
			pnpmOptions,
		);
		const archives = readdirSync(ordinaryOutput);
		assert.equal(archives.length, 1, 'Ordinary pnpm pack must produce exactly one archive.');
		assert(archives[0].endsWith('.tgz'), 'Ordinary pnpm pack must produce an npm archive.');
		const packedPath = resolve(ordinaryOutput, archives[0]);
		const entries = archiveEntries(packedPath);
		const files = new Map(
			entries
				.filter((name) => !name.endsWith('/') && name !== 'package')
				.map((name) => [name.slice('package/'.length), archiveFile(packedPath, name)]),
		);
		assert.deepEqual(
			[...files.keys()].sort(),
			['package.json', ...sourceFiles.keys()].sort(),
			'Preserve the complete ordinary authored source package.',
		);
		for (const [path, bytes] of sourceFiles)
			assert.deepEqual(files.get(path), bytes, `Publish the exact committed bytes: ${path}`);
		const packed = JSON.parse(files.get('package.json'));
		assert.equal(
			packed.version,
			'0.1.55',
			'Ordinary pnpm pack strips only candidate build metadata from the version.',
		);
		// pnpm omits build metadata from version. Preserve the already authenticated
		// maintained identity, without rewriting any authored source or declarations.
		packed.version = sourceManifest.version;
		const expected = structuredClone(sourceManifest);
		const catalogs = JSON.parse(
			execFileSync('pnpm', [...pnpmFlags, 'config', 'get', 'catalogs', '--json'], pnpmOptions),
		);
		assert(
			catalogs && typeof catalogs === 'object' && !Array.isArray(catalogs),
			'Read the committed workspace catalogs.',
		);
		for (const group of [
			'dependencies',
			'devDependencies',
			'optionalDependencies',
			'peerDependencies',
		]) {
			for (const [name, pin] of Object.entries(expected[group] ?? {})) {
				if (pin.startsWith('workspace:')) {
					assert.equal(
						name,
						'octane',
						'Only the selected native runtime may be a workspace dependency.',
					);
					assert(
						['workspace:*', 'workspace:^'].includes(pin),
						`Unsupported native workspace range: ${pin}`,
					);
					expected[group][name] = `${pin === 'workspace:^' ? '^' : ''}${runtime.version}`;
				} else if (pin.startsWith('catalog:')) {
					// The workspace catalog is read by the same ordinary package manager
					// from an immutable, isolated copy of the committed workspace config.
					const key = pin.slice('catalog:'.length) || 'default';
					assert(
						typeof catalogs?.[key]?.[name] === 'string',
						`Missing committed catalog dependency: ${name}`,
					);
					expected[group][name] = catalogs[key][name];
				}
				assert(
					!/^(?:workspace:|catalog:|file:|link:)/.test(expected[group][name]),
					`Publish a resolved external dependency: ${name}`,
				);
			}
		}
		assert.deepEqual(
			packed,
			expected,
			'Preserve the complete native manifest with ordinary catalog and workspace resolution.',
		);
		const publishManifestBytes = Buffer.from(`${JSON.stringify(packed, null, 2)}\n`);
		files.set('package.json', publishManifestBytes);
		assertFrozenSource();
		const bytes = archivePackage(files, Number(git('show', '-s', '--format=%ct', sourceCommit)));
		const inventory = [...files]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([file, content]) => ({ file, sha256: digest('sha256', content) }));
		const file = basename(artifact);
		const result = {
			schemaVersion: 1,
			package: { name: sourceManifest.name, version: sourceManifest.version },
			upstream: {
				repository: upstreamRepository,
				tag: 'octane@0.7.1',
				commit: upstreamCommit,
				packageVersion: '0.1.55',
			},
			source: {
				repository: sourceRepository,
				commit: sourceCommit,
				implementationCommit: source.implementationCommit,
				authoredSourcePatchSha256: source.authoredSourcePatchSha256,
			},
			producer: {
				node: process.version,
				pnpm: execFileSync('pnpm', ['--version'], pnpmOptions).trim(),
				hostLockSha256: digest('sha256', blob(sourceCommit, `${producerPath}/pnpm-lock.yaml`)),
				sourceManifestSha256: digest('sha256', sourceManifestBytes),
				workspaceSha256: digest('sha256', workspaceBytes),
				nativeRuntime: runtime,
			},
			artifact: {
				file,
				sha256: digest('sha256', bytes),
				integrity: `sha512-${digest('sha512', bytes, 'base64')}`,
				publishManifestSha256: digest('sha256', publishManifestBytes),
				sourceInventorySha256: digest('sha256', Buffer.from(`${JSON.stringify(inventory)}\n`)),
				intendedReleaseURI: `https://github.com/bleedingdev/octane/releases/download/${encodeURIComponent(`@octanejs/rspack-plugin@${sourceManifest.version}`)}/${encodeURIComponent(file)}`,
			},
			inventory,
		};
		const resultBytes = Buffer.from(`${JSON.stringify(result, null, 2)}\n`);
		assertFrozenSource();
		const artifactIdentity = writeExclusive(artifact, bytes);
		try {
			writeExclusive(provenancePath, resultBytes);
		} catch (error) {
			// Remove only the archive exclusively created by this invocation.
			removeOwnedFile(artifact, artifactIdentity);
			throw error;
		}
		return {
			artifact,
			provenancePath,
			provenanceSha256: digest('sha256', resultBytes),
			...result.artifact,
		};
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [output, runtimeProvenancePath, ...extra] = process.argv.slice(2);
	assert(
		output && runtimeProvenancePath && extra.length === 0,
		'Pass an absolute owned artifact directory and frozen runtime provenance.',
	);
	console.log(
		JSON.stringify(
			packRspackCandidate({
				root: fileURLToPath(new URL('../../', import.meta.url)),
				output,
				runtimeProvenancePath,
			}),
			null,
			2,
		),
	);
}
