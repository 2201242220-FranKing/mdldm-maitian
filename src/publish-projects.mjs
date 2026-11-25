import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { config } from './feishu.mjs';
import { db, upsertEpisode, setTask, log, saveSnapshot } from './db.mjs';
import { publisherRules, imageExtensions, IMAGE_BYTES, VIDEO_BYTES, IMAGE_LIMIT, fileKind } from './publish-media.mjs';
import { validateProject } from './validate.mjs';

export class PublishInputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const bad = message => { throw new PublishInputError(message); };
const draftPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assetPattern = /^asset-[0-9a-f-]{36}\.(png|jpe?g|webp|mp4)$/;
const locks = new Set();
const types = new Set(['video', 'images']);

function rootDir() {
  if (typeof config.rootPath !== 'string' || !path.isAbsolute(config.rootPath) || !fs.existsSync(config.rootPath)) bad('发布工程根目录不可读，请先挂载或设置有效的 rootPath');
  return fs.realpathSync(config.rootPath);
}
function draftDir(id) {
  if (!draftPattern.test(id)) bad('草稿编号无效');
  const root = rootDir(), d = path.join(root, '.publish-drafts', id);
  if (!fs.existsSync(d) || fs.lstatSync(d).isSymbolicLink() || fs.realpathSync(d) !== d) bad('草稿不存在或已经保存');
  return d;
}
async function locked(id, fn) {
  if (locks.has(id)) throw new PublishInputError('这个草稿正在处理，请稍后重试', 409);
  locks.add(id);
  try { return await fn(); } finally { locks.delete(id); }
}
function readDraft(dir) { return JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf8')); }

export async function createPublishDraft(input) {
  if (!types.has(input?.mediaType)) bad('请选择视频或图文');
  if ((process.env.HUB_DRIVER || config.driver || 'direct') !== 'direct') bad('网页发布需要 direct 驱动，请先切换驱动');
  if ((config.disabled || []).includes('xhs')) bad('小红书已停用，请先在系统中启用');
  await publisherRules();
  const id = crypto.randomUUID(), root = rootDir();
  const parent = path.join(root, '.publish-drafts');
  fs.mkdirSync(parent, { recursive: true });
  if (fs.realpathSync(parent) !== parent) bad('草稿目录不能是符号链接');
  const dir = path.join(parent, id);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({ mediaType: input.mediaType, assets: [] }), { flag: 'wx' });
  return { id };
}

export async function uploadPublishAsset(id, filename, req) {
  return locked(id, async () => {
    const dir = draftDir(id), draft = readDraft(dir);
    if (typeof filename !== 'string' || filename !== path.basename(filename) || filename.length > 180) bad('文件名无效');
    const ext = path.extname(filename).toLowerCase();
    const image = draft.mediaType === 'images', limit = image ? IMAGE_BYTES : VIDEO_BYTES;
    if (image ? !imageExtensions.has(ext) : ext !== '.mp4') bad(image ? '请选择 PNG、JPEG 或 WebP 图片' : '请选择 MP4 视频');
    if (draft.assets.length >= (image ? IMAGE_LIMIT : 1)) bad(image ? `最多 ${IMAGE_LIMIT} 张图片` : '只能选择一个视频');
    const length = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(length) || length <= 0 || length > limit) throw new PublishInputError(image ? '图片不能为空且不得超过20MB' : '视频不能为空且不得超过1GB', 413);
    const asset = `asset-${crypto.randomUUID()}${ext}`, file = path.join(dir, asset);
    let bytes = 0;
    const cap = new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      done(bytes > limit ? new PublishInputError('素材超过大小限制', 413) : null, chunk);
    } });
    try {
      await pipeline(req, cap, fs.createWriteStream(file, { flags: 'wx' }));
      if (bytes !== length) bad('素材上传不完整');
      const kind = fileKind(file);
      if (image ? !['png', 'jpg', 'webp'].includes(kind) : kind !== 'mp4') bad('文件内容与素材类型不符');
      if (image && (kind === 'jpg' ? !/\.jpe?g$/i.test(ext) : ext !== '.' + kind)) bad('图片扩展名与内容不一致');
      draft.assets.push({ file: asset, originalName: filename, bytes });
      fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(draft, null, 2) + '\n');
      return { file: asset, name: filename, bytes };
    } catch (e) {
      // Only remove the partial upload created by this request, never a source file.
      fs.rmSync(file, { force: true });
      throw e;
    }
  });
}

export async function preparePublishProject(id, input) {
  return locked(id, async () => {
    const dir = draftDir(id), draft = readDraft(dir);
    if ((config.disabled || []).includes('xhs')) bad('小红书已停用');
    if (!input || typeof input !== 'object') bad('请求格式不对');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    const topics = input.topics ?? [];
    if (!title || [...title].length > 20) bad('标题需要1–20字');
    if (!body || [...body].length > 1000) bad('正文需要1–1000字');
    if (!Array.isArray(topics) || topics.length > 10 || topics.some(t => typeof t !== 'string' || !t || [...t].length > 30 || /[\s#]/.test(t))) bad('话题格式不对，最多10个，每个最多30字，不含空格或#');
    const assets = input.assets;
    if (!Array.isArray(assets) || !assets.length || assets.length !== draft.assets.length || new Set(assets).size !== assets.length ||
        assets.some(a => typeof a !== 'string' || !assetPattern.test(a) || !draft.assets.some(f => f.file === a))) bad('素材清单不完整或顺序无效');
    if (draft.mediaType === 'video' && assets.length !== 1) bad('视频工程需要一个视频');
    const projectId = `xhs-${draft.mediaType}-${id}`;
    const pj = {
      version: 1, id: projectId, name: title, mediaType: draft.mediaType,
      source: '发布素材.md', source_backup: '发布素材.md',
      video: draft.mediaType === 'video' ? assets[0] : null,
      ...(draft.mediaType === 'images' ? { images: assets } : {}),
      covers: draft.mediaType === 'images' ? { '3x4': assets[0] } : {},
      requiredTags: [],
      platforms: { xhs: { title, body, topics: [...new Set(topics)], covers: draft.mediaType === 'images' ? ['3x4'] : [] } },
    };
    if (input.schedule) {
      if (typeof input.schedule !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(input.schedule)) bad('定时时间格式不对');
      pj.schedule = input.schedule + ':00+08:00';
    }
    if (pj.video) {
      try {
        const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, pj.video)], { timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim());
        if (!Number.isFinite(duration) || duration <= 0) bad('视频时长无效');
        pj.durationSec = Math.round(duration);
      } catch { bad('无法读取MP4视频，请确认文件可播放且已安装ffprobe'); }
    }
    fs.writeFileSync(path.join(dir, 'publish.json'), JSON.stringify(pj, null, 2) + '\n');
    const result = await validateProject(dir);
    if (!result.ok) bad(result.errors.join('；'));
    const md = `# ${title}\n\n> 发布类型：${draft.mediaType === 'images' ? '图文' : '视频'}\n${pj.schedule ? `> 定时发布：${input.schedule.replace('T', ' ')}\n` : ''}\n## 四、小红书\n**标题：**\n${title}\n**正文：**\n${body}\n${topics.map(t => '#' + t).join(' ')}\n`;
    fs.writeFileSync(path.join(dir, '发布素材.md'), md);
    const finalDir = path.join(rootDir(), projectId);
    if (fs.existsSync(finalDir)) throw new PublishInputError('工程已存在，未覆盖', 409);
    fs.renameSync(dir, finalDir);
    db.exec('BEGIN IMMEDIATE');
    try {
      upsertEpisode({ id: projectId, name: title, dir: finalDir, schedule: pj.schedule });
      saveSnapshot(projectId, pj);
      setTask(projectId, 'xhs', 'planned', '等待手动开始填写');
      log(projectId, 'xhs', 'plan', `网页创建${draft.mediaType === 'images' ? '图文' : '视频'}工程`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); fs.renameSync(finalDir, dir); throw e; }
    return { id: projectId, dir: finalDir, mediaType: pj.mediaType, warnings: result.warnings };
  });
}
