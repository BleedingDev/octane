import { dirname, resolve } from 'node:path';
import * as ts from 'typescript/unstable/ast';
import * as factory from 'typescript/unstable/ast/factory';
import {
	NativeSyntaxError,
	withNativeSyntaxProject,
} from '../../../scripts/lib/native-syntax-project.mjs';
import { frameworkErrorSurface } from '../../../scripts/error-codes/generate.mjs';
import { formatProdErrorMessage } from '../src/error-message.ts';

const HELPER = '__octaneNoArgError';
const SENTINEL = 8642097531;
const productionParts = formatProdErrorMessage(SENTINEL, []).split(String(SENTINEL));

// Only modules whose formatter binding has exclusively literal, zero-argument
// calls can stop importing the generic formatter. Unknown forms are left alone.
export function specializeErrorCalls(source, filename, catalog) {
	const surface = frameworkErrorSurface(filename);
	if (surface === undefined || productionParts.length !== 3) return source;
	const formatter = surface === 'server' ? 'formatServerError' : 'formatClientError';
	const runtime = surface === 'server' ? 'server' : 'client';
	try {
		return withNativeSyntaxProject([[filename, source]], ({ project, sourceFiles }) => {
			return specializeParsedCalls(
				source,
				filename,
				catalog,
				surface,
				formatter,
				runtime,
				sourceFiles[0][1],
				project.emitter,
			);
		});
	} catch (error) {
		if (error instanceof NativeSyntaxError) return source;
		throw error;
	}
}

function specializeParsedCalls(
	source,
	filename,
	catalog,
	surface,
	formatter,
	runtime,
	sourceFile,
	emitter,
) {
	const imports = sourceFile.statements.filter((node) => {
		if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return false;
		// Bare and absolute specifiers have different resolution rules, even when
		// their text happens to resemble the generated file's name.
		if (!/^\.{1,2}\//.test(node.moduleSpecifier.text)) return false;
		const target = resolve(dirname(filename), node.moduleSpecifier.text);
		return target === resolve(`error-codes.${runtime}.generated.js`);
	});
	if (imports.length !== 1) return source;
	const binding = imports[0].importClause?.namedBindings;
	if (
		imports[0].importClause?.isTypeOnly ||
		imports[0].importClause?.name ||
		!binding ||
		!ts.isNamedImports(binding) ||
		binding.elements.length !== 1 ||
		binding.elements[0].isTypeOnly ||
		binding.elements[0].propertyName ||
		binding.elements[0].name.text !== formatter
	) {
		return source;
	}

	let safe = true;
	const calls = [];
	function scan(node) {
		if (ts.isIdentifier(node)) {
			// A caller-local process binding would change the lookup that used to
			// happen inside the formatter's module. Conservatively skip any module
			// that mentions process, even when that mention is harmless.
			if (node.text === 'process' || node.text === HELPER) safe = false;
			if (node.text === formatter) {
				const parent = node.parent;
				if (ts.isImportSpecifier(parent) && parent.name === node) {
					// The binding was checked above.
				} else if (ts.isCallExpression(parent) && parent.expression === node) {
					const code = parent.arguments[0];
					const raw = code && ts.isNumericLiteral(code) ? code.getText(sourceFile) : '';
					const entry = catalog.codes[raw];
					if (
						parent.questionDotToken ||
						parent.typeArguments ||
						parent.arguments.length !== 1 ||
						!Number.isSafeInteger(Number(raw)) ||
						Number(raw) < 1 ||
						String(Number(raw)) !== raw ||
						!entry ||
						entry.status !== 'active' ||
						entry.argumentCount !== 0 ||
						!entry.runtime.includes(runtime) ||
						(surface === 'shared' && !entry.runtime.includes('server'))
					) {
						safe = false;
					} else {
						calls.push({ node: parent, code: raw });
					}
				} else {
					safe = false;
				}
			}
		}
		node.forEachChild(scan);
	}
	scan(sourceFile);
	if (!safe || calls.length === 0) return source;

	const helperCode = factory.createIdentifier('code');
	const productionExpression = productionParts
		.slice(1)
		.reduce(
			(expression, part) =>
				factory.createBinaryExpression(
					undefined,
					factory.createBinaryExpression(
						undefined,
						expression,
						undefined,
						factory.createToken(ts.SyntaxKind.PlusToken),
						helperCode,
					),
					undefined,
					factory.createToken(ts.SyntaxKind.PlusToken),
					factory.createStringLiteral(part, ts.TokenFlags.None),
				),
			factory.createStringLiteral(productionParts[0], ts.TokenFlags.None),
		);
	const helper = factory.createFunctionDeclaration(
		undefined,
		undefined,
		factory.createIdentifier(HELPER),
		undefined,
		[
			factory.createParameterDeclaration(
				undefined,
				undefined,
				helperCode,
				undefined,
				factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
			),
		],
		factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
		factory.createBlock([factory.createReturnStatement(productionExpression)], true),
	);
	const edits = calls.map(({ node, code }) => {
		const conditional = factory.createConditionalExpression(
			factory.createBinaryExpression(
				undefined,
				factory.createPropertyAccessExpression(
					factory.createPropertyAccessExpression(
						factory.createIdentifier('process'),
						undefined,
						factory.createIdentifier('env'),
						ts.NodeFlags.None,
					),
					undefined,
					factory.createIdentifier('NODE_ENV'),
					ts.NodeFlags.None,
				),
				undefined,
				factory.createToken(ts.SyntaxKind.ExclamationEqualsEqualsToken),
				factory.createStringLiteral('production', ts.TokenFlags.None),
			),
			factory.createToken(ts.SyntaxKind.QuestionToken),
			factory.createStringLiteral(catalog.codes[code].message, ts.TokenFlags.None),
			factory.createToken(ts.SyntaxKind.ColonToken),
			factory.createCallExpression(
				factory.createIdentifier(HELPER),
				undefined,
				undefined,
				[factory.createNumericLiteral(code, ts.TokenFlags.None)],
				ts.NodeFlags.None,
			),
		);
		return {
			start: node.getStart(sourceFile),
			end: node.end,
			// A standalone printer has no enclosing operator context. Parentheses
			// keep the replacement correct in unary, binary and member expressions.
			text: emitter.printNode(factory.createParenthesizedExpression(conditional)),
		};
	});
	const statements = sourceFile.statements.filter((statement) => statement !== imports[0]);
	let index = 0;
	while (
		index < statements.length &&
		(ts.isImportDeclaration(statements[index]) ||
			(ts.isExpressionStatement(statements[index]) &&
				ts.isStringLiteral(statements[index].expression)))
	)
		index++;
	const insertAt = index === 0 ? (ts.getShebang(source)?.length ?? 0) : statements[index - 1].end;
	edits.push({ start: imports[0].getStart(sourceFile), end: imports[0].end, text: '' });
	edits.push({ start: insertAt, end: insertAt, text: `\n${emitter.printNode(helper)}\n` });
	// Source-range edits retain every untouched comment and annotation while
	// keeping the native project's AST immutable.
	let output = source;
	for (const { start, end, text } of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
		output = output.slice(0, start) + text + output.slice(end);
	}
	return output;
}
