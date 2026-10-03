import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { API } from 'typescript/unstable/sync';

/**
 * Check a staged publication using its native Octane compiler and TypeScript.
 * The effective config is generated from frozen Git objects before this call.
 * This gate accepts one strict effective project and rejects inheritance and
 * project references.
 * TSRX projections exist only in the checker filesystem; the published source,
 * package exports, strict flags and imported declaration graph remain authored.
 */
export function checkTsrxProject({ configPath, compileToVolarMappings }) {
	const configFile = resolve(configPath);
	const directory = dirname(configFile);
	const config = JSON.parse(readFileSync(configFile, 'utf8'));
	assert(!config.extends, 'Pass the complete staged checker config, without inheritance.');
	assert(
		config.references === undefined ||
			(Array.isArray(config.references) && config.references.length === 0),
		'Pass the complete staged checker config, without a project reference graph.',
	);
	assert.equal(config.compilerOptions?.strict, true, 'Keep the published strict type contract.');
	const projections = new Map();
	const projectionDiagnostics = [];
	let discovery = 'ordinary';
	let roots;
	const serviceName = (file) => (file.endsWith('.tsrx') ? file + '.tsx' : file);
	const authoredName = (file) => {
		if (!file.endsWith('.tsrx.tsx')) return file;
		const authored = file.slice(0, -4);
		const physical = existsSync(file);
		const sourceExists = existsSync(authored);
		assert(!physical || !sourceExists, `A projection conflicts with authored source ${file}.`);
		return !physical && sourceExists ? authored : file;
	};
	const configSource = () => {
		const data = { ...config };
		for (const field of ['files', 'include', 'exclude']) {
			if (!Array.isArray(data[field])) continue;
			data[field] = data[field].map((value) => {
				if (field === 'files' || discovery === 'complete') return serviceName(value);
				const leaf = value.replaceAll('\\', '/').split('/').at(-1);
				return discovery === 'native' && /[.*?]/.test(leaf)
					? `${value.endsWith('/**') ? value + '/*' : value}.tsx`
					: value;
			});
		}
		return JSON.stringify({
			...data,
			...(roots === undefined ? {} : { files: roots.map(serviceName), include: [], exclude: [] }),
			compilerOptions: {
				...data.compilerOptions,
				...(data.compilerOptions?.paths
					? {
							paths: Object.fromEntries(
								Object.entries(data.compilerOptions.paths).map(([name, values]) => [
									name,
									values.map(serviceName),
								]),
							),
						}
					: {}),
				noEmit: true,
				noCheck: false,
				skipLibCheck: false,
				skipDefaultLibCheck: false,
				allowArbitraryExtensions: true,
			},
		});
	};
	const fs = {
		readFile(file) {
			if (file === configFile) return configSource();
			const authored = authoredName(file);
			if (authored === file) return undefined;
			if (!projections.has(authored)) {
				const source = readFileSync(authored, 'utf8');
				const projection = compileToVolarMappings(source, authored);
				assert.equal(typeof projection.code, 'string', `Project authored source ${authored}.`);
				for (const diagnostic of [
					...projection.errors,
					...projection.diagnostics.filter((diagnostic) => diagnostic.severity === 'error'),
				])
					projectionDiagnostics.push({ fileName: authored, ...diagnostic });
				projections.set(authored, projection.code);
			}
			return projections.get(authored);
		},
		fileExists(file) {
			if (file.endsWith('.tsrx')) return false;
			if (authoredName(file) !== file) return true;
			return undefined;
		},
		getAccessibleEntries(path) {
			let entries;
			try {
				entries = readdirSync(path, { withFileTypes: true });
			} catch (error) {
				if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
				throw error;
			}
			const files = [];
			const directories = [];
			for (const entry of entries) {
				if (
					entry.isDirectory() ||
					(entry.isSymbolicLink() && statSync(join(path, entry.name)).isDirectory())
				) {
					directories.push(entry.name);
				} else if (entry.isFile() || entry.isSymbolicLink()) {
					if (entry.name.endsWith('.tsrx')) {
						assert(
							!existsSync(join(path, serviceName(entry.name))),
							`A projection conflicts with authored source ${join(path, serviceName(entry.name))}.`,
						);
						if (discovery !== 'ordinary') files.push(serviceName(entry.name));
					} else files.push(entry.name);
				}
			}
			return { files, directories };
		},
		realpath(file) {
			const authored = authoredName(file);
			return authored === file ? undefined : serviceName(realpathSync(authored));
		},
	};
	const configuredFiles = new Set();
	// Matching ordinary and transposed TSRX selectors separately preserves the
	// original meaning of '*.tsx', '*.tsrx', files, include and exclude.
	for (const mode of ['ordinary', 'native']) {
		discovery = mode;
		const parser = new API({ cwd: directory, fs });
		try {
			for (const file of parser.parseConfigFile(configFile).fileNames) {
				const authored = authoredName(file);
				if (mode === 'ordinary' || authored !== file) configuredFiles.add(authored);
			}
		} finally {
			parser.close();
		}
	}
	roots = [...configuredFiles].sort();
	assert(roots.length > 0, `The staged checker config ${basename(configFile)} must select files.`);
	discovery = 'complete';
	const api = new API({ cwd: directory, fs });
	try {
		const snapshot = api.updateSnapshot({ openProjects: [configFile] });
		try {
			const project = snapshot.getProject(configFile);
			assert(project, 'The native TypeScript publication project must load.');
			const { program } = project;
			const diagnostics = [
				...program.getConfigFileParsingDiagnostics(),
				...program.getProgramDiagnostics(),
				...program.getGlobalDiagnostics(),
				...program.getSyntacticDiagnostics(),
				...program.getBindDiagnostics(),
				...program.getSemanticDiagnostics(),
				...projectionDiagnostics,
			];
			const checkedFiles = program.getSourceFileNames();
			const authoredContents = Object.fromEntries(
				checkedFiles
					.filter(
						(file) =>
							file.endsWith('.json') || (roots.includes(file) && file.endsWith('.tsrx.tsx')),
					)
					.map((file) => [file, program.getSourceFile(file).text]),
			);
			return {
				diagnostics,
				rootFiles: roots,
				checkedFiles,
				authoredContents,
				projectedFiles: [...projections.keys()].sort(),
			};
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}
