import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const options = {
	target: ts.ScriptTarget.ESNext,
	module: ts.ModuleKind.Preserve,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
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
const sourcePath = resolve(root, 'ultramodern-native-public-types.ts');
const source = [
	"import type { ReactiveNode } from 'alien-signals/system';",
	"import type { ScopedNode, SignalObserver } from './packages/octane/dist/signals/graph.js';",
	'declare const node: ScopedNode;',
	'declare const observer: SignalObserver;',
	'const nativeNode: ReactiveNode = node;',
	'const nativeObserver: ReactiveNode = observer;',
	'void nativeNode; void nativeObserver;',
].join('\n');
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (path, ...args) =>
	path === sourcePath
		? ts.createSourceFile(path, source, options.target, true)
		: originalGetSourceFile(path, ...args);
const program = ts.createProgram({ rootNames: [sourcePath], options, host });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
	console.error(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (path) => path,
			getCurrentDirectory: () => root,
			getNewLine: () => '\n',
		}),
	);
}
assert.equal(
	diagnostics.length,
	0,
	'Published native graph types must honor canonical consumer flags.',
);
console.log(
	'Native graph declaration closure: canonical strict flags, types:[], skipLibCheck:false passed.',
);
