// @vitest-environment node

import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('typechecks shared signal protocol in a server program without DOM globals', () => {
	const program = ts.createProgram(
		[resolve(import.meta.dirname, '../src/signals/read-protocol.ts')],
		{
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			target: ts.ScriptTarget.ESNext,
			lib: ['lib.esnext.d.ts'],
			types: ['node'],
			strict: true,
			noEmit: true,
			skipLibCheck: false,
		},
	);
	expect(
		program
			.getSourceFiles()
			.some((source) => /\/lib\.dom(?:\.iterable)?\.d\.ts$/.test(source.fileName)),
	).toBe(false);
	const diagnostics = ts
		.getPreEmitDiagnostics(program)
		.map(
			(diagnostic) =>
				`${diagnostic.file?.fileName ?? ''}: TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
		);
	expect(diagnostics).toEqual([]);
});
