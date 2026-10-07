import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicTypecheckOptions, publicTypeConsumerSources } from './check-public-types.mjs';

const buildOnlyPackages = ['@typescript-eslint/types', 'vscode-languageserver-types', 'source-map'];
const consumerDependencies = {
	'@types/node': '24.13.3',
	react: '19.2.7',
	'react-dom': '19.2.7',
	typescript: '7.0.2',
	vite: '8.1.5',
};
const compilerConsumer = `
import { compile, compileToVolarMappings, type CompileInspection } from 'octane/compiler';
import { createTextTypeProject, type TextTypeProject } from 'octane/compiler/typescript';
const compiled = compile('function App() @{ <div/> }', 'App.tsrx', { inspect: true });
const inspection: CompileInspection = compiled.inspect;
const mapped = compileToVolarMappings('function App() @{ <div/> }', 'App.tsrx');
const sourceType: 'script' | 'module' = mapped.sourceAst.sourceType;
for (const statement of mapped.sourceAst.body) {
  const nodeType: string = statement.type;
  const parserSpecificField: unknown = statement['parserSpecificField'];
  void nodeType; void parserSpecificField;
}
// @ts-expect-error Compiler Program bodies require AST node objects.
const invalidBody: typeof mapped.sourceAst.body = ['not an AST node'];
// @ts-expect-error Compiler filenames require strings.
compile('function App() @{ <div/> }', 42);
const projectFactory: (options: { tsconfig: string }) => TextTypeProject = createTextTypeProject;
const compilerManifest: Signals.HotSignalModuleManifest | undefined = compiled.hotSignalModule;
if (compilerManifest) {
 const compiledStamp: Signals.HotSignalModuleStamp = Signals.__hotSignalModule(compilerManifest);
 Signals.__registerHotSignalComponent(compiledStamp, nativeComponent);
 const reset: boolean = Signals.__remountHotSignalComponent(compiledStamp, nativeComponent, nativeComponent);
 void reset;
}
// @ts-expect-error Unsafe compiler recipes intentionally omit module metadata.
const definiteManifest: Signals.HotSignalModuleManifest = compiled.hotSignalModule;
void inspection; void sourceType; void invalidBody; void projectFactory; void definiteManifest;
`;

function typedExports(manifest, entries) {
	const result = [];
	const findTypes = (target) => {
		if (typeof target === 'string') {
			const declaration = target.replace(/\.(?:mjs|cjs|js)$/, '.d.ts');
			return entries.includes(`package/${declaration.replace(/^\.\//, '')}`) &&
				declaration.endsWith('.d.ts')
				? declaration
				: undefined;
		}
		if (!target || typeof target !== 'object') return undefined;
		if (typeof target.types === 'string') return target.types;
		for (const condition of Object.values(target)) {
			const declaration = findTypes(condition);
			if (declaration) return declaration;
		}
	};
	for (const [path, target] of Object.entries(manifest.exports)) {
		const declaration = findTypes(target);
		if (declaration) {
			assert(
				entries.includes(`package/${declaration.replace(/^\.\//, '')}`),
				`Published declaration: ${path}`,
			);
			result.push({ specifier: path === '.' ? 'octane' : `octane${path.slice(1)}`, declaration });
		}
	}
	return result;
}

/** Prepare only. The caller owns normal installation, generated outputs and cleanup. */
export function prepareIsolatedPublicConsumer(artifact, directory) {
	assert(artifact && isAbsolute(artifact), 'Pass an absolute actual Octane tarball.');
	assert(directory && isAbsolute(directory), 'Pass an absolute new owned consumer directory.');
	assert(!existsSync(directory), 'Preserve pre-existing directories.');
	const bytes = readFileSync(artifact);
	const manifest = JSON.parse(
		execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }),
	);
	assert.equal(manifest.name, 'octane');
	for (const name of buildOnlyPackages)
		assert(
			!Object.hasOwn(manifest.dependencies, name),
			`Keep build-only ${name} out of the product dependency closure.`,
		);
	const entries = execFileSync('tar', ['-tzf', artifact], { encoding: 'utf8' }).trim().split('\n');
	const publishedExports = typedExports(manifest, entries);
	assert(publishedExports.length > 0, 'Exercise the actual published typed exports.');
	const declarationEntries = entries.filter(
		(file) => file.startsWith('package/dist/') && file.endsWith('.d.ts'),
	);
	for (const file of declarationEntries) {
		const source = execFileSync('tar', ['-xOf', artifact, file], { encoding: 'utf8' });
		for (const dependency of ['@tsrx/core/types', ...buildOnlyPackages])
			assert(
				!source.includes(dependency),
				`Public declaration ${file} must not consume private build-only ${dependency}.`,
			);
	}
	mkdirSync(directory);
	writeFileSync(
		join(directory, 'package.json'),
		`${JSON.stringify(
			{
				name: 'octane-native7-isolated-public-consumer',
				private: true,
				type: 'module',
				packageManager: 'pnpm@11.15.1',
				dependencies: { octane: `file:${artifact}`, ...consumerDependencies },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(directory, 'pnpm-workspace.yaml'),
		[
			'packages:',
			'  - .',
			'packageImportMethod: clone-or-copy',
			'nodeLinker: isolated',
			'hoist: false',
			'autoInstallPeers: false',
			'strictPeerDependencies: true',
			'allowBuilds:',
			'  esbuild: true',
			'',
		].join('\n'),
	);
	const sources = publicTypeConsumerSources();
	const imports = publishedExports.map(
		({ specifier }, index) => `import type * as Entry${index} from '${specifier}';`,
	);
	const checkedExports = `export type PublishedEntries = [${publishedExports.map((_, index) => `typeof Entry${index}`).join(', ')}];`;
	const completeConsumer = `${imports.join('\n')}\n${checkedExports}\n${sources.client}\n${sources.server}\n${compilerConsumer}`;
	const invalidCompiler =
		"import { compile } from 'octane/compiler';\ncompile('function App() @{ <div/> }', 42);\n";
	const consumers = [
		{
			name: 'bundler',
			config: 'tsconfig.json',
			file: 'consumer.ts',
			source: completeConsumer,
			types: ['node'],
			invalidFile: 'invalid-consumer.ts',
			invalidSource: invalidCompiler,
			diagnostic: 2345,
		},
		{
			name: 'client',
			config: 'tsconfig.client.json',
			file: 'client.ts',
			source: sources.client,
			types: [],
		},
		{
			name: 'nodenext',
			config: 'tsconfig.nodenext.json',
			file: 'consumer.mts',
			source: completeConsumer,
			module: 'nodenext',
			moduleResolution: 'nodenext',
			types: ['node'],
			invalidFile: 'invalid-consumer.mts',
			invalidSource: invalidCompiler,
			diagnostic: 2345,
		},
	];
	// The actual manifest advertises CJS only for these runtime namespaces. The
	// compiler remains its published ESM entry; no compiler CJS format is assumed.
	const cjsExports = ['.', './signals', './server'].map((subpath) => ({
		subpath,
		target: manifest.exports[subpath]?.node?.require ?? manifest.exports[subpath]?.require,
	}));
	if (cjsExports.every(({ target }) => typeof target === 'string' && target.endsWith('.cjs'))) {
		for (const { subpath, target } of cjsExports)
			assert(
				entries.includes(`package/${target.replace(/^\.\//, '')}`),
				`Published CJS entry: ${subpath}`,
			);
		const cjs = publicTypeConsumerSources({}, { commonjs: true });
		consumers.push({
			name: 'cjs',
			config: 'tsconfig.cjs.json',
			file: 'consumer.cts',
			source: `${cjs.client}\n${cjs.server}`,
			module: 'nodenext',
			moduleResolution: 'nodenext',
			types: ['node'],
			invalidFile: 'invalid-consumer.cts',
			diagnostic: 2322,
			invalidSource:
				"import Octane = require('octane');\ndeclare const component: Octane.ComponentBody<{ count: number }>;\nOctane.publisherBoundary(component, { publisherKey: 42 });\n",
		});
	}
	for (const project of consumers) {
		writeFileSync(join(directory, project.file), project.source);
		if (project.invalidFile)
			writeFileSync(join(directory, project.invalidFile), project.invalidSource);
		writeFileSync(
			join(directory, project.config),
			`${JSON.stringify(
				{
					compilerOptions: {
						...publicTypecheckOptions,
						types: project.types,
						...(project.module
							? { module: project.module, moduleResolution: project.moduleResolution }
							: {}),
					},
					files: [project.file, ...(project.invalidFile ? [project.invalidFile] : [])],
				},
				null,
				2,
			)}\n`,
		);
	}
	const expected = {
		manifest,
		publishedExports,
		consumers: consumers.map(({ source, invalidSource, ...project }) => project),
		cjsExports: cjsExports.filter(
			({ target }) => typeof target === 'string' && target.endsWith('.cjs'),
		),
		declarationCount: declarationEntries.length,
		artifactSha256: createHash('sha256').update(bytes).digest('hex'),
	};
	writeFileSync(
		join(directory, 'expected-artifact.json'),
		`${JSON.stringify(expected, null, 2)}\n`,
	);
	return {
		directory,
		artifact,
		version: manifest.version,
		publishedExports,
		declarationCount: declarationEntries.length,
		artifactSha256: expected.artifactSha256,
		install: ['pnpm', 'install', '--store-dir', '/Users/satan/Library/pnpm/store'],
		check: [process.execPath, import.meta.filename, 'check', directory],
	};
}

/** Check the actual normal isolated installation with no virtual files or resolution overrides. */
export async function checkIsolatedPublicConsumer(directory) {
	assert(directory && isAbsolute(directory), 'Pass the absolute prepared consumer directory.');
	const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
	assert.deepEqual(
		Object.keys(manifest.dependencies).sort(),
		['octane', ...Object.keys(consumerDependencies)].sort(),
	);
	const expected = JSON.parse(readFileSync(join(directory, 'expected-artifact.json'), 'utf8'));
	const require = createRequire(join(directory, 'package.json'));
	const compilerManifestPath = require.resolve('typescript/package.json');
	const compilerManifest = JSON.parse(readFileSync(compilerManifestPath, 'utf8'));
	assert.equal(compilerManifest.version, '7.0.2');
	const compilerEntry = realpathSync(require.resolve('octane/compiler'));
	const octaneDirectory = resolve(dirname(compilerEntry), '../..');
	assert.deepEqual(
		JSON.parse(readFileSync(join(octaneDirectory, 'package.json'), 'utf8')),
		expected.manifest,
	);
	const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
	const evidence = {
		typescript: compilerManifest.version,
		compilerManifestPath,
		compilerEntry,
		artifactSha256: expected.artifactSha256,
		declarationCount: expected.declarationCount,
		publishedExports: expected.publishedExports,
		consumers: [],
		cjsExports: [],
	};
	// Resolve the real installed CommonJS conditions and inspect the ordinary native
	// namespaces. No source aliases, virtual declarations or compiler CJS bridge.
	const requiredCjs = {
		'.': ['publisherBoundary'],
		'./signals': [
			'__signalAt',
			'__derivedScalarAt',
			'__derivedAt',
			'__queryAt',
			'__hotSignalModule',
			'__registerHotSignalComponent',
			'__remountHotSignalComponent',
		],
		'./server': [
			'publisherBoundary',
			'prepareExternalSnapshotRequest',
			'renderExternalSnapshot',
			'releasePreparedExternalSnapshotRequest',
		],
	};
	for (const { subpath, target } of expected.cjsExports) {
		const specifier = subpath === '.' ? 'octane' : `octane${subpath.slice(1)}`;
		const resolved = realpathSync(require.resolve(specifier));
		assert.equal(
			resolved,
			realpathSync(resolve(octaneDirectory, target)),
			`Installed CJS condition: ${specifier}`,
		);
		const namespace = require(specifier);
		for (const name of requiredCjs[subpath])
			assert.equal(typeof namespace[name], 'function', `${specifier} exports ${name}`);
		if (subpath === './signals')
			for (const name of ['admitHotSignalPublisher', 'createNativeHotSignalOwnerProof'])
				assert(
					!Object.hasOwn(namespace, name),
					`Keep ${name} private in the actual CJS namespace.`,
				);
		evidence.cjsExports.push({ specifier, resolved, names: Object.keys(namespace) });
	}
	const api = new API({ cwd: directory });
	try {
		const snapshot = api.updateSnapshot({
			openProjects: expected.consumers.map(({ config }) => join(directory, config)),
		});
		try {
			for (const consumer of expected.consumers) {
				const project = snapshot.getProject(join(directory, consumer.config));
				assert(project, `Load the actual isolated native7 ${consumer.name} consumer.`);
				assert.equal(project.compilerOptions.skipLibCheck, false);
				assert.equal(project.compilerOptions.strict, true);
				assert.deepEqual(project.compilerOptions.types, consumer.types);
				const { program } = project;
				const diagnostics = [
					...program.getConfigFileParsingDiagnostics(),
					...program.getProgramDiagnostics(),
					...program.getGlobalDiagnostics(),
					...program.getSyntacticDiagnostics(),
					...program.getSemanticDiagnostics(),
				];
				const sourceFiles = program.getSourceFileNames();
				evidence.consumers.push({ name: consumer.name, diagnostics, sourceFiles });
				if (diagnostics.length !== (consumer.invalidFile ? 1 : 0))
					console.error(JSON.stringify({ name: consumer.name, diagnostics }, null, 2));
				assert.equal(
					diagnostics.length,
					consumer.invalidFile ? 1 : 0,
					`Only the intentional invalid ${consumer.name} consumer may produce a diagnostic.`,
				);
				if (consumer.invalidFile) {
					assert.equal(
						diagnostics[0].code,
						consumer.diagnostic,
						`Reject invalid public ${consumer.name} usage.`,
					);
					assert.equal(diagnostics[0].fileName, join(directory, consumer.invalidFile));
				}
				if (consumer.name === 'bundler' || consumer.name === 'nodenext')
					for (const { declaration } of expected.publishedExports)
						assert(
							sourceFiles.includes(resolve(octaneDirectory, declaration)),
							`Check actual published entry ${declaration} in ${consumer.name}.`,
						);
				for (const name of buildOnlyPackages)
					assert(
						!sourceFiles.some((file) => file.includes(`/node_modules/${name}/`)),
						`No ${name} in the actual public declaration closure.`,
					);
				assert(
					!sourceFiles.some((file) => file.includes('/node_modules/@tsrx/core/types/index.d.ts')),
					'Public APIs retain their original parser-opaque boundary.',
				);
				if (consumer.name === 'client')
					assert(
						!sourceFiles.some((file) => file.includes('/node_modules/@types/node/')),
						'The actual browser declaration closure has no Node ambient types.',
					);
			}
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
	console.log(JSON.stringify(evidence, null, 2));
	return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const [command, first, second] = process.argv.slice(2);
	if (command === 'prepare')
		console.log(JSON.stringify(prepareIsolatedPublicConsumer(first, second), null, 2));
	else {
		assert.equal(
			command,
			'check',
			'Use prepare <tarball> <new-owned-directory> or check <directory>.',
		);
		await checkIsolatedPublicConsumer(first);
	}
}
