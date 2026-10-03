import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const host = dirname(fileURLToPath(import.meta.url));
const root = resolve(host, '../..');
const require = createRequire(join(host, 'package.json'));
const digest = (algorithm, bytes, encoding = 'hex') =>
	createHash(algorithm).update(bytes).digest(encoding);

export const nativeTypesRecipe = Object.freeze({
	name: '@typescript-eslint/types',
	version: '8.71.0',
	typescript: '7.0.2',
	upstreamTarball: 'https://registry.npmjs.org/@typescript-eslint/types/-/types-8.71.0.tgz',
	upstreamIntegrity:
		'sha512-cJ4OoxPGWvFnBTnSZyaU+qJzGTqPTGJY+gDchj6cRyLRdmIdt4rcsE4twj+zPfrNiWuVi38wijHzShL++Z9atQ==',
	patch: 'patches/@typescript-eslint__types@8.71.0.patch',
	patchSha256: '27aad21d14f53183954e33dc741b4189fc4861d1afdab63235c544cfe4fac2b2',
	file: 'typescript-eslint-types-8.71.0-native7.0.2.tgz',
	releaseTag: 'typescript-eslint-types@8.71.0+native7.0.2',
});

export const nativeTypesReleaseURI = `https://github.com/bleedingdev/octane/releases/download/${encodeURIComponent(nativeTypesRecipe.releaseTag)}/${encodeURIComponent(nativeTypesRecipe.file)}`;

function payloadFiles(directory, prefix = '') {
	return readdirSync(directory)
		.sort()
		.flatMap((name) => {
			const file = prefix ? `${prefix}/${name}` : name;
			const path = join(directory, name);
			const stat = lstatSync(path);
			assert(stat.isDirectory() || stat.isFile(), `Unexpected package entry: ${file}`);
			return stat.isDirectory() ? payloadFiles(path, file) : [file];
		});
}

function comparePayload(actual, expected) {
	const files = payloadFiles(expected);
	assert.deepEqual(payloadFiles(actual), files, 'Preserve the complete upstream package payload.');
	for (const file of files) {
		assert.deepEqual(
			readFileSync(join(actual, file)),
			readFileSync(join(expected, file)),
			`Verified native type payload: ${file}`,
		);
		assert.equal(
			lstatSync(join(actual, file)).mode & 0o777,
			lstatSync(join(expected, file)).mode & 0o777,
			`Preserve published file mode: ${file}`,
		);
	}
}

export async function fetchNativeTypesUpstream() {
	const response = await fetch(nativeTypesRecipe.upstreamTarball, {
		signal: AbortSignal.timeout(30_000),
	});
	assert(response.ok, `Official type package fetch failed: ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	assert.equal(
		`sha512-${digest('sha512', bytes, 'base64')}`,
		nativeTypesRecipe.upstreamIntegrity,
		'Official npm type package integrity',
	);
	return bytes;
}

function extractPackage(bytes, destination) {
	const entries = execFileSync('tar', ['-tzf', '-'], { input: bytes, encoding: 'utf8' })
		.trim()
		.split('\n');
	assert(
		entries.every(
			(file) =>
				file.startsWith('package/') &&
				!file.split('/').some((part) => part === '..' || part === '.') &&
				!file.includes('\\'),
		),
		'Package archive entries must remain within package/.',
	);
	mkdirSync(destination);
	execFileSync('tar', ['-xzf', '-', '-C', destination], { input: bytes });
	const packageDir = join(destination, 'package');
	payloadFiles(packageDir);
	return packageDir;
}

function reconstructPackage(bytes, stage) {
	assert.equal(
		`sha512-${digest('sha512', bytes, 'base64')}`,
		nativeTypesRecipe.upstreamIntegrity,
		'Official npm type package integrity',
	);
	const packageDir = extractPackage(bytes, join(stage, 'upstream'));
	const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
	assert.equal(manifest.name, nativeTypesRecipe.name);
	assert.equal(manifest.version, nativeTypesRecipe.version);
	assert.equal(manifest.license, 'MIT');
	const registration = `  '${nativeTypesRecipe.name}@${nativeTypesRecipe.version}': ../../${nativeTypesRecipe.patch}`;
	assert(
		readFileSync(join(host, 'pnpm-workspace.yaml'), 'utf8').split('\n').includes(registration),
		'The build host must install the maintained canonical patch normally.',
	);
	const patch = readFileSync(join(root, nativeTypesRecipe.patch));
	assert.equal(digest('sha256', patch), nativeTypesRecipe.patchSha256, 'Canonical patch digest');
	execFileSync('patch', ['-p1', '--fuzz=0', '--batch'], { cwd: packageDir, input: patch });
	return packageDir;
}

export const nativeTypesConsumer = `
import { AST_NODE_TYPES, type ParserOptions, type TSESTree } from '@typescript-eslint/types';
import { SyntaxKind } from 'typescript/unstable/ast';
import type { Program } from 'typescript/unstable/sync';
declare const program: Program;
const parser: ParserOptions = { programs: [program] };
const addition: TSESTree.AssignmentOperatorToText[SyntaxKind.PlusEqualsToken] = '+=';
const fallback: TSESTree.AssignmentOperatorToText[SyntaxKind.QuestionQuestionEqualsToken] = '??=';
declare const assignment: TSESTree.AssignmentExpression;
const expression: TSESTree.Expression = assignment;
const node: TSESTree.Node = expression;
const kind: AST_NODE_TYPES.AssignmentExpression = assignment.type;
// @ts-expect-error Native SyntaxKind mappings must retain their exact operator values.
const invalidOperator: TSESTree.AssignmentOperatorToText[SyntaxKind.PlusEqualsToken] = '=';
// @ts-expect-error Parser options require the actual native Program interface.
const invalidProgram: ParserOptions = { programs: [{}] };
void parser; void addition; void fallback; void node; void kind;
void invalidOperator; void invalidProgram;
`;

/** Check unpacked publication bytes through canonical package exports without editing dependencies. */
export async function checkNativeTypes(packageDir, source = nativeTypesConsumer) {
	const compilerManifest = JSON.parse(
		readFileSync(require.resolve('typescript/package.json'), 'utf8'),
	);
	assert.equal(
		compilerManifest.version,
		nativeTypesRecipe.typescript,
		'Use stable native TypeScript.',
	);
	const [{ API }, { createVirtualFileSystem }] = await Promise.all([
		import(pathToFileURL(require.resolve('typescript/unstable/sync')).href),
		import(pathToFileURL(require.resolve('typescript/unstable/fs')).href),
	]);
	const installed = dirname(require.resolve('@typescript-eslint/types/package.json'));
	const entry = join(host, `.native-types-consumer-${process.pid}.ts`);
	const config = join(host, `.native-types-consumer-${process.pid}.tsconfig.json`);
	const files = {
		[entry]: source,
		[config]: JSON.stringify({
			compilerOptions: {
				target: 'esnext',
				module: 'preserve',
				moduleResolution: 'bundler',
				lib: ['esnext', 'dom'],
				strict: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				verbatimModuleSyntax: true,
				types: [],
				skipLibCheck: false,
				noEmit: true,
			},
			files: [entry],
		}),
	};
	// Override the resolved package with the actual unpacked bytes. Native export
	// and import resolution still uses its complete published manifest.
	for (const file of payloadFiles(packageDir))
		files[join(installed, file)] = readFileSync(join(packageDir, file), 'utf8');
	const virtual = createVirtualFileSystem(files);
	const api = new API({
		cwd: host,
		fs: {
			readFile: virtual.readFile,
			fileExists: (file) => virtual.fileExists(file) || undefined,
		},
	});
	try {
		const snapshot = api.updateSnapshot({ openProjects: [config] });
		try {
			const project = snapshot.getProject(config);
			assert(project, 'Load the published type consumer with native TypeScript.');
			const { program } = project;
			const diagnostics = [
				...program.getConfigFileParsingDiagnostics(),
				...program.getProgramDiagnostics(),
				...program.getGlobalDiagnostics(),
				...program.getSyntacticDiagnostics(),
				...program.getSemanticDiagnostics(),
			];
			const sourceFiles = program.getSourceFileNames();
			for (const file of [
				'dist/index.d.ts',
				'dist/generated/ast-spec.d.ts',
				'dist/parser-options.d.ts',
			])
				assert(sourceFiles.includes(join(installed, file)), `Check published declaration: ${file}`);
			return { typescript: compilerManifest.version, diagnostics, sourceFiles };
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

function archivePackage(packageDir) {
	const members = [];
	const collect = (directory, member) => {
		members.push(member);
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const child = `${member}/${name}`;
			if (lstatSync(path).isDirectory()) collect(path, child);
			else members.push(child);
			utimesSync(path, 0, 0);
		}
		utimesSync(directory, 0, 0);
	};
	collect(packageDir, 'package');
	const archive = execFileSync(
		'tar',
		[
			'-cf',
			'-',
			'--format=ustar',
			'--uid',
			'0',
			'--gid',
			'0',
			'--uname',
			'root',
			'--gname',
			'root',
			'--no-recursion',
			...(process.platform === 'darwin' ? ['--no-xattrs', '--no-acls', '--no-fflags'] : []),
			'-C',
			dirname(packageDir),
			'-T',
			'-',
		],
		{ input: `${members.join('\n')}\n` },
	);
	return execFileSync('gzip', ['-n', '-c'], { input: archive });
}

export async function packNativeTypes({ output, packageDir, upstreamBytes } = {}) {
	assert(output && isAbsolute(output), 'Pass an absolute owned artifact directory.');
	const source = packageDir ?? dirname(require.resolve('@typescript-eslint/types/package.json'));
	const bytes = upstreamBytes ?? (await fetchNativeTypesUpstream());
	mkdirSync(output, { recursive: true });
	const stage = mkdtempSync(join(output, '.native-types-stage-'));
	const cleanup = () => rmSync(stage, { recursive: true, force: true });
	const interrupt = () => {
		cleanup();
		process.exit(130);
	};
	const terminate = () => {
		cleanup();
		process.exit(143);
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		const expected = reconstructPackage(bytes, stage);
		comparePayload(source, expected);
		// Only verified installed bytes are packed. The reconstructed copy is the
		// independent oracle, never a substitute for the actual installation.
		const publication = join(stage, 'publication');
		mkdirSync(publication);
		const staged = join(publication, 'package');
		mkdirSync(staged);
		for (const file of payloadFiles(source)) {
			mkdirSync(dirname(join(staged, file)), { recursive: true });
			writeFileSync(join(staged, file), readFileSync(join(source, file)), {
				mode: lstatSync(join(source, file)).mode & 0o777,
			});
		}
		comparePayload(staged, expected);
		const packed = archivePackage(staged);
		const unpacked = extractPackage(packed, join(stage, 'unpacked'));
		comparePayload(unpacked, expected);
		const checked = await checkNativeTypes(unpacked);
		assert.equal(checked.diagnostics.length, 0, JSON.stringify(checked.diagnostics, null, 2));
		const artifact = join(output, nativeTypesRecipe.file);
		const provenancePath = `${artifact}.provenance.json`;
		const provenance = {
			schemaVersion: 1,
			package: { name: nativeTypesRecipe.name, version: nativeTypesRecipe.version },
			upstream: {
				tarball: nativeTypesRecipe.upstreamTarball,
				integrity: nativeTypesRecipe.upstreamIntegrity,
			},
			patch: { path: nativeTypesRecipe.patch, sha256: nativeTypesRecipe.patchSha256 },
			producer: { node: process.version, typescript: checked.typescript },
			artifact: {
				file: nativeTypesRecipe.file,
				sha256: digest('sha256', packed),
				integrity: `sha512-${digest('sha512', packed, 'base64')}`,
				intendedReleaseURI: nativeTypesReleaseURI,
			},
		};
		writeFileSync(artifact, packed, { flag: 'wx' });
		try {
			writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
		} catch (error) {
			rmSync(artifact);
			throw error;
		}
		return { artifactPath: artifact, provenancePath, ...provenance };
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
		cleanup();
	}
}

/** Accept the maintained type dependency only when its descriptor matches verified publication bytes. */
export async function verifyNativeTypeDependency(pin, descriptor, output) {
	assert.equal(pin, nativeTypesReleaseURI, 'Use the maintained native type-package release.');
	assert(descriptor, 'Record the maintained native type-package source descriptor.');
	assert.equal(descriptor.name, nativeTypesRecipe.name, 'Canonical native type-package name');
	assert.equal(
		descriptor.version,
		nativeTypesRecipe.version,
		'Canonical native type-package version',
	);
	assert.equal(descriptor.url, pin, 'Native type-package descriptor must identify its dependency.');
	assert.match(
		descriptor.integrity,
		/^sha512-[A-Za-z0-9+/]{86}==$/,
		'Native type-package integrity',
	);
	assert(output && isAbsolute(output), 'Pass an absolute owned artifact directory.');
	const directory = mkdtempSync(join(output, '.native-types-dependency-'));
	const cleanup = () => rmSync(directory, { recursive: true, force: true });
	const interrupt = () => {
		cleanup();
		process.exit(130);
	};
	const terminate = () => {
		cleanup();
		process.exit(143);
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		const verified = await packNativeTypes({ output: directory });
		assert.deepEqual(
			descriptor,
			{
				name: nativeTypesRecipe.name,
				version: nativeTypesRecipe.version,
				url: nativeTypesReleaseURI,
				integrity: verified.artifact.integrity,
			},
			'The native type-package descriptor must match the complete verified artifact.',
		);
	} finally {
		process.off('SIGINT', interrupt);
		process.off('SIGTERM', terminate);
		cleanup();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	console.log(JSON.stringify(await packNativeTypes({ output: process.argv[2] }), null, 2));
