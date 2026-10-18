import { findPackedWorkspaceDependencyClosure } from './package-pack-canaries.mjs';

export function selectPackedPackages(args, packages, consumerPackageNames) {
	if (args.length === 0) return packages;
	if (args.length !== 2 || args[0] !== '--package' || args[1].startsWith('-')) {
		throw new Error('expected no arguments or exactly one --package <exactName>');
	}
	const manifests = new Map(packages.map((pkg) => [pkg.name, pkg.manifest]));
	const roots = new Set([args[1], ...consumerPackageNames]);
	for (const name of roots) {
		if (!manifests.has(name)) throw new Error(`unknown packable package: ${name}`);
	}
	const names = new Set(findPackedWorkspaceDependencyClosure(manifests, [...roots]));
	return packages.filter((pkg) => names.has(pkg.name));
}
