import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repository = 'BleedingDev/octane';
const packageNames = ['octane', '@octanejs/tanstack-router', '@octanejs/rspack-plugin'];
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function validateNativeReleaseRun(run, jobs) {
	assert.equal(run.repository?.full_name, repository);
	assert.equal(run.head_repository?.full_name, repository);
	assert.equal(run.path, '.github/workflows/ci.yml');
	assert.equal(run.event, 'push');
	assert.equal(run.head_branch, 'main');
	assert.equal(run.status, 'completed');
	assert.equal(run.conclusion, 'success');
	assert.match(run.head_sha, /^[a-f0-9]{40}$/);
	assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
	for (const name of ['CI provenance', 'validate publishable packages'])
		assert(
			jobs.some((job) => job.name === name && job.conclusion === 'success'),
			`${name} must pass`,
		);
	return run.head_sha;
}

export function validateNativeReleaseCohort(directory, sourceCommit) {
	const cohort = JSON.parse(readFileSync(path.join(directory, 'cohort.json'), 'utf8'));
	assert.equal(cohort.sourceCommit, sourceCommit);
	assert.deepEqual(cohort.packages.map((entry) => entry.name).sort(), [...packageNames].sort());
	assert.equal(new Set(cohort.packages.map((entry) => entry.file)).size, packageNames.length);
	for (const entry of cohort.packages) {
		assert.match(entry.file, /^[A-Za-z0-9._+-]+\.tgz$/);
		const file = path.join(directory, entry.file);
		assert(lstatSync(file).isFile(), 'Release archives must be regular files');
		assert.equal(integrity(readFileSync(file)), entry.integrity);
		const manifest = JSON.parse(
			execFileSync('tar', ['-xOf', file, 'package/package.json'], { maxBuffer: 1024 * 1024 }),
		);
		assert.equal(manifest.name, entry.name);
		assert.equal(manifest.version, entry.version);
	}
	return ['cohort.json', ...cohort.packages.map((entry) => entry.file)];
}

export function publishNativeRelease(runId, commands = {}) {
	assert.match(runId, /^[1-9][0-9]*$/);
	const gh = commands.gh ?? ((...args) => execFileSync('gh', args, { encoding: 'utf8' }));
	const api = (...args) => JSON.parse(gh('api', ...args));
	const run = api(`repos/${repository}/actions/runs/${runId}`);
	const jobs = api(
		`repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`,
		'--paginate',
		'--slurp',
	).flatMap((page) => page.jobs);
	const sha = validateNativeReleaseRun(run, jobs);
	(commands.git ?? ((...args) => execFileSync('git', args)))(
		'merge-base',
		'--is-ancestor',
		sha,
		'origin/main',
	);
	const directory = mkdtempSync(
		path.join(commands.temporaryRoot ?? process.env.RUNNER_TEMP, 'octane-native-release-'),
	);
	try {
		const accepted = path.join(directory, 'accepted');
		gh(
			'run',
			'download',
			runId,
			'--repo',
			repository,
			'--name',
			`octane-compiler-cohort-${runId}-${run.run_attempt}`,
			'--dir',
			accepted,
		);
		const files = validateNativeReleaseCohort(accepted, sha);
		const tag = `ultramodern-octane-${sha.slice(0, 12)}`;
		// GraphQL can resolve a pending draft tag; REST's tag endpoint only sees published releases.
		const id = api(
			'graphql',
			'-f',
			'query=query($tag: String!) { repository(owner: "BleedingDev", name: "octane") { release(tagName: $tag) { databaseId } } }',
			'-f',
			`tag=${tag}`,
		).data.repository.release?.databaseId;
		const release = id === undefined ? undefined : api(`repos/${repository}/releases/${id}`);
		if (release) {
			assert.equal(release.target_commitish, sha);
			assert(
				release.assets.every((asset) => files.includes(asset.name)),
				'Unexpected release asset',
			);
			if (!release.draft)
				assert.equal(release.assets.length, files.length, 'Published release is incomplete');
			for (const asset of release.assets) {
				gh(
					'release',
					'download',
					tag,
					'--repo',
					repository,
					'--pattern',
					asset.name,
					'--dir',
					directory,
				);
				assert.deepEqual(
					readFileSync(path.join(directory, asset.name)),
					readFileSync(path.join(accepted, asset.name)),
					'Never replace published bytes',
				);
			}
		} else {
			gh(
				'release',
				'create',
				tag,
				'--repo',
				repository,
				'--target',
				sha,
				'--draft',
				'--title',
				`UltraModern Octane ${sha.slice(0, 12)}`,
				'--notes',
				`Exact runtime, router and compiler archives accepted by ${run.html_url}. Source: ${sha}.`,
			);
		}
		for (const file of files)
			if (!release?.assets.some((asset) => asset.name === file))
				gh('release', 'upload', tag, path.join(accepted, file), '--repo', repository);
		gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=false');
		console.log(`https://github.com/${repository}/releases/tag/${tag}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	publishNativeRelease(process.argv[2]);
