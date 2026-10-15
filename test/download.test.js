import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkoutSource, downloadSkills, loadBundles, parseArgs, validateBundle } from '../scripts/download.js';

const exec = promisify(execFile);
const ref = 'a'.repeat(40);
const spec = name => ({ repository: 'https://github.com/example/skills', ref, path: `skills/${name}`, description: name });
const quiet = () => {};

async function temp(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'my-skills-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function putSkill(repository, name, content = 'original') {
  const directory = path.join(repository, 'skills', name);
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\n---\n${content}\n`);
  await writeFile(path.join(directory, 'scripts', 'helper.py'), content);
}

const checkoutFixture = async (_repository, _ref, paths, directory) => {
  for (const skillPath of paths) await putSkill(directory, path.basename(skillPath));
};

test('six purpose folders contain 22 skills, with only the known missing source pending', async () => {
  const bundles = await loadBundles();
  assert.deepEqual([...bundles.keys()], ['dev', 'frontend', 'backend', 'design', 'imagegen', 'planning']);
  const skills = [...bundles.values()].flatMap(bundle => Object.entries(bundle.skills));
  assert.equal(skills.length, 22);
  assert.equal(new Set(skills.map(([name]) => name)).size, 22);
  assert.deepEqual(skills.filter(([, skill]) => skill.status === 'source-needed').map(([name]) => name), ['micro-saas-finder']);
});

test('invalid flags, missing destination, unsafe paths and unpinned sources fail', () => {
  assert.throws(() => parseArgs(['--dest']), /--dest/);
  assert.throws(() => parseArgs(['--unknown']), /알 수 없는 옵션/);
  assert.deepEqual(parseArgs(['dev', 'frontend', '--dest', 'some folder', '--force']).bundles, ['dev', 'frontend']);
  for (const change of [{ path: '../escape' }, { path: '/absolute' }, { ref: 'main' }, { repository: 'file:///tmp/local' }]) {
    assert.throws(() => validateBundle({ title: 'test', skills: { alpha: { ...spec('alpha'), ...change } } }, 'test'));
  }
});

test('download copies supporting files, groups a common source and preserves existing local changes', async t => {
  const directory = await temp(t);
  const destination = path.join(directory, 'download');
  let checkouts = 0;
  const checkout = async (...args) => { checkouts++; await checkoutFixture(...args); };
  const skills = new Map([['alpha', spec('alpha')], ['beta', spec('beta')]]);
  const first = await downloadSkills({ skills, destination, checkout, log: quiet });
  assert.equal(first.downloaded, 2);
  assert.equal(checkouts, 1);
  assert.equal(await readFile(path.join(destination, 'alpha/scripts/helper.py'), 'utf8'), 'original');
  assert.equal(JSON.parse(await readFile(path.join(destination, 'alpha/.my-skills-source.json'))).ref, ref);
  await writeFile(path.join(destination, 'alpha/SKILL.md'), 'local edit');
  const repeat = await downloadSkills({ skills, destination, checkout, log: quiet });
  assert.equal(repeat.skipped, 2);
  assert.equal(checkouts, 1);
  assert.equal(await readFile(path.join(destination, 'alpha/SKILL.md'), 'utf8'), 'local edit');
  await downloadSkills({ skills, destination, checkout, force: true, log: quiet });
  assert.match(await readFile(path.join(destination, 'alpha/SKILL.md'), 'utf8'), /name: alpha/);
  assert.deepEqual((await readdir(destination)).sort(), ['alpha', 'beta']);
});

test('missing upstream leaves all existing files untouched and pending source downloads nothing', async t => {
  const directory = await temp(t);
  const destination = path.join(directory, 'download');
  await mkdir(path.join(destination, 'alpha'), { recursive: true });
  await writeFile(path.join(destination, 'alpha/SKILL.md'), 'local edit');
  const checkout = async (_repository, _ref, _paths, output) => { await putSkill(output, 'alpha'); };
  await assert.rejects(downloadSkills({ skills: new Map([['alpha', spec('alpha')], ['beta', spec('beta')]]), destination, force: true, checkout, log: quiet }), /ENOENT/);
  assert.equal(await readFile(path.join(destination, 'alpha/SKILL.md'), 'utf8'), 'local edit');
  const missingDestination = path.join(directory, 'pending');
  const pending = await downloadSkills({ skills: new Map([['pending', { status: 'source-needed' }]]), destination: missingDestination, log: quiet, checkout });
  assert.deepEqual(pending, { downloaded: 0, skipped: 0, unavailable: 1 });
  await assert.rejects(access(missingDestination), /ENOENT/);
});

test('failure during replacement restores an already replaced skill', async t => {
  const directory = await temp(t);
  const destination = path.join(directory, 'download');
  await mkdir(path.join(destination, 'alpha'), { recursive: true });
  await writeFile(path.join(destination, 'alpha/custom.txt'), 'preserve');
  const checkout = async (...args) => {
    await checkoutFixture(...args);
    // A competing process creates an incompatible target after the initial checks.
    await writeFile(path.join(destination, 'beta'), 'concurrent file');
  };
  await assert.rejects(downloadSkills({ skills: new Map([['alpha', spec('alpha')], ['beta', spec('beta')]]), destination, force: true, checkout, log: quiet }), /교체할 수 없는 대상/);
  assert.equal(await readFile(path.join(destination, 'alpha/custom.txt'), 'utf8'), 'preserve');
  assert.equal(await readFile(path.join(destination, 'beta'), 'utf8'), 'concurrent file');
  assert.deepEqual((await readdir(destination)).sort(), ['alpha', 'beta']);
});

test('Git download uses pinned revision, includes nested files and excludes unrelated directories', async t => {
  const directory = await temp(t);
  const repository = path.join(directory, 'upstream');
  await mkdir(repository);
  const git = async (...args) => (await exec('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd: repository })).stdout.trim();
  await git('init', '--quiet');
  await git('config', 'user.name', 'Skill fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'commit.gpgsign', 'false');
  await putSkill(repository, 'alpha', 'pinned');
  await mkdir(path.join(repository, 'unrelated'));
  await writeFile(path.join(repository, 'unrelated/large.txt'), 'exclude');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'pinned');
  const pinned = await git('rev-parse', 'HEAD');
  await putSkill(repository, 'alpha', 'newer');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'newer');
  const output = path.join(directory, 'checkout');
  await checkoutSource(repository, pinned, ['skills/alpha'], output);
  assert.equal(await readFile(path.join(output, 'skills/alpha/scripts/helper.py'), 'utf8'), 'pinned');
  await assert.rejects(access(path.join(output, 'unrelated')), /ENOENT/);
});
