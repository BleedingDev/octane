import {
	getOctaneRspackBuildInfo,
	type OctaneRspackBuildInfo,
	type OctaneRspackLoaderOptions,
	type OctaneRspackPluginOptions,
} from '@octanejs/rspack-plugin';
import type { HotSignalDeclarationShape, HotSignalModuleManifest } from 'octane/signals';

function collectHotSignalModules(
	modules: readonly unknown[],
): ReadonlyMap<string, HotSignalModuleManifest> {
	const manifests = new Map<string, HotSignalModuleManifest>();
	for (const module of modules) {
		const manifest = getOctaneRspackBuildInfo(module)?.hotSignalModule;
		if (!manifest) continue;
		const hooks: readonly string[] = manifest.hookSlots;
		const declarations: readonly HotSignalDeclarationShape[] = manifest.declarations;
		manifests.set(manifest.moduleId, {
			version: manifest.version,
			moduleId: manifest.moduleId,
			generation: manifest.generation,
			hookSlots: hooks,
			declarations,
		});

		// @ts-expect-error A collector cannot mutate the compiler's hook slots.
		manifest.hookSlots.push('replacement');
		// @ts-expect-error A collector cannot replace a hook slot.
		manifest.hookSlots[0] = 'replacement';
		// @ts-expect-error A collector cannot mutate the compiler's declarations.
		manifest.declarations.pop();
		for (const declaration of manifest.declarations) {
			// @ts-expect-error Declaration identities are immutable compiler metadata.
			declaration.key = 'replacement';
			// @ts-expect-error Declaration kinds are immutable compiler metadata.
			declaration.kind = 'signal';
			// @ts-expect-error Declaration kinds are the canonical signal-kind union.
			declaration.kind satisfies 'component';
			// @ts-expect-error Hook slots contain string identities.
			manifest.hookSlots[0] satisfies number;
		}
	}
	return manifests;
}

const buildInfoWithoutHotSignals: OctaneRspackBuildInfo = {
	canonicalId: '/src/hooks.ts',
	transformKind: 'slots',
	serverRpc: false,
};
collectHotSignalModules([{ buildInfo: { octane: buildInfoWithoutHotSignals } }]);

const loaderOptions: OctaneRspackLoaderOptions = {
	strong: true,
	layerSpecializations: {
		'native:main': {
			renderers: {
				registry: {
					native: {
						module: '@fixture/native-main-renderer',
						capabilities: ['main-thread-render-only'],
						firstScreenEvents: ['bind*', 'catch*'],
					},
				},
				default: 'native',
			},
			universalRuntime: { runtime: 'native', thread: 'main-thread' },
		},
	},
};

const pluginOptions: OctaneRspackPluginOptions = {
	strong: false,
	parallel: { maxWorkers: 2 },
	layerSpecializations: {
		'native:main': {
			runtime: '@fixture/native-main-runtime',
			universalRuntime: { runtime: 'native', thread: 'main-thread' },
		},
	},
};

const serialPluginOptions: OctaneRspackPluginOptions = { parallel: false };

const unsupportedLoaderRuntime: OctaneRspackLoaderOptions = {
	layerSpecializations: {
		'native:main': {
			// @ts-expect-error The standalone loader cannot install an issuer-layer runtime alias.
			runtime: '@fixture/native-main-runtime',
		},
	},
};

const unsupportedLoaderParallel: OctaneRspackLoaderOptions = {
	// @ts-expect-error Worker-pool configuration belongs to the plugin, not the standalone loader.
	parallel: true,
};

void loaderOptions;
void pluginOptions;
void serialPluginOptions;
void unsupportedLoaderRuntime;
void unsupportedLoaderParallel;
