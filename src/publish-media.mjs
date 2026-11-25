import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginDir } from './plugin.mjs';

export const IMAGE_LIMIT = 18;
export const IMAGE_BYTES = 20 * 1024 * 1024;
export const VIDEO_BYTES = 1024 * 1024 * 1024;
export const mediaType = b => b.mediaType || 'video';
export const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export async function publisherRules() {
  return import(pathToFileURL(path.join(pluginDir(), 'lib', 'bundle.js')).href);
}

export function relativeMediaPath(p) {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) &&
    !p.includes('\\') && !p.includes('\0') && !p.split('/').some(s => s === '..' || s === '.' || !s);
}

// Keep the installed plugin's text rules; only replace its video-only requirement.
export function validateMedia(b, files, baseValidate) {
  const errors = [], warnings = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { errors: ['工程必须是 JSON 对象'], warnings };
  if (!b.platforms || typeof b.platforms !== 'object' || Array.isArray(b.platforms) ||
      Object.values(b.platforms).some(p => !p || typeof p !== 'object' || Array.isArray(p))) {
    return { errors: ['platforms 格式不对'], warnings };
  }
  if (!['video', 'images'].includes(mediaType(b))) errors.push('mediaType 只能是 video 或 images');
  const image = mediaType(b) === 'images';
  try {
    const base = baseValidate(b, files);
    errors.push(...base.errors.filter(e => !(image && e === '缺少 video')));
    warnings.push(...base.warnings);
  } catch {
    errors.push('平台文案字段格式不对，请检查标题、正文和话题');
  }
  if (!Object.entries(b.platforms).some(([, p]) => !p.skip)) errors.push('没有可发布的平台');
  if (b.archive?.mode === 'archive_only') errors.push('已发布存档不能执行发布');
  if (image) {
    if (b.video) errors.push('图文工程不能同时指定 video');
    const images = b.images;
    if (!Array.isArray(images) || !images.length || images.length > IMAGE_LIMIT) errors.push(`图文需要 1–${IMAGE_LIMIT} 张图片`);
    if (Array.isArray(images)) {
      if (new Set(images).size !== images.length) errors.push('图文图片不能重复');
      for (const p of images) {
        if (!relativeMediaPath(p) || !imageExtensions.has(path.extname(String(p)).toLowerCase())) errors.push(`图片路径或格式不支持：${String(p)}`);
        else if (files && !files.has(p)) errors.push(`找不到图片：${p}`);
      }
    }
    for (const [id, p] of Object.entries(b.platforms)) {
      if (!p.skip && id !== 'xhs') errors.push(`${id} 暂未接入图文发布，请跳过或改用视频`);
      if (!p.skip && (p.video || p.mode)) errors.push(`${id} 图文工程不能指定视频或长文模式`);
    }
  } else if (b.images?.length) errors.push('视频工程不能同时指定 images，请明确选择发布类型');
  for (const p of [b.video, b.subtitle, ...Object.values(b.covers || {}), ...Object.values(b.platforms).map(p => p.video)].filter(Boolean)) {
    if (!relativeMediaPath(p)) errors.push(`素材路径必须在工程目录内：${String(p)}`);
  }
  return { errors, warnings };
}

export function fileKind(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (head[0] === 255 && head[1] === 216 && head[2] === 255) return 'jpg';
  if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (head.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return null;
}

export function mediaFileErrors(b, dir) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return errors;
  const image = mediaType(b) === 'images';
  const refs = image && Array.isArray(b.images) ? b.images : [b.video].filter(Boolean);
  const root = fs.realpathSync(dir);
  for (const ref of refs) {
    if (!relativeMediaPath(ref)) continue;
    const file = path.resolve(dir, ref);
    try {
      const actual = fs.realpathSync(file);
      if (!actual.startsWith(root + path.sep)) { errors.push(`素材不能指向工程目录之外：${ref}`); continue; }
      const stat = fs.statSync(actual);
      if (!stat.isFile() || !stat.size) { errors.push(`素材为空或不是文件：${ref}`); continue; }
      if (image && stat.size > IMAGE_BYTES) errors.push(`${ref} 超过本工具图片大小限制（20MB）`);
      const kind = fileKind(actual);
      if (image ? !['png', 'jpg', 'webp'].includes(kind) : kind !== 'mp4') errors.push(`素材内容不是有效的${image ? 'PNG/JPEG/WebP 图片' : 'MP4 视频'}：${ref}`);
      if (image && kind && (kind === 'jpg' ? !/\.jpe?g$/i.test(ref) : !ref.toLowerCase().endsWith('.' + kind))) errors.push(`图片扩展名与内容不一致：${ref}`);
    } catch { errors.push(`无法读取素材：${ref}`); }
  }
  return errors;
}
