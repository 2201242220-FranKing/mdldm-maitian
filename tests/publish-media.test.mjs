import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateMedia, mediaFileErrors, mediaType, relativeMediaPath } from '../src/publish-media.mjs';
import { xhsImageAdapter, withXhsImages, XHS_IMAGE_URL } from '../src/xhs-images.mjs';

const baseValidate = b => ({ errors: [...(!b.video ? ['缺少 video'] : []), ...(!b.platforms.xhs?.title ? ['标题为空'] : [])], warnings: ['保留插件警告'] });
const project = () => ({ version: 1, mediaType: 'images', video: null, images: ['图片/01.png', '图片/02.png'], covers: {}, platforms: { xhs: { title: '标题', body: '正文', topics: [], covers: [] } } });
const files = () => new Set(['图片/01.png', '图片/02.png']);

test('image schema removes only the video requirement and preserves plugin text rules', () => {
  const b = project();
  assert.equal(mediaType({}), 'video');
  assert.deepEqual(validateMedia(b, files(), baseValidate), { errors: [], warnings: ['保留插件警告'] });
  b.platforms.xhs.title = '';
  assert.deepEqual(validateMedia(b, files(), baseValidate).errors, ['标题为空']);
  delete b.mediaType;
  assert(validateMedia(b, files(), baseValidate).errors.includes('缺少 video'));
});

test('invalid media, archive execution, unsupported platforms, missing/duplicate images are blocked', () => {
  for (const [modify, expected] of [
    [b => { b.mediaType = 'text'; }, /mediaType/],
    [b => { b.images = []; }, /1–18/],
    [b => { b.images = Array(19).fill('图片/01.png'); }, /1–18/],
    [b => { b.images.push('图片/01.png'); }, /不能重复/],
    [b => { b.images.push('图片/03.png'); }, /找不到图片/],
    [b => { b.images.push('../private.png'); }, /路径/],
    [b => { b.images.push('/tmp/private.png'); }, /路径/],
    [b => { b.images.push('图片/a.svg'); }, /格式/],
    [b => { b.platforms.youtube = { title: '不能发图文' }; }, /暂未接入图文/],
    [b => { b.platforms.xhs.video = 'video.mp4'; }, /不能指定视频/],
    [b => { b.video = 'video.mp4'; }, /同时指定 video/],
    [b => { b.archive = { mode: 'archive_only' }; }, /存档不能执行/],
    [b => { b.platforms.xhs.skip = '已发'; }, /没有可发布的平台/],
  ]) {
    const b = project(); modify(b);
    assert.match(validateMedia(b, files(), baseValidate).errors.join(';'), expected);
  }
  const b = project(); b.platforms.youtube = { skip: '本次不发' };
  assert.deepEqual(validateMedia(b, files(), baseValidate).errors, []);
  for (const value of ['../a', 'a/../../b', '/a', 'a\\b', 'a//b', './a', 'a\0b']) assert.equal(relativeMediaPath(value), false);
  for (const value of [null, [], 'text']) assert(validateMedia(value, files(), baseValidate).errors.length);
});

test('media file checks reject symlink escape, empty and disguised images', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'); fs.mkdirSync(dir);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVkAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(path.join(dir, 'ok.png'), png);
  fs.writeFileSync(path.join(dir, 'empty.png'), '');
  fs.writeFileSync(path.join(dir, 'not-image.png'), 'private data');
  fs.writeFileSync(path.join(root, 'outside.png'), png);
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(dir, 'escape.png'));
  assert.deepEqual(mediaFileErrors({ mediaType: 'images', images: ['ok.png'] }, dir), []);
  assert.match(mediaFileErrors({ mediaType: 'images', images: ['empty.png', 'not-image.png', 'escape.png'] }, dir).join(';'), /为空.*不是有效.*之外/);
  assert.deepEqual(mediaFileErrors(null, dir), []);
  const large = path.join(dir, 'large.mp4');
  fs.writeFileSync(large, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
  fs.truncateSync(large, 1024 * 1024 * 1024 + 1);
  assert.deepEqual(mediaFileErrors({ video: 'large.mp4' }, dir), [], 'existing video projects retain their previous size range');
});

function adapterFixture({ count = 2, existing = false, body = '正文', picked = ['主题'] } = {}) {
  const calls = [];
  const cdp = Object.fromEntries(['setFiles', 'setValue', 'focusEnd', 'typeLines', 'pressKey', 'sleep', 'click', 'fire', 'insertText'].map(k => [k, async (...args) => { calls.push([k, ...args]); }]));
  cdp.byText = text => text;
  cdp.waitFor = async () => true;
  cdp.evaluate = async (id, expression) => {
    calls.push(['evaluate', expression]);
    if (expression.includes('||')) return existing;
    if (expression.endsWith('.innerText')) return body;
    if (expression.endsWith('.length')) return count;
    return true;
  };
  const common = { checkTitle: async () => {}, pickTopics: async () => picked };
  const ctx = { tabId: 1, p: { title: '标题', body: '正文', topics: ['主题'] }, log() {}, note() {}, fail() {} };
  return { calls, ctx, cdp, common, adapter: xhsImageAdapter({ id: 'xhs', links: { url: 'read-only' }, uploadDone: 'video-only', afterUpload() {} }, cdp, common, ['/first.png', '/second.png']) };
}

test('image adapter uploads ordered images and fills without video cover steps or publishing', async () => {
  const { adapter, ctx, calls } = adapterFixture();
  assert.equal(adapter.url, XHS_IMAGE_URL);
  assert.equal(adapter.uploadDone, undefined); assert.equal(adapter.afterUpload, undefined);
  await adapter.fill(ctx);
  assert.deepEqual(calls.find(c => c[0] === 'setFiles')[3], ['/first.png', '/second.png']);
  assert.equal(calls.filter(c => c[0] === 'setFiles').length, 1);
  assert(!calls.filter(c => c[0] === 'click').some(c => /发布|提交/.test(c[2])));
});

test('image adapter refuses existing draft, body mismatch, missing images and missing topics', async () => {
  for (const [input, message] of [[{ existing: true }, /已有草稿/], [{ body: '错误' }, /回读不一致/], [{ count: 1 }, /数量未核实/], [{ picked: [] }, /话题只识别/]]) {
    const fixture = adapterFixture(input);
    await assert.rejects(fixture.adapter.fill(fixture.ctx), message);
    if (input.existing) assert(!fixture.calls.some(c => c[0] === 'setFiles'));
  }
});

test('driver adapter override restores the store adapter even on failure', async () => {
  const old = { id: 'xhs' }, f = adapterFixture();
  const lib = { pub: { ADAPTERS: { xhs: old } }, cdp: f.cdp, common: f.common };
  await assert.rejects(withXhsImages(lib, { dir: 'project', data: { images: ['01.png'] } }, '/tmp', async () => {
    assert.equal(lib.pub.ADAPTERS.xhs.url, XHS_IMAGE_URL);
    throw new Error('test failure');
  }), /test failure/);
  assert.equal(lib.pub.ADAPTERS.xhs, old);
});
