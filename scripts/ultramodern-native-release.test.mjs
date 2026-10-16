import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	publishNativeRelease,
	validateNativeReleaseCohort,
	validateNativeReleaseRun,
} from './ultramodern-native-release.mjs';

const sha = 'a'.repeat(40);
const run = {
	repository: { full_name: 'BleedingDev/octane' },
	head_repository: { full_name: 'BleedingDev/octane' },
	path: '.github/workflows/ci.yml',
	event: 'push',
	head_branch: 'main',
	status: 'completed',
	conclusion: 'success',
	head_sha: sha,
	run_attempt: 2,
	html_url: 'https://github.com/BleedingDev/octane/actions/runs/123',
};
const jobs = ['CI provenance', 'validate publishable packages'].map((name) => ({
	name,
	conclusion: 'success',
	head_sha: sha,
	run_attempt: name === 'CI provenance' ? 2 : 1,
}));

test('requires successful full package acceptance from a fork main push', () => {
	assert.deepEqual(validateNativeReleaseRun(run, jobs), { sha, packageAttempt: 1 });
	for (const suffix of ['@main', '@refs/heads/main'])
		assert.deepEqual(validateNativeReleaseRun({ ...run, path: run.path + suffix }, jobs), {
			sha,
			packageAttempt: 1,
		});
	for (const bad of [
		{ event: 'pull_request' },
		{ head_branch: 'feature' },
		{ conclusion: 'failure' },
		{ status: 'in_progress' },
		{ head_repository: { full_name: 'foreign/octane' } },
		{ repository: { full_name: 'octanejs/octane' } },
		{ path: '.github/workflows/other.yml' },
		{ path: '.github/workflows/other.yml@main' },
		{ path: '.github/workflows/ci.yml.backup@main' },
		{ run_attempt: 0 },
	])
		assert.throws(() => validateNativeReleaseRun({ ...run, ...bad }, jobs));
	assert.throws(
		() => validateNativeReleaseRun(run, [jobs[0]]),
		/validate publishable packages must pass/,
	);
	for (const bad of [
		{ conclusion: 'skipped' },
		{ head_sha: 'b'.repeat(40) },
		{ run_attempt: 0 },
		{ run_attempt: 3 },
		{ run_attempt: undefined },
	])
		assert.throws(() => validateNativeReleaseRun(run, [jobs[0], { ...jobs[1], ...bad }]));
	// A newer failure must not be hidden by a previous successful package job.
	const later = { ...jobs[1], run_attempt: 2, conclusion: 'failure' };
	for (const history of [
		[...jobs, later],
		[later, ...jobs],
	]) {
		assert.throws(() => validateNativeReleaseRun(run, history));
		assert.deepEqual(
			validateNativeReleaseRun(
				run,
				history.map((job) => ({ ...job, conclusion: 'success' })),
			),
			{ sha, packageAttempt: 2 },
		);
	}
});

function fixture(context) {
	const root = mkdtempSync(path.join(tmpdir(), 'octane-native-release-test-'));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const accepted = path.join(root, 'accepted');
	mkdirSync(accepted);
	const source = path.join(root, 'source/package');
	mkdirSync(source, { recursive: true });
	const packages = ['octane', '@octanejs/tanstack-router', '@octanejs/rspack-plugin'].map(
		(name, index) => {
			const entry = { name, version: '0.1.0', file: `package-${index}.tgz` };
			writeFileSync(
				path.join(source, 'package.json'),
				JSON.stringify({ name, version: entry.version }),
			);
			execFileSync('tar', [
				'-czf',
				path.join(accepted, entry.file),
				'-C',
				path.dirname(source),
				'package',
			]);
			return {
				...entry,
				integrity: `sha512-${createHash('sha512')
					.update(readFileSync(path.join(accepted, entry.file)))
					.digest('base64')}`,
			};
		},
	);
	const cohort = { sourceCommit: sha, packages };
	const save = () => writeFileSync(path.join(accepted, 'cohort.json'), JSON.stringify(cohort));
	save();
	return { root, accepted, cohort, save };
}

test('checks accepted archive bytes, embedded identities, source and safe paths', (context) => {
	const f = fixture(context);
	assert.equal(validateNativeReleaseCohort(f.accepted, sha).length, 4);
	assert.throws(() => validateNativeReleaseCohort(f.accepted, 'b'.repeat(40)));
	f.cohort.packages[0].version = '9.9.9';
	f.save();
	assert.throws(() => validateNativeReleaseCohort(f.accepted, sha));
	f.cohort.packages[0].version = '0.1.0';
	f.cohort.packages[0].file = '../outside.tgz';
	f.save();
	assert.throws(() => validateNativeReleaseCohort(f.accepted, sha));
	f.cohort.packages[0].file = 'package-0.tgz';
	f.save();
	writeFileSync(path.join(f.accepted, 'package-0.tgz'), 'tampered');
	assert.throws(() => validateNativeReleaseCohort(f.accepted, sha));
});

test('resumes an earlier accepted attempt after a partial rerun and interrupted upload', (context) => {
	const f = fixture(context);
	const temporaryRoot = path.join(f.root, 'temporary');
	mkdirSync(temporaryRoot);
	let release;
	let uploads = 0;
	let creates = 0;
	let fail = true;
	const assets = new Map();
	const commands = {
		temporaryRoot,
		git: (...args) => assert.deepEqual(args, ['merge-base', '--is-ancestor', sha, 'origin/main']),
		gh: (...args) => {
			if (args[0] === 'api') {
				if (args[1].endsWith('/runs/123'))
					return JSON.stringify({ ...run, path: run.path + '@main' });
				if (args[1] === 'repos/BleedingDev/octane/actions/runs/123/jobs?filter=all&per_page=100')
					return JSON.stringify([{ jobs }]);
				if (args[1] === 'graphql') {
					assert(args.includes(`tag=ultramodern-octane-${sha.slice(0, 12)}`));
					return JSON.stringify({
						data: { repository: { release: release ? { databaseId: release.id } : null } },
					});
				}
				// REST tag lookup cannot see a draft; its numeric ID can.
				if (
					release &&
					(args[1].endsWith('/releases/501') ||
						(args[1].includes('/releases/tags/') && !release.draft))
				)
					return JSON.stringify({
						...release,
						assets: [...assets.keys()].map((name) => ({ name })),
					});
				throw Object.assign(new Error('missing release'), { stderr: 'HTTP 404' });
			}
			if (args[0] === 'run') {
				assert.equal(args[args.indexOf('--name') + 1], 'octane-compiler-cohort-123-1');
				cpSync(f.accepted, args[args.indexOf('--dir') + 1], { recursive: true });
				return '';
			}
			const [, command, tag] = args;
			assert.equal(tag, `ultramodern-octane-${sha.slice(0, 12)}`);
			if (command === 'create') {
				assert(!release, 'The existing draft must be resumed, not created again');
				release = { id: 501, target_commitish: sha, draft: true };
				creates++;
			} else if (command === 'upload') {
				if (fail && uploads === 1) throw new Error('upload interrupted');
				const file = args[3],
					name = path.basename(file);
				assert(!assets.has(name));
				assets.set(name, readFileSync(file));
				uploads++;
			} else if (command === 'download')
				writeFileSync(
					path.join(args[args.indexOf('--dir') + 1], args[args.indexOf('--pattern') + 1]),
					assets.get(args[args.indexOf('--pattern') + 1]),
				);
			else if (command === 'edit') release.draft = false;
			else assert.fail(`Unexpected command: ${args}`);
			return '';
		},
	};
	assert.throws(() => publishNativeRelease('123', commands), /upload interrupted/);
	assert.equal(release.draft, true);
	assert.equal(assets.size, 1);
	assert.deepEqual(readdirSync(temporaryRoot), []);
	fail = false;
	publishNativeRelease('123', commands);
	assert.equal(release.draft, false);
	assert.equal(assets.size, 4);
	assert.deepEqual(readdirSync(temporaryRoot), []);
	publishNativeRelease('123', commands);
	assert.equal(uploads, 4);
	assert.equal(creates, 1);
	assert.deepEqual(readdirSync(temporaryRoot), []);
	assets.set('cohort.json', Buffer.from('modified remote bytes'));
	assert.throws(() => publishNativeRelease('123', commands), /Never replace published bytes/);
	assert.deepEqual(readdirSync(temporaryRoot), []);
});
