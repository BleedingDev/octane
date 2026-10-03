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
			'Published native graph types must honor canonical consumer flags.',
		);
	} finally {
		snapshot.dispose();
	}
} finally {
	api.close();
}
console.log(
	'Native graph declaration closure: canonical strict flags, types:[], skipLibCheck:false passed.',
);
