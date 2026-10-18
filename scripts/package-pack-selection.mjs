import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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
		requests[name] = `file:${archive.path}`;
	}
	if (!Object.keys(requests).length) return { manifest, archiveSpecs };
	return {
		manifest: { ...manifest, dependencies: { ...manifest.dependencies, ...requests } },
		archiveSpecs: { ...archiveSpecs, ...requests },
	};
}
