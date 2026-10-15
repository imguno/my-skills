import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function git(cwd, ...args) {
  try {
    return (await exec('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', '-c', 'core.symlinks=false', ...args], {
      cwd, maxBuffer: 16 * 1024 * 1024, timeout: 180_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })).stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Git을 찾을 수 없습니다. Git을 설치한 뒤 다시 실행하세요.');
    throw new Error(`Git 작업 실패: ${args[0]}\n${error.stderr || error.message}`);
  }
}

export function validateBundle(bundle, filename) {
  if (!bundle || typeof bundle.title !== 'string' || !bundle.skills || typeof bundle.skills !== 'object' || Array.isArray(bundle.skills)) {
    throw new Error(`잘못된 skillBundle: ${filename}`);
  }
  for (const [name, skill] of Object.entries(bundle.skills)) {
    if (!idPattern.test(name) || !skill || typeof skill.description !== 'string') throw new Error(`잘못된 스킬: ${name}`);
    if (skill.status === 'source-needed') {
      if (skill.repository != null || skill.path != null || skill.ref != null) throw new Error(`출처 미확인 항목에 원본이 설정되어 있습니다: ${name}`);
      continue;
    }
    if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(skill.repository || '')) {
      throw new Error(`GitHub 원본 주소를 확인하세요: ${name}`);
    }
    if (!/^[a-f0-9]{40}$/.test(skill.ref || '')) throw new Error(`40자리 원본 커밋이 필요합니다: ${name}`);
    if (typeof skill.path !== 'string' || !skill.path || skill.path.split('/').some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '..' || part === '.' || part === '.git')) {
      throw new Error(`잘못된 원본 폴더 경로: ${name}`);
    }
  }
}

export function parseArgs(args) {
  const options = { bundles: [], dest: null, force: false, dryRun: false, list: false, check: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dest') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--dest 다음에 다운로드 폴더를 지정하세요.');
      options.dest = args[++index];
    } else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`알 수 없는 옵션: ${arg}`);
    else options.bundles.push(arg);
  }
  return options;
}

export async function loadBundles(repositoryRoot = root) {
  const packageData = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const bundles = new Map();
  for (const directory of packageData.workspaces) {
    if (!idPattern.test(directory)) throw new Error(`잘못된 묶음 폴더: ${directory}`);
    const filename = path.join(repositoryRoot, directory, 'package.json');
    const data = JSON.parse(await readFile(filename, 'utf8'));
    validateBundle(data.skillBundle, filename);
    bundles.set(directory, { directory: path.join(repositoryRoot, directory), ...data.skillBundle });
  }
  return bundles;
}

// Git이 필요한 폴더의 파일만 가져온다. 원본의 설치 스크립트는 실행하지 않는다.
export async function checkoutSource(repository, ref, paths, destination) {
  await mkdir(destination, { recursive: true });
  await git(destination, 'init', '--quiet');
  await git(destination, 'remote', 'add', 'origin', repository);
  await git(destination, 'fetch', '--quiet', '--depth=1', '--filter=blob:none', 'origin', ref);
  await git(destination, 'sparse-checkout', 'set', '--cone', '--', ...new Set(paths));
  await git(destination, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  const resolved = (await git(destination, 'rev-parse', 'HEAD')).trim();
  if (resolved !== ref) throw new Error(`요청한 원본 커밋과 다릅니다: ${repository}`);
  // Windows에서 Git 링크가 일반 텍스트로 체크아웃되어도 불완전한 스킬을 저장하지 않는다.
  const entries = (await git(destination, 'ls-tree', '-r', '-z', 'HEAD', '--', ...paths)).split('\0');
  if (entries.some(entry => entry.startsWith('120000 ') || entry.startsWith('160000 '))) {
    throw new Error(`원본 폴더에 심볼릭 링크 또는 서브모듈이 있습니다. 별도 처리가 필요합니다: ${repository}`);
  }
}

async function verifyTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === '.git') throw new Error(`지원하지 않는 링크 또는 Git 폴더: ${entry.name}`);
    if (entry.isDirectory()) await verifyTree(path.join(directory, entry.name));
  }
}

export async function downloadSkills({ skills, destination, force = false, log = console.log, checkout = checkoutSource }) {
  const pending = [];
  let skipped = 0;
  let unavailable = 0;
  for (const [name, skill] of skills) {
    if (!idPattern.test(name)) throw new Error(`잘못된 스킬 이름: ${name}`);
    if (skill.status === 'source-needed') {
      log(`보류: ${name} — 원본 주소 확인 필요`);
      unavailable++;
      continue;
    }
    const target = path.join(destination, name);
    if (await exists(target)) {
      const info = await lstat(target);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`다운로드 위치가 일반 폴더가 아닙니다: ${target}`);
      if (!force) { log(`유지: ${name} — 이미 존재합니다. 교체하려면 --force`); skipped++; continue; }
    }
    pending.push([name, skill]);
  }
  if (pending.length === 0) return { downloaded: 0, skipped, unavailable };

  const temp = await mkdtemp(path.join(os.tmpdir(), 'my-skills-source-'));
  let stage;
  const completed = [];
  try {
    const groups = new Map();
    for (const [name, skill] of pending) {
      const key = `${skill.repository}@${skill.ref}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([name, skill]);
    }
    const prepared = [];
    for (const entries of groups.values()) {
      const first = entries[0][1];
      const repositoryDirectory = path.join(temp, String(prepared.length));
      log(`가져오는 중: ${first.repository} (${first.ref.slice(0, 7)})`);
      await checkout(first.repository, first.ref, entries.map(([, skill]) => skill.path), repositoryDirectory);
      for (const [name, skill] of entries) {
        const sourceDirectory = path.join(repositoryDirectory, skill.path);
        const text = await readFile(path.join(sourceDirectory, 'SKILL.md'), 'utf8');
        if (!new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm').test(text)) throw new Error(`SKILL.md의 이름이 일치하지 않습니다: ${name}`);
        await verifyTree(sourceDirectory);
        prepared.push({ name, skill, sourceDirectory });
      }
    }
    // 네트워크/원본 검증을 모두 마친 뒤 목적지에 변경을 시작한다.
    await mkdir(destination, { recursive: true });
    stage = await mkdtemp(path.join(destination, '.my-skills-stage-'));
    for (const { name, skill, sourceDirectory } of prepared) {
      const staged = path.join(stage, name);
      await cp(sourceDirectory, staged, { recursive: true, errorOnExist: true, force: false });
      await writeFile(path.join(staged, '.my-skills-source.json'), JSON.stringify({ repository: skill.repository, ref: skill.ref, path: skill.path }, null, 2) + '\n');
    }
    for (const { name } of prepared) {
      const target = path.join(destination, name);
      const backup = path.join(stage, `${name}.backup`);
      const hasTarget = await exists(target);
      // 가져오는 동안 다른 프로세스가 만든 폴더도 보호한다.
      if (hasTarget && !force) throw new Error(`다운로드 중 같은 이름의 폴더가 생겼습니다: ${target}`);
      if (hasTarget) {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`교체할 수 없는 대상: ${target}`);
        await rename(target, backup);
      }
      const record = { target, backup: hasTarget ? backup : null, installed: false };
      completed.push(record);
      await rename(path.join(stage, name), target);
      record.installed = true;
    }
    for (const { name } of prepared) log(`완료: ${name}`);
    return { downloaded: prepared.length, skipped, unavailable };
  } catch (error) {
    const rollbackErrors = [];
    for (const record of completed.reverse()) {
      try {
        if (record.installed) await rm(record.target, { recursive: true, force: true });
        if (record.backup) await rename(record.backup, record.target);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) {
      // 복구 실패 시 남아 있는 백업을 삭제하지 않는다.
      const recovery = stage;
      stage = null;
      throw new Error(`${error.message}\n복구용 백업 보존: ${recovery}\n${rollbackErrors.join('\n')}`);
    }
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('npm run download -- <묶음...> [--dest 경로] [--dry-run] [--force]\n묶음 폴더에서는 npm run download만 실행하세요.\nnpm run list: 목록 보기 / npm run check: 설정 검사');
    return;
  }
  const bundles = await loadBundles();
  if (options.check) { console.log(`설정 검사 완료: ${bundles.size}개 묶음`); return; }
  const current = [...bundles].find(([, bundle]) => path.resolve(bundle.directory) === path.resolve(process.cwd()));
  const names = options.bundles.length ? [...new Set(options.bundles)] : current ? [current[0]] : [];
  for (const name of names) if (!bundles.has(name)) throw new Error(`알 수 없는 묶음: ${name}. 사용 가능: ${[...bundles.keys()].join(', ')}`);
  if (options.list) {
    for (const name of names.length ? names : bundles.keys()) {
      const bundle = bundles.get(name);
      console.log(`${name} — ${bundle.title}`);
      for (const [id, skill] of Object.entries(bundle.skills)) console.log(`  ${id}${skill.status === 'source-needed' ? ' [원본 주소 확인 필요]' : ''}: ${skill.description}`);
    }
    return;
  }
  if (!names.length) throw new Error('다운로드할 묶음을 지정하세요. 예: npm run download -- frontend (목록: npm run list)');
  const destination = path.resolve(options.dest || 'downloads');
  const skills = new Map();
  for (const name of names) for (const [id, skill] of Object.entries(bundles.get(name).skills)) {
    const previous = skills.get(id);
    if (previous && ['repository', 'ref', 'path'].some(key => previous[key] !== skill[key])) throw new Error(`묶음 사이의 원본이 다릅니다: ${id}`);
    skills.set(id, skill);
  }
  console.log(`다운로드 위치: ${destination}`);
  if (options.dryRun) {
    for (const [name, skill] of skills) console.log(skill.status === 'source-needed' ? `보류: ${name} — 원본 주소 확인 필요` : `${name}: ${skill.repository}/tree/${skill.ref}/${skill.path}`);
    return;
  }
  const result = await downloadSkills({ skills, destination, force: options.force });
  console.log(`다운로드 ${result.downloaded}개 / 기존 폴더 유지 ${result.skipped}개 / 원본 미확인 ${result.unavailable}개`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
