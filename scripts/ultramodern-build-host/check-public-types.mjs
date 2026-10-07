import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import { createVirtualFileSystem } from 'typescript/unstable/fs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = resolve(root, 'packages/octane');
const options = {
	target: 'esnext',
	module: 'preserve',
	moduleResolution: 'bundler',
	lib: ['esnext', 'dom', 'dom.iterable'],
	strict: true,
	exactOptionalPropertyTypes: true,
	noUncheckedIndexedAccess: true,
	noPropertyAccessFromIndexSignature: true,
	noImplicitOverride: true,
	noImplicitReturns: true,
	noFallthroughCasesInSwitch: true,
	isolatedModules: true,
	verbatimModuleSyntax: true,
	skipLibCheck: false,
	types: [],
	noEmit: true,
};
// Resolve the consumer's explicit dependency from Octane's declared installation.
const sourcePath = resolve(packageRoot, 'ultramodern-native-public-types.ts');
const source = [
	"import type { ReactiveNode } from 'alien-signals/system';",
	"import type { ScopedNode, SignalObserver } from './dist/signals/graph.js';",
	'declare const node: ScopedNode;',
	'declare const observer: SignalObserver;',
	'const nativeNode: ReactiveNode = node;',
	'const nativeObserver: ReactiveNode = observer;',
	'void nativeNode; void nativeObserver;',
	"import { createContext, externalSnapshotBoundary, registerExternalSnapshotContext } from './dist/index.js';",
	"import type { ComponentBody, ExternalSnapshotAuthority, ExternalSnapshot } from './dist/index.js';",
	"import { decodeExternalSnapshotRequest, renderExternalSnapshot, serializeExternalSnapshot } from './dist/server/index.js';",
	"const Theme = createContext({ title: 'host' });",
	"const unregister = registerExternalSnapshotContext(Theme, { key: 'theme', encode: value => value.title, decode: async (value, signal) => { signal?.throwIfAborted(); return { title: String(value) }; } });",
	"const Local = createContext({ name: 'local' });",
	"const authority: ExternalSnapshotAuthority = { publisherBuildId: 'published-client', runtimeABI: 1 };",
	'declare const nativeComponent: ComponentBody<{ count: number }>;',
	'declare const snapshot: ExternalSnapshot;',
	'const Boundary = externalSnapshotBoundary({ authority, component: nativeComponent, contextKeys: ["theme"], snapshot: async (request, signal) => {',
	'  const admitted = decodeExternalSnapshotRequest(request, authority);',
	'  const result = await renderExternalSnapshot(() => "publisher output", admitted, { authority, ...(signal === undefined ? {} : { signal }), initializeContexts(provide) { provide(Local, { name: "endpoint" }); } });',
	'  serializeExternalSnapshot(result); return snapshot;',
	'} });',
	'const typedBoundary: ComponentBody<{ count: number }> = Boundary;',
	'void typedBoundary; unregister();',
].join('\n');
const configPath = resolve(packageRoot, 'ultramodern-native-public-types.tsconfig.json');
const virtualFiles = createVirtualFileSystem({
	[sourcePath]: source,
	[configPath]: JSON.stringify({ compilerOptions: options, files: [sourcePath] }),
});
const api = new API({
	cwd: packageRoot,
	fs: {
		readFile: virtualFiles.readFile,
		fileExists: (path) => virtualFiles.fileExists(path) || undefined,
	},
});
try {
	const snapshot = api.updateSnapshot({ openProjects: [configPath] });
	try {
		const project = snapshot.getProject(configPath);
		assert(project, 'The native TypeScript consumer project must load.');
		const { program } = project;
		const diagnostics = [
			...program.getConfigFileParsingDiagnostics(),
			...program.getProgramDiagnostics(),
			...program.getGlobalDiagnostics(),
			...program.getSyntacticDiagnostics(),
			...program.getSemanticDiagnostics(),
		];
		if (diagnostics.length) console.error(JSON.stringify(diagnostics, null, 2));
		assert.equal(
			diagnostics.length,
			0,
			'Published native graph and snapshot types must honor canonical consumer flags.',
		);
	} finally {
		snapshot.dispose();
	}
} finally {
	api.close();
}
console.log(
	'Native graph and snapshot declarations: canonical strict flags, types:[], skipLibCheck:false passed.',
);
