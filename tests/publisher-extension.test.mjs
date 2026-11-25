import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateProjectData, checkImages, resolveProjectPath, projectKind, platformPublication } from '../extensions/content-publisher/lib/media.js';

globalThis.chrome = { debugger: { onDetach: { addListener() {} } } };
const { scanProjects, check, run } = await import('../extensions/content-publisher/lib/publish.js');
const root = new URL('../extensions/content-publisher/', import.meta.url);
const png = fs.readFileSync(new URL('../src/web/icon-180.png', import.meta.url));
function file(name, content) {
  return { kind: 'file', name, getFile: async () => ({
    name, size: content.length, lastModified: 123, text: async () => String(content),
    slice: (a, b) => new Blob([content.subarray(a, b)]),
  }) };
}
function directory(name, entries) {
  return { kind: 'directory', name, async *entries() { yield* Object.entries(entries); },
    async getFileHandle(n) { if (!entries[n]) throw Error('missing'); return entries[n]; },
    async getDirectoryHandle(n) { if (!entries[n]) throw Error('missing'); return entries[n]; } };
}
const project = () => ({ version: 1, id: 'image-test', name: '测试', mediaType: 'images', video: null,
  images: ['图片/01.png', '图片/02.png'], covers: {}, requiredTags: [],
  platforms: { xhs: { title: '测试标题', body: '本地测试正文', topics: [], covers: [] } } });

test('local extension has a separate identity and exposes video, images and X article', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root)));
  assert(!manifest.key); assert(!manifest.update_url);
  assert.equal(manifest.version, '0.5.4');
  assert.match(manifest.name, /内容工作台/);
  const html = fs.readFileSync(new URL('sidepanel.html', root), 'utf8');
  for (const view of ['video', 'images', 'article']) assert(html.includes(`data-view="${view}"`));
  assert(!fs.existsSync(new URL('_metadata', root)));
});

test('publication state belongs to the recorded platform, not the whole archived topic', () => {
  const b = { archive: { mode: 'archive_only', channel: 'X', stage: 'published' },
    platforms: { x: { skip: '已于2026-10-27发布；仅存档' }, douyin: { skip: '暂不发布' } } };
  assert.equal(platformPublication(b, 'x'), 'published');
  assert.equal(platformPublication(b, 'xhs'), 'unrecorded');
  assert.equal(platformPublication(b, 'douyin'), 'skipped');
  assert.equal(platformPublication({ ...b, platforms: { ...b.platforms, xhs: project().platforms.xhs } }, 'xhs'), 'prepared');
  assert.equal(platformPublication({ archive: { mode: 'archive_only' }, platforms: {} }, 'x'), 'unrecorded');
  assert.equal(platformPublication({ platforms: { x: { skip: '未发布' } } }, 'x'), 'skipped');
  assert.equal(platformPublication({ platforms: { x: { skip: '已于2026-10-27发布；仅存档' } } }, 'x'), 'published');
  assert.match(validateProjectData(b).errors.join(''), /存档/);
});

test('extension image validation accepts image plans, preserves video rules and blocks archives or unsupported targets', () => {
  const b = project(), files = new Set(b.images);
  assert.deepEqual(validateProjectData(b, files).errors, []);
  assert(validateProjectData({ ...b, mediaType: 'video', images: [] }, files).errors.includes('缺少 video'));
  for (const [change, message] of [
    [b => { b.images = []; }, /1–18/],
    [b => { b.images = ['../secret.png']; }, /工程目录内/],
    [b => { b.platforms.douyin = { title: '测试' }; }, /暂不支持图文/],
    [b => { b.archive = { mode: 'archive_only' }; }, /存档/],
    [b => { b.platforms.xhs.skip = '已发'; }, /没有可填写/],
    [b => { b.images = [b.images[0], b.images[0]]; }, /不能重复/],
  ]) { const data = project(); change(data); assert.match(validateProjectData(data, files).errors.join(';'), message); }
  for (const invalid of [null, [], { platforms: { xhs: null } }]) assert(validateProjectData(invalid).errors.length);
  assert.equal(resolveProjectPath('/tmp/root/', '', '图片/01.png'), '/tmp/root/图片/01.png');
  assert.equal(resolveProjectPath('/tmp/root', '本期', '图片/01.png'), '/tmp/root/本期/图片/01.png');
  for (const args of [['/tmp', '../secret', '01.png'], ['/tmp', '', '/secret.png'], ['/tmp/../private', '', '01.png']]) assert.throws(() => resolveProjectPath(...args));
});

test('extension scanner finds ordered image drafts and JSON while retaining existing video drafts', async () => {
  const data = project();
  const images = directory('图片', { '10.png': file('10.png', png), '2.png': file('2.png', png), '1.png': file('1.png', png) });
  const root = directory('root', {
    draft: directory('draft', { 图片: images }),
    video: directory('video', { '成片.mp4': file('成片.mp4', Buffer.from('video')) }),
    ready: directory('ready', { 'publish.json': file('publish.json', Buffer.from(JSON.stringify(data))), 图片: directory('图片', { '01.png': file('01.png', png), '02.png': file('02.png', png) }) }),
    '.publish-drafts': directory('hidden', { 'publish.json': file('publish.json', Buffer.from('{}')) }),
  });
  const projects = await scanProjects(root);
  assert.equal(projects.length, 3);
  assert.deepEqual(projects.filter(p => projectKind(p) === 'images').map(p => p.dir).sort(), ['draft', 'ready']);
  assert.deepEqual(projects.filter(p => projectKind(p) === 'video').map(p => p.dir), ['video']);
  assert.deepEqual(projects.find(p => p.dir === 'draft').images, ['图片/1.png', '图片/2.png', '图片/10.png']);
  assert.equal(projects.find(p => p.dir === 'video').video, '成片.mp4');
  assert.deepEqual((await check(projects.find(p => p.dir === 'ready'))).errors, []);
  assert.equal((await scanProjects(directory('direct', { '1.png': file('1.png', png) })))[0].dir, '');
});

test('published X archives, X articles and packages without media stay out of the media lists', async () => {
  const asJson = data => directory('project', { 'publish.json': file('publish.json', Buffer.from(JSON.stringify(data))) });
  const legacyImage = project();
  delete legacyImage.mediaType;
  const root = directory('root', {
    archive: asJson({ video: null, archive: { mode: 'archive_only', format: 'Article' }, platforms: { x: { skip: '已发' } } }),
    archiveWithVideo: asJson({ video: 'old.mp4', mediaType: 'video', archive: { mode: 'archive_only' } }),
    article: asJson({ images: ['cover.png'], platforms: { x: { mode: 'article' } } }),
    empty: asJson({ video: null, platforms: { xhs: {} } }),
    legacyImage: asJson(legacyImage),
    legacyVideo: asJson({ video: 'final.mp4', platforms: { x: { mode: 'article+quote' } } }),
  });
  const projects = await scanProjects(root);
  assert.deepEqual(Object.fromEntries(projects.map(p => [p.dir, projectKind(p)])), {
    archive: 'archive', archiveWithVideo: 'archive', article: 'article', empty: 'unknown',
    legacyImage: 'images', legacyVideo: 'video',
  });
  assert.deepEqual(validateProjectData(legacyImage, new Set(legacyImage.images)).errors, []);
  assert.deepEqual(validateProjectData(projects.find(p => p.dir === 'archive').data).errors, ['已发布存档不能再次执行发布']);
});

test('extension verifies image bytes and blocks invalid plans before touching Chrome', async () => {
  const b = project(); b.images = ['fake.png', 'empty.png', 'missing.png'];
  const errors = await checkImages({ data: b, handle: directory('bad', {
    'fake.png': file('fake.png', Buffer.from('not png')), 'empty.png': file('empty.png', Buffer.alloc(0)),
  }) });
  assert.equal(errors.length, 3);
  await assert.rejects(run({ dir: '', data: { ...project(), archive: { mode: 'archive_only' } } }, { platforms: ['xhs'], rootPath: '/tmp' }), /存档/);
});

test('extension background engine routes ordered images to image upload without mutating the video adapter or submitting', async () => {
  const { ADAPTERS } = await import('../extensions/content-publisher/lib/publish.js');
  const old = globalThis.chrome, urls = [], uploads = [], commands = [];
  const b = project(), videoAdapter = ADAPTERS.xhs;
  globalThis.chrome = {
    tabs: {
      async create({ url }) { urls.push(url); return { id: 987, url }; },
      async get() { return { id: 987, url: urls.at(-1) }; },
    },
    debugger: {
      async attach() {},
      async sendCommand(_target, method, params) {
        commands.push({ method, params });
        if (method === 'DOM.setFileInputFiles') { uploads.push(params.files); return {}; }
        if (method !== 'Runtime.evaluate') return {};
        if (!params.returnByValue) return { result: { objectId: 'image-upload-input' } };
        const e = params.expression;
        let value = true;
        if (e.includes('扫码登录') || e.includes('?.value?.trim()')) value = false;
        else if (e.startsWith('(()=>{const e=') && e.includes('getBoundingClientRect')) value = null;
        else if (e.endsWith('.innerText')) value = b.platforms.xhs.body;
        else if (e.endsWith('.length')) value = b.images.length;
        else if (e.endsWith('.value')) value = b.platforms.xhs.title;
        return { result: { value } };
      },
    },
  };
  try {
    const states = await run({ dir: '本期', data: b }, { rootPath: '/test/root', platforms: ['xhs'], shouldStop: () => false, onChange() {} });
    assert.equal(states.xhs.status, '已填写');
    assert.match(urls[0], /target=image/);
    assert.deepEqual(uploads, [['/test/root/本期/图片/01.png', '/test/root/本期/图片/02.png']]);
    assert.equal(ADAPTERS.xhs, videoAdapter);
    assert.match(ADAPTERS.xhs.url, /target=video/);
    assert(!commands.some(c => c.method === 'Input.dispatchMouseEvent'));
  } finally { globalThis.chrome = old; }
});
