// @vitest-environment node

import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');
const sourceRoot = join(packageRoot, 'src');
const declarationRoot = join(packageRoot, '.server-browser-declarations');

// Emit the authored dependency graph in memory, just as normal prepack emits it.
// Checking the emitted entry catches type-only dependencies that JS bundlers erase.
function emitServerDeclarations(): Map<string, string> {
	const files = new Map<string, string>();
	const options: ts.CompilerOptions = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2024,
		declaration: true,
		emitDeclarationOnly: true,
		noCheck: true,
		rootDir: sourceRoot,
		outDir: declarationRoot,
	};
	const program = ts.createProgram([join(sourceRoot, 'server/index.ts')], options);
	program.emit(undefined, (file, source) => files.set(file, source));
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile && source.fileName.startsWith(sourceRoot + '/')) {
			files.set(join(declarationRoot, relative(sourceRoot, source.fileName)), source.text);
		}
	}
	return files;
}

function checkBrowserDeclarations(files: Map<string, string>): string[] {
	const entry = join(declarationRoot, 'browser.ts');
	const inputs = new Map(files);
	inputs.set(
		entry,
		`export * from './server/index.js';
// @ts-expect-error A web server consumer must not acquire Node globals.
process.env.NODE_ENV;
// @ts-expect-error A web server consumer must not acquire Node globals.
Buffer.from('browser');
`,
	);
	const options: ts.CompilerOptions = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ES2024,
		lib: ['lib.es2024.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
		types: [],
		strict: true,
		skipLibCheck: false,
		noEmit: true,
	};
	const host = ts.createCompilerHost(options);
	const originalRead = host.readFile.bind(host);
	const originalExists = host.fileExists.bind(host);
	host.readFile = (file) => inputs.get(file) ?? originalRead(file);
	host.fileExists = (file) => inputs.has(file) || originalExists(file);
	const originalDirectoryExists = host.directoryExists?.bind(host);
	host.directoryExists = (directory) =>
		(directory.startsWith(declarationRoot) &&
			[...inputs.keys()].some((file) => file.startsWith(directory + '/'))) ||
		!!originalDirectoryExists?.(directory);
	return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host)).map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
		return `${diagnostic.file?.fileName ?? ''}: TS${diagnostic.code}: ${message}`;
	});
}

describe('portable server declaration boundary', () => {
	it('checks the emitted web server entry without Node types and rejects a leaked Node return type', () => {
		const files = emitServerDeclarations();
		expect(checkBrowserDeclarations(files)).toEqual([]);
		const runtime = join(declarationRoot, 'runtime.server.d.ts');
		const declarations = files.get(runtime);
		expect(declarations).toBeDefined();
		files.set(
			runtime,
			`${declarations}\nexport type LeakedStaticPrelude = import('node:stream').Readable;\n`,
		);
		expect(checkBrowserDeclarations(files).join('\n')).toMatch(/Cannot find module 'node:stream'/);
	});
});
