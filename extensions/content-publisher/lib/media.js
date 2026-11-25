// 本地开发版：图文工程规则，保留原插件的视频文案校验。
import { validate } from './bundle.js';

export const imageFile = name => /\.(png|jpe?g|webp)$/i.test(name);
export const relativePath = p => typeof p === 'string' && !!p && !p.startsWith('/') &&
  !p.includes('\\') && !p.includes('\0') && p.split('/').every(s => s && s !== '.' && s !== '..');

export function mediaType(b) {
  if (b?.archive?.mode === 'archive_only') return 'archive';
  if (['video', 'images', 'article'].includes(b?.mediaType)) return b.mediaType;
  if (b?.mediaType) return 'unknown';
  if (relativePath(b?.video)) return 'video';
  if (b?.platforms?.x?.mode === 'article' || b?.archive?.format === 'Article') return 'article';
  if (b?.platforms?.xhs && Array.isArray(b.images) && b.images.length) return 'images';
  return 'unknown';
}

export function projectKind(project) {
  if (project.error) return 'invalid';
  return mediaType(project.draft ? project : project.data);
}

export function platformPublication(data, id) {
  const p = data?.platforms?.[id];
  const channel = String(data?.archive?.channel || '').toLowerCase();
  const recordedId = channel === 'twitter' ? 'x' : channel;
  if (data?.archive?.stage === 'published' && recordedId === id) return 'published';
  if (typeof p?.skip === 'string' && /^已(?:于.*?)?发布|^已发(?:[；;，,\s]|$)/.test(p.skip)) return 'published';
  if (p?.skip) return 'skipped';
  return p ? 'prepared' : 'unrecorded';
}

export function validateProjectData(b, files = null) {
  const errors = [], warnings = [];
  const type = mediaType(b);
  if (type === 'archive') return { errors: ['已发布存档不能再次执行发布'], warnings };
  if (!b || typeof b !== 'object' || Array.isArray(b) || !b.platforms || typeof b.platforms !== 'object' ||
    Array.isArray(b.platforms) || Object.values(b.platforms).some(p => !p || typeof p !== 'object' || Array.isArray(p))) {
    return { errors: ['工程或 platforms 格式不对'], warnings };
  }
  if (type === 'article') return { errors: ['请在 X 长文编辑页处理长文'], warnings };
  if (type === 'unknown') return { errors: ['未识别发布类型，请检查 video 或 images'], warnings };
  const image = type === 'images';
  try {
    const base = validate(b, files);
    errors.push(...base.errors.filter(e => !(image && e === '缺少 video')));
    warnings.push(...base.warnings);
  } catch { errors.push('平台文案字段格式不对'); }
  if (!Object.values(b.platforms).some(p => !p.skip)) errors.push('没有可填写的平台');
  const refs = [b.video, b.subtitle, ...Object.values(b.covers || {}), ...Object.values(b.platforms).map(p => p.video)].filter(Boolean);
  if (image) {
    if (b.video) errors.push('图文不能同时指定视频');
    if (!Array.isArray(b.images) || !b.images.length || b.images.length > 18) errors.push('图文需要1–18张图片');
    if (Array.isArray(b.images)) {
      if (new Set(b.images).size !== b.images.length) errors.push('图片不能重复');
      for (const p of b.images) {
        refs.push(p);
        if (!imageFile(String(p))) errors.push(`图片格式不支持：${p}`);
        if (files && !files.has(p)) errors.push(`找不到图片：${p}`);
      }
    }
    for (const [id, p] of Object.entries(b.platforms)) {
      if (!p.skip && id !== 'xhs') errors.push(`${id} 暂不支持图文，请跳过`);
      if (!p.skip && (p.video || p.mode)) errors.push('图文不能使用视频或长文模式');
    }
  } else if (b.images?.length) errors.push('视频工程不能同时指定图文图片');
  for (const p of refs) if (!relativePath(p)) errors.push(`素材必须在工程目录内：${String(p)}`);
  return { errors, warnings };
}

export async function fileHandleAt(dir, ref) {
  if (!relativePath(ref)) throw new Error('素材路径无效');
  const parts = ref.split('/');
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts.at(-1));
}

export async function checkImages(project) {
  const errors = [];
  for (const ref of Array.isArray(project.data.images) ? project.data.images : []) {
    try {
      const file = await (await fileHandleAt(project.handle, ref)).getFile();
      if (!file.size || file.size > 20 * 1024 * 1024) { errors.push(`${ref} 为空或超过20MB`); continue; }
      const h = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const ascii = (a, b) => String.fromCharCode(...h.slice(a, b));
      const png = [137,80,78,71,13,10,26,10].every((x, i) => h[i] === x);
      const jpeg = h[0] === 255 && h[1] === 216 && h[2] === 255;
      const webp = ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
      if (!(png && /\.png$/i.test(ref) || jpeg && /\.jpe?g$/i.test(ref) || webp && /\.webp$/i.test(ref))) errors.push(`${ref} 图片内容或扩展名不对`);
    } catch { errors.push(`无法读取图片：${String(ref)}`); }
  }
  return errors;
}

export function resolveProjectPath(root, dir, ref) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0') || root.includes('\\') ||
      root.split('/').some(s => s === '..' || s === '.') || (dir !== '' && !relativePath(dir)) || !relativePath(ref)) throw new Error('本机路径或素材路径无效');
  return root.replace(/\/+$/, '') + '/' + (dir ? dir + '/' : '') + ref;
}
