import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';

const LICENSE_FILE = /^licen[cs]e(?:\.[^.]+)?$/i;

function declarationTokens(source) {
	const scanner = createScanner(true, LanguageVariant.Standard, source);
	const tokens = [];
	for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
		tokens.push([
			kind,
			kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText(),
		]);
	}
	// The declaration is formatted by Prettier in source. Whitespace, comments,
	// quote spelling and optional trailing separators cannot change its contract.
	return JSON.stringify(
		tokens.filter(([kind], index) => {
			if (
				kind === SyntaxKind.SemicolonToken &&
				tokens[index + 1]?.[0] === SyntaxKind.CloseBraceToken
			) {
				return false;
			}
			if (kind !== SyntaxKind.CommaToken) return true;
			return ![
				SyntaxKind.CloseParenToken,
				SyntaxKind.CloseBraceToken,
				SyntaxKind.CloseBracketToken,
			].includes(tokens[index + 1]?.[0]);
		}),
	);
}

export function assertVolarDeclaration(packageDir) {
	const source = join(packageDir, 'src/compiler/volar.js');
	const declaration = join(packageDir, 'src/compiler/volar.d.ts');
	const manifestPath = createRequire(import.meta.url).resolve('typescript/package.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const compiler = resolve(dirname(manifestPath), manifest.bin.tsc);
	const temporaryDirectory = mkdtempSync(join(tmpdir(), 'octane-volar-declaration-'));
	try {
		const config = join(temporaryDirectory, 'tsconfig.json');
		const output = join(temporaryDirectory, 'output');
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					allowJs: true,
					declaration: true,
					emitDeclarationOnly: true,
					module: 'esnext',
					moduleResolution: 'bundler',
					target: 'esnext',
					strict: true,
					types: [],
					noEmitOnError: true,
					rootDir: join(packageDir, 'src'),
					outDir: output,
				},
				files: [source],
			}),
		);
		// The native API prints AST nodes, while its CLI owns declaration emit.
		// Compare only the authored entry, then remove every temporary output.
		const emitted = spawnSync(process.execPath, [compiler, '-p', config, '--pretty', 'false'], {
			cwd: packageDir,
			encoding: 'utf8',
			maxBuffer: 32 * 1024 * 1024,
		});
		const generated = join(output, 'compiler/volar.d.ts');
		if (emitted.error || emitted.status !== 0 || !existsSync(generated)) {
			throw new Error(
				`Could not emit the authored Volar declaration: ${[emitted.stdout, emitted.stderr]
					.filter(Boolean)
					.join('\n')
					.trim()}`,
				{ cause: emitted.error },
			);
		}
		if (
			declarationTokens(readFileSync(declaration, 'utf8')) !==
			declarationTokens(readFileSync(generated, 'utf8'))
		) {
			throw new Error(
				'volar.d.ts is stale: update it from the declaration emitted by volar.js JSDoc',
			);
		}
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
}

function isWithin(directory, file) {
	const path = relative(directory, file);
	return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function dependencyNotice(input) {
	let directory = dirname(input);
	while (!existsSync(join(directory, 'package.json'))) {
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`Volar bundle input has no package: ${input}`);
		directory = parent;
	}
	const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
	if (manifest.license !== 'MIT') {
		throw new Error(
			`Volar bundle requires license review for ${manifest.name}@${manifest.version}: ${manifest.license}`,
		);
	}
	const licenses = readdirSync(directory)
		.filter((name) => LICENSE_FILE.test(name))
		.sort()
		.map((name) => readFileSync(join(directory, name), 'utf8').trim());
	if (licenses.length === 0 || licenses.some((license) => license.length === 0)) {
		throw new Error(`Volar bundle dependency has no license notice: ${manifest.name}`);
	}
	return {
		id: `${manifest.name}@${manifest.version}`,
		text: licenses.join('\n\n'),
	};
}

/**
 * Freeze only the IDE/typecheck compiler's third-party graph at publication.
 * @tsrx/core 0.1.60's ArrayPattern printer assumes esrap 2.3.2; resolving its
 * compatible range to 2.3.6 prints tuple parameter annotations twice. A package
 * manager override in this repository cannot protect published consumers.
 *
 * Bundle the audited build graph, not transformed application source. Octane's
 * analysis modules stay shared with the runtime compiler. The parser adapters
 * join the bundle so their @tsrx/core imports use the audited parser too. Virtual TSX still
 * comes from the same single AST print with its original mappings. Runtime
 * entries and application output are untouched. This costs about 210 KiB gzip
 * of compiler tooling, not application JavaScript. No compiler-source map is
 * needed: authored-source mappings are produced by the compiler itself.
 */
export async function bundleVolarCompiler({ packageDir, outdir }) {
	const root = resolve(packageDir);
	assertVolarDeclaration(root);
	const compilerDirectory = join(root, 'src/compiler');
	const entryPoint = join(compilerDirectory, 'volar.js');
	const parserModules = new Set(
		['parser.browser.js', 'parser-output.js'].map((name) => join(compilerDirectory, name)),
	);
	const outputDirectory = resolve(outdir);
	const result = await build({
		absWorkingDir: root,
		entryPoints: [entryPoint],
		outfile: join(outputDirectory, 'volar.js'),
		bundle: true,
		write: false,
		metafile: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		legalComments: 'inline',
		banner: { js: '// Bundled compiler dependency notices: ./volar.LICENSES.txt' },
		plugins: [
			{
				name: 'preserve-octane-compiler-modules',
				setup(buildApi) {
					buildApi.onResolve({ filter: /^\./ }, ({ path, importer }) => {
						if (
							isWithin(compilerDirectory, importer) &&
							!parserModules.has(resolve(dirname(importer), path))
						)
							return { path, external: true };
					});
				},
			},
		],
	});
	const output = Object.values(result.metafile.outputs).find((file) => file.entryPoint);
	for (const dependency of output.imports) {
		if (!dependency.external || !dependency.path.startsWith('./')) {
			throw new Error(`Volar bundle left an unexpected dependency: ${dependency.path}`);
		}
	}
	const notices = new Map();
	// Use emitted inputs, not the pre-tree-shaking dependency graph: unused
	// imports need no redistribution, and every byte we do ship needs its notice.
	for (const [input, metadata] of Object.entries(output.inputs)) {
		if (metadata.bytesInOutput === 0) continue;
		const file = resolve(root, input);
		if (file === entryPoint || parserModules.has(file)) continue;
		if (isWithin(join(root, 'src'), file)) {
			throw new Error(`Volar bundle must not duplicate an Octane module: ${input}`);
		}
		const notice = dependencyNotice(file);
		notices.set(notice.id, notice.text);
	}
	const sortedNotices = [...notices].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	const licenseText = sortedNotices.map(([id, text]) => `${id}\n\n${text}\n`).join('\n');
	// Validate the graph and licenses before replacing the copied compiler file.
	mkdirSync(outputDirectory, { recursive: true });
	for (const file of result.outputFiles) writeFileSync(file.path, file.contents);
	writeFileSync(join(outputDirectory, 'volar.LICENSES.txt'), licenseText);
	return { metafile: result.metafile, dependencies: sortedNotices.map(([id]) => id) };
}
