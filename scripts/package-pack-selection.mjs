import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import semver from 'semver';
import { findPackedWorkspaceDependencyClosure } from './package-pack-canaries.mjs';

export function parsePackagePackArguments(args) {
	let packageName;
	const externalPackages = new Map();
	const usage =
		'expected no arguments or exactly one --package <exactName>, with optional --external-package <name>=<absolute archive>';
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (typeof value !== 'string' || value.startsWith('-')) throw new Error(usage);
		if (option === '--package' && packageName === undefined) packageName = value;
		else if (option === '--external-package') {
			const separator = value.indexOf('=');
			const name = value.slice(0, separator);
			const archive = value.slice(separator + 1);
			if (
				separator < 1 ||
				name !== '@tanstack/router-core' ||
				!path.isAbsolute(archive) ||
				externalPackages.has(name)
			) {
				throw new Error(`invalid or duplicate external package archive: ${value}`);
			}
			externalPackages.set(name, archive);
		} else throw new Error(usage);
	}
	if (externalPackages.size && packageName === undefined) throw new Error(usage);
	return { packageName, externalPackages };
}

export function selectPackedPackages(args, packages, consumerPackageNames) {
	const { packageName } = parsePackagePackArguments(args);
	if (packageName === undefined) return packages;
	const manifests = new Map(packages.map((pkg) => [pkg.name, pkg.manifest]));
	const roots = new Set([packageName, ...consumerPackageNames]);
	for (const name of roots) {
		if (!manifests.has(name)) throw new Error(`unknown packable package: ${name}`);
	}
	const names = new Set(findPackedWorkspaceDependencyClosure(manifests, [...roots]));
	return packages.filter((pkg) => names.has(pkg.name));
}

function assertExternalPeerVersion(name, version, manifests) {
	const peers = [...manifests.values()].flatMap((manifest) =>
		Object.hasOwn(manifest.peerDependencies ?? {}, name) ? [manifest.peerDependencies[name]] : [],
	);
	if (!peers.length) throw new Error(`unused external package archive: ${name}`);
	if (
		!semver.valid(version) ||
		peers.some((spec) => semver.valid(spec) !== spec || spec !== version)
	) {
		throw new Error(
			`${name}@${version} must match every exact packed peer version: ${peers.join(', ')}`,
		);
	}
}

// The maintained host declares its released authority in the normal catalog.
// Its committed lockfile supplies the exact bytes; numeric published peers stay
// independent of that host choice.
export function configuredPackageArchiveRequests(catalogs, lockfile, manifests) {
	const name = '@tanstack/router-core';
	const request = catalogs?.default?.[name];
	if (typeof request === 'string' && semver.valid(request) === request) {
		assertExternalPeerVersion(name, request, manifests);
		return new Map();
	}
	if (
		typeof request !== 'string' ||
		!/^https:\/\/github\.com\/BleedingDev\/router\/releases\/download\/ultramodern-router-core-[a-f0-9]{12}\/tanstack-router-core-[0-9.]+\.tgz$/.test(
			request,
		)
	)
		throw new Error(`unsupported configured package authority: ${request}`);
	const key = `  '${name}@${request}':\n`;
	const resolutions = lockfile
		.split(/(?:^|\n)packages:\n/)
		.slice(1)
		.flatMap((section) => section.split('\nsnapshots:\n')[0].split(key).slice(1));
	if (resolutions.length !== 1) throw new Error(`${name}: require one locked package authority`);
	const resolution = resolutions[0].split('\n\n')[0];
	const match = resolution.match(
		/^    resolution: \{integrity: (sha512-[A-Za-z0-9+/]+=*), tarball: ([^}]+)\}$/m,
	);
	if (!match || match[2] !== request)
		throw new Error(`${name}: configured archive lacks locked integrity`);
	const version = /\/tanstack-router-core-([0-9.]+)\.tgz$/.exec(request)[1];
	assertExternalPeerVersion(name, version, manifests);
	return new Map([[name, { request, version, integrity: match[1] }]]);
}

export function authenticateConfiguredPackageArchive(authority, bytes) {
	const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
	if (integrity !== authority.integrity)
		throw new Error('configured package archive integrity mismatch');
}

export async function readConfiguredPackageArchives(authorities, manifests, directory) {
	const result = new Map();
	for (const [name, authority] of authorities) {
		const response = await fetch(authority.request);
		if (!response.ok) throw new Error(`${authority.request}: ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		authenticateConfiguredPackageArchive(authority, bytes);
		const archive = path.join(directory, 'configured-router-core.tgz');
		writeFileSync(archive, bytes, { flag: 'wx' });
		const accepted = readExternalPackageArchives(new Map([[name, archive]]), manifests).get(name);
		const expected = path.join(directory, 'configured-router-core');
		mkdirSync(expected);
		const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
		if (entries.some((entry) => !entry.startsWith('package/') || entry.split('/').includes('..')))
			throw new Error('configured package archive contains an unsafe path');
		execFileSync('tar', ['-xzf', archive, '-C', expected]);
		result.set(name, { ...accepted, ...authority, expected: path.join(expected, 'package') });
	}
	return result;
}

export function verifyConfiguredPackageArchives(consumerDirectory, manifest, manifests, archives) {
	const direct = createRequire(path.join(consumerDirectory, 'package.json'));
	const roots = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
		(name) => manifests.has(name),
	);
	const closure = findPackedWorkspaceDependencyClosure(manifests, roots);
	for (const [name, archive] of archives) {
		if (
			!archive.expected ||
			!closure.some((root) => Object.hasOwn(manifests.get(root)?.peerDependencies ?? {}, name))
		)
			continue;
		if (manifest.dependencies?.[name] !== archive.request)
			throw new Error(`${name}: consumer must declare its configured archive directly`);
		const installed = path.dirname(realpathSync(direct.resolve(`${name}/package.json`)));
		const compare = (relative = '') => {
			for (const entry of readdirSync(path.join(archive.expected, relative))) {
				const file = path.join(relative, entry);
				const expected = path.join(archive.expected, file);
				if (lstatSync(expected).isDirectory()) compare(file);
				else if (
					!lstatSync(expected).isFile() ||
					!lstatSync(path.join(installed, file)).isFile() ||
					!readFileSync(expected).equals(readFileSync(path.join(installed, file)))
				)
					throw new Error(`${name}: installed archive bytes differ at ${file}`);
			}
		};
		compare();
		for (const root of closure) {
			if (!Object.hasOwn(manifests.get(root)?.peerDependencies ?? {}, name)) continue;
			const peer = createRequire(
				realpathSync(path.join(consumerDirectory, 'node_modules', root, 'package.json')),
			);
			if (
				realpathSync(peer.resolve(`${name}/package.json`)) !== path.join(installed, 'package.json')
			)
				throw new Error(`${root}: resolved a second ${name} authority`);
		}
	}
}

export function readExternalPackageArchives(externalPackages, manifests, archiveDirectory) {
	const archives = new Map();
	for (const [name, archive] of externalPackages) {
		if (name !== '@tanstack/router-core')
			throw new Error(`unsupported external package archive: ${name}`);
		const archivePath = realpathSync(archive);
		if (!statSync(archivePath).isFile())
			throw new Error(`external archive is not a file: ${archive}`);
		const bytes = readFileSync(archivePath);
		const manifest = JSON.parse(
			execFileSync('tar', ['-xzOf', '-', 'package/package.json'], {
				input: bytes,
				encoding: 'utf8',
				maxBuffer: 1024 * 1024,
			}),
		);
		if (manifest.name !== name)
			throw new Error(`external archive contains ${manifest.name}, expected ${name}`);
		assertExternalPeerVersion(name, manifest.version, manifests);
		// A long consumer run must keep using the bytes whose manifest was checked.
		const candidatePath = archiveDirectory
			? path.join(archiveDirectory, `${name.replaceAll('/', '-')}.tgz`)
			: archivePath;
		if (archiveDirectory) writeFileSync(candidatePath, bytes, { flag: 'wx' });
		archives.set(name, {
			path: candidatePath,
			version: manifest.version,
			integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
		});
	}
	return archives;
}

// External candidates describe the host's native peer authority, not a rewrite
// of the binding package or a claim that these bytes have been published.
export function applyExternalPackageArchives(
	manifest,
	archiveSpecs,
	nativeManifests,
	externalArchives,
) {
	if (!externalArchives.size) return { manifest, archiveSpecs };
	const roots = Object.keys({
		...manifest.dependencies,
		...manifest.devDependencies,
		...manifest.optionalDependencies,
	}).filter((name) => nativeManifests.has(name));
	const closure = new Map(
		findPackedWorkspaceDependencyClosure(nativeManifests, roots).map((name) => [
			name,
			nativeManifests.get(name),
		]),
	);
	const requests = {};
	for (const [name, archive] of externalArchives) {
		if (![...closure.values()].some((entry) => Object.hasOwn(entry.peerDependencies ?? {}, name)))
			continue;
		assertExternalPeerVersion(name, archive.version, closure);
		requests[name] = archive.request ?? `file:${archive.path}`;
	}
	if (!Object.keys(requests).length) return { manifest, archiveSpecs };
	return {
		manifest: { ...manifest, dependencies: { ...manifest.dependencies, ...requests } },
		archiveSpecs: {
			...archiveSpecs,
			...Object.fromEntries(
				Object.entries(requests).filter(([name]) => !externalArchives.get(name).request),
			),
		},
	};
}
