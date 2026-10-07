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
// Keep browser declarations independent of Node's ambient types. The existing
// server entry includes the typed Node stream API, so check producer consumers
// separately with the declared Node environment rather than weakening this case.
const clientSource = [
	"import type { ReactiveNode } from 'alien-signals/system';",
	"import type { ScopedNode, SignalObserver } from './dist/signals/graph.js';",
	'declare const node: ScopedNode;',
	'declare const observer: SignalObserver;',
	'const nativeNode: ReactiveNode = node;',
	'const nativeObserver: ReactiveNode = observer;',
	'void nativeNode; void nativeObserver;',
	"import { createContext, decodeExternalSnapshotRequest, externalSnapshotBoundary, registerExternalSnapshotContext } from './dist/index.js';",
	"import type { ComponentBody, ExternalSnapshotAuthority, ExternalSnapshot } from './dist/index.js';",
	"const Theme = createContext({ title: 'host' });",
	"const unregister = registerExternalSnapshotContext(Theme, { key: 'theme', encode: value => value.title, decode: async (value, signal) => { signal?.throwIfAborted(); return { title: String(value) }; } });",
	"const authority: ExternalSnapshotAuthority = { publisherBuildId: 'published-client', runtimeABI: 1 };",
	'declare const nativeComponent: ComponentBody<{ count: number }>;',
	'declare const snapshot: ExternalSnapshot;',
	'const Boundary = externalSnapshotBoundary({ authority, component: nativeComponent, contextKeys: ["theme"], snapshot: async (request, signal) => {',
	'  const admitted = decodeExternalSnapshotRequest(request, authority);',
	'  void admitted; void signal; return snapshot;',
	'} });',
	'const typedBoundary: ComponentBody<{ count: number }> = Boundary;',
	'void typedBoundary; unregister();',
].join('\n');
const serverSource = [
	"import { createContext, decodeExternalSnapshotRequest, renderExternalSnapshot, serializeExternalSnapshot } from './dist/server/index.js';",
	"import type { ExternalSnapshotAuthority, ExternalSnapshotRequest } from './dist/server/index.js';",
	"const Local = createContext({ name: 'local' });",
	"const authority: ExternalSnapshotAuthority = { publisherBuildId: 'published-client', runtimeABI: 1 };",
	'declare const request: ExternalSnapshotRequest;',
	'declare const signal: AbortSignal;',
	'const admitted = decodeExternalSnapshotRequest(request, authority);',
	'const result = await renderExternalSnapshot(() => "publisher output", admitted, { authority, signal, initializeContexts(provide) { provide(Local, { name: "endpoint" }); } });',
	'serializeExternalSnapshot(result);',
].join('\n');
const consumers = [
	{ name: 'client', source: clientSource, types: [] },
	{ name: 'server', source: serverSource, types: ['node'] },
].map((consumer) => ({
	...consumer,
	sourcePath: resolve(packageRoot, `ultramodern-native-${consumer.name}-public-types.ts`),
	configPath: resolve(
		packageRoot,
		`ultramodern-native-${consumer.name}-public-types.tsconfig.json`,
	),
}));
const virtualFiles = createVirtualFileSystem({
	...Object.fromEntries(
		consumers.flatMap(({ sourcePath, source, configPath, types }) => [
			[sourcePath, source],
			[configPath, JSON.stringify({ compilerOptions: { ...options, types }, files: [sourcePath] })],
		]),
	),
});
const api = new API({
	cwd: packageRoot,
	fs: {
		readFile: virtualFiles.readFile,
		fileExists: (path) => virtualFiles.fileExists(path) || undefined,
	},
});
try {
	const snapshot = api.updateSnapshot({
		openProjects: consumers.map(({ configPath }) => configPath),
	});
	try {
		for (const { name, configPath } of consumers) {
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
				`Published native ${name} types must honor canonical consumer flags.`,
			);
		}
	} finally {
		snapshot.dispose();
	}
} finally {
	api.close();
}
console.log(
	'Native declarations: strict browser types:[] and server types:[node], skipLibCheck:false passed.',
);
