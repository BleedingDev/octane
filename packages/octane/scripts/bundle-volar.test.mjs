import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { version } from 'typescript';
import { API } from 'typescript/unstable/sync';
import { assertVolarDeclaration } from './bundle-volar.mjs';

const actualPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const source = `
/**
 * @param {string} source
 * @param {{ loose?: boolean, renderers?: unknown }} [options]
 * @returns {{ code: string, kind: 'virtual' }}
 */
export function compileToVolarMappings(source, options) {
	return { code: source, kind: 'virtual' };
}
`;
const declaration = `
// Formatting does not alter the public declaration.
export declare function compileToVolarMappings(
	source: string,
	options?: { loose?: boolean; renderers?: unknown },
): { code: string; kind: "virtual" };
`;

function fixture(run, { javascript = source, types = declaration, contract } = {}) {
	const directory = mkdtempSync(join(tmpdir(), 'octane-volar-declaration-test-'));
	const packageDir = join(directory, 'package');
	const compilerDir = join(packageDir, 'src/compiler');
	const previousTmpdir = process.env.TMPDIR;
	try {
		mkdirSync(compilerDir, { recursive: true });
		writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module' }));
		writeFileSync(join(compilerDir, 'volar.js'), javascript);
		writeFileSync(join(compilerDir, 'volar.d.ts'), types);
		if (contract) writeFileSync(join(compilerDir, 'contract.ts'), contract);
		process.env.TMPDIR = directory;
		run(packageDir);
		assert.deepEqual(readdirSync(directory), ['package'], 'Remove temporary declaration output.');
		assert.deepEqual(readdirSync(packageDir).sort(), ['package.json', 'src']);
	} finally {
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
		rmSync(directory, { recursive: true, force: true });
	}
}

test('checks authored JSDoc declarations with native TypeScript despite formatting changes', () => {
	fixture((packageDir) => assertVolarDeclaration(packageDir));
});

test('rejects a declaration whose public parameter type changed', () => {
	fixture(
		(packageDir) =>
			assert.throws(() => assertVolarDeclaration(packageDir), /volar\.d\.ts is stale/),
		{ types: declaration.replace('source: string', 'source: number') },
	);
});

test('reports invalid source and removes its temporary declaration files', () => {
	fixture(
		(packageDir) =>
			assert.throws(
				() => assertVolarDeclaration(packageDir),
				/Could not emit the authored Volar declaration:.*error TS/s,
			),
		{ javascript: 'export function compileToVolarMappings(source) { return .; }' },
	);
});

test('fails the declaration check when its imported authored contract has a type error', () => {
	fixture(
		(packageDir) =>
			assert.throws(
				() => assertVolarDeclaration(packageDir),
				/Could not emit the authored Volar declaration:.*error TS2322/s,
			),
		{
			javascript: `import { value } from './contract.js';\n${source}`,
			contract: 'export const value: string = 42;',
		},
	);
});

test('checks exact parser AST and native Program types with every library checked', () => {
	assert.equal(version, '7.0.2');
	const file = join(actualPackageDir, 'native-parser-contract.test.ts');
	const configFile = join(actualPackageDir, 'tsconfig.native-parser-contract.json');
	const source = `import type { CompileError, ParseOptions } from '@tsrx/core/types';
import type * as AST from '@tsrx/core/types/estree';
import type { ParserOptions, TSESTree } from '@typescript-eslint/types';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Program } from 'typescript/unstable/sync';
import { compileToVolarMappings } from './src/compiler/volar.js';
import type { CompileParseError, CompilerProgram } from './src/compiler/index.js';

declare const program: Program;
const parserOptions: ParserOptions = { programs: [program] };
const programs: Program[] | null | undefined = parserOptions.programs;
const files: readonly string[] | undefined = programs?.[0]?.getSourceFileNames();
const syntax = programs?.[0]?.getSourceFile(files?.[0] ?? '');
// @ts-expect-error Program retains the actual native API contract
const invalidProgram: ParserOptions = { programs: [{}] };

const operator: TSESTree.AssignmentOperatorToText[SyntaxKind.AmpersandAmpersandEqualsToken] = '&&=';
// @ts-expect-error the native token map preserves the exact operator spelling
const invalidOperator: typeof operator = '=';
declare const ast: AST.Program;
const sourceType: 'module' | 'script' = ast.sourceType;
for (const statement of ast.body) {
  if (statement.type === 'ImportDeclaration') {
    const importKind: 'type' | 'value' = statement.importKind;
  }
}
declare const comments: AST.CommentWithLocation[];
declare const errors: CompileError[];
const options: ParseOptions = { collect: true, keywordTokens: true, comments, errors };
// @ts-expect-error the authored parser error discriminant is preserved
const invalidError: CompileError['type'] = 'recoverable';

const result = compileToVolarMappings('export const value: string = "native";', 'view.tsrx', { loose: true });
const generated: string = result.code;
const sourceAst: CompilerProgram = result.sourceAst;
const generatedAst: CompilerProgram = result.generatedAst;
const publicErrors: CompileParseError[] = result.errors;
// @ts-expect-error the published result remains typed
const invalidCode: number = result.code;
`;
	const config = JSON.stringify({
		compilerOptions: {
			strict: true,
			target: 'esnext',
			module: 'preserve',
			moduleResolution: 'bundler',
			noEmit: true,
			skipLibCheck: false,
			skipDefaultLibCheck: false,
			types: [],
		},
		files: [file],
	});
	const api = new API({
		cwd: actualPackageDir,
		fs: {
			readFile: (path) => (path === file ? source : path === configFile ? config : undefined),
			fileExists: (path) => (path === file || path === configFile ? true : undefined),
		},
	});
	try {
		const snapshot = api.updateSnapshot({ openProjects: [configFile] });
		try {
			const project = snapshot.getProject(configFile);
			assert(project);
			const diagnostics = [
				...project.program.getConfigFileParsingDiagnostics(),
				...project.program.getProgramDiagnostics(),
				...project.program.getGlobalDiagnostics(),
				...project.program.getSyntacticDiagnostics(),
				...project.program.getBindDiagnostics(),
				...project.program.getSemanticDiagnostics(),
			];
			assert.deepEqual(diagnostics, []);
			assert(
				project.program
					.getSourceFileNames()
					.some((path) => path.endsWith('/@tsrx/core/types/index.d.ts')),
				'Check the exact owning parser declaration graph.',
			);
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
});

test('emits the actual owning Volar declaration with the complete native type graph', () => {
	assertVolarDeclaration(actualPackageDir);
});
