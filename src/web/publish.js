let composer = { mediaType: 'video', title: '', body: '', topics: '', schedule: '', files: [], saving: false };

function capturePublishDraft() {
  const form = document.querySelector('#publish-form');
  if (!form || form.dataset.saved === 'true') return;
  for (const key of ['title', 'body', 'topics', 'schedule']) composer[key] = form.elements[key].value;
}
function publishFilesHTML() {
  return composer.files.map((item, i) => `<li class="publish-file">
    ${composer.mediaType === 'images' ? `<img src="${esc(item.url)}" alt="第${i + 1}张图片">` : `<video src="${esc(item.url)}" controls preload="metadata"></video>`}
    <div class="publish-file-name"><b>${i + 1}. ${esc(item.file.name)}</b><span>${(item.file.size / 1024 / 1024).toFixed(1)} MB</span></div>
    <div class="publish-file-actions">${composer.mediaType === 'images' ? `<button type="button" class="btn" data-media-move="${i}" data-direction="-1" title="向前移动" aria-label="第${i + 1}张向前移动" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="btn" data-media-move="${i}" data-direction="1" title="向后移动" aria-label="第${i + 1}张向后移动" ${i === composer.files.length - 1 ? 'disabled' : ''}>↓</button>` : ''}<button type="button" class="btn" data-media-remove="${i}" title="移除素材" aria-label="移除第${i + 1}个素材">×</button></div>
  </li>`).join('');
}
function vPublish() {
  const image = composer.mediaType === 'images';
  const platform = O.health.platforms.find(p => p.id === 'xhs');
  const unavailable = platform?.disabled || O.driver === 'plugin';
  return `<header class="publish-heading"><div><div class="h1">小红书发布</div><span class="publish-platform">${logo('xhs')}小红书</span></div><a class="btn" href="#/calendar">发布计划</a></header>
  ${unavailable ? `<p class="publish-error" role="status">${platform?.disabled ? '小红书已停用，请在系统中启用。' : '网页发布需要 direct 驱动。'}</p>` : ''}
  <form id="publish-form" class="publish-form"><fieldset ${composer.saving || unavailable ? 'disabled' : ''}>
    <div class="publish-type" role="radiogroup" aria-label="发布类型">
      <label><input type="radio" name="mediaType" value="video" ${!image ? 'checked' : ''}><span>视频</span></label>
      <label><input type="radio" name="mediaType" value="images" ${image ? 'checked' : ''}><span>图文</span></label>
    </div>
    <div class="publish-layout"><section class="publish-assets" aria-label="发布素材">
      <div class="publish-section-title"><h2>${image ? '图片' : '视频'}</h2><span>${image ? `${composer.files.length} / 18 张` : 'MP4 · 最大1GB'}</span></div>
      <label class="publish-picker"><input id="publish-files" type="file" accept="${image ? 'image/png,image/jpeg,image/webp' : 'video/mp4'}" ${image ? 'multiple' : ''}><span>${image ? '选择图片' : '选择视频'}</span></label>
      <ol class="publish-files" id="publish-file-list">${publishFilesHTML()}</ol>
    </section><section class="publish-copy" aria-label="发布文案">
      <label for="publish-title">标题</label><input id="publish-title" name="title" value="${esc(composer.title)}" maxlength="40" required>
      <label for="publish-body">正文</label><textarea id="publish-body" name="body" rows="10" maxlength="2000" required>${esc(composer.body)}</textarea>
      <label for="publish-topics">话题</label><input id="publish-topics" name="topics" value="${esc(composer.topics)}" placeholder="#主题 #话题">
      <label for="publish-schedule">定时（北京时间，可留空）</label><input id="publish-schedule" name="schedule" type="datetime-local" value="${esc(composer.schedule)}">
    </section></div>
    <footer class="publish-footer"><span id="publish-status" role="status" aria-live="polite"></span><button class="btn pri" type="submit">${composer.saving ? '保存中…' : '保存到发布计划'}</button></footer>
  </fieldset></form>`;
}

function clearPublishFiles() {
  composer.files.forEach(f => URL.revokeObjectURL(f.url));
  composer.files = [];
}
document.addEventListener('input', e => {
  if (e.target.closest?.('#publish-form')) capturePublishDraft();
});
document.addEventListener('change', async e => {
  if (!e.target.closest?.('#publish-form') || composer.saving) return;
  capturePublishDraft();
  if (e.target.name === 'mediaType') {
    if (composer.files.length && !confirm('切换类型会清空当前选择的素材，文案保留。继续？')) {
      e.target.form.elements.mediaType.value = composer.mediaType; return;
    }
    clearPublishFiles(); composer.mediaType = e.target.value; await render(); return;
  }
  if (e.target.id !== 'publish-files') return;
  const selected = [...e.target.files], image = composer.mediaType === 'images';
  const limit = image ? 18 : 1;
  if (selected.length + (image ? composer.files.length : 0) > limit) { toast(`最多选择${limit}${image ? '张图片' : '个视频'}`); e.target.value = ''; return; }
  for (const file of selected) {
    if (!(image ? /\.(png|jpe?g|webp)$/i : /\.mp4$/i).test(file.name)) { toast(image ? '请选择PNG、JPEG或WebP图片' : '请选择MP4视频'); return; }
    if (!file.size || file.size > (image ? 20 : 1024) * 1024 * 1024) { toast(image ? '单张图片最大20MB，不能为空' : '视频最大1GB，不能为空'); return; }
  }
  if (!image) clearPublishFiles();
  for (const file of selected) {
    if (composer.files.some(f => f.file.name === file.name && f.file.size === file.size && f.file.lastModified === file.lastModified)) continue;
    composer.files.push({ file, url: URL.createObjectURL(file) });
  }
  await render();
});
document.addEventListener('click', async e => {
  if (composer.saving) return;
  const remove = e.target.closest('[data-media-remove]'), move = e.target.closest('[data-media-move]');
  if (!remove && !move) return;
  capturePublishDraft();
  if (remove) {
    const i = Number(remove.dataset.mediaRemove);
    URL.revokeObjectURL(composer.files[i].url); composer.files.splice(i, 1);
  } else {
    const i = Number(move.dataset.mediaMove), j = i + Number(move.dataset.direction);
    if (j >= 0 && j < composer.files.length) [composer.files[i], composer.files[j]] = [composer.files[j], composer.files[i]];
  }
  await render();
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'publish-form') return;
  e.preventDefault();
  if (composer.saving) return;
  capturePublishDraft();
  const form = e.target, status = form.querySelector('#publish-status');
  if (!composer.files.length) { status.textContent = '请先选择素材'; return; }
  if ([...composer.title.trim()].length > 20 || [...composer.body.trim()].length > 1000) { status.textContent = '标题最多20字，正文最多1000字'; return; }
  composer.saving = true;
  form.querySelector('fieldset').disabled = true;
  const post = async (url, body, binary = false) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? body : JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || '保存失败');
    return result;
  };
  try {
    const draft = await post('/api/publish-drafts', { mediaType: composer.mediaType });
    const assets = [];
    for (const [i, { file }] of composer.files.entries()) {
      status.textContent = `正在保存素材 ${i + 1}/${composer.files.length}`;
      const item = await post(`/api/publish-drafts/${draft.id}/assets?name=${encodeURIComponent(file.name)}`, file, true);
      assets.push(item.file);
    }
    status.textContent = '正在校验工程';
    const topics = composer.topics.split(/[\s,，]+/).map(t => t.replace(/^#/, '')).filter(Boolean);
    const result = await post(`/api/publish-drafts/${draft.id}/prepare`, { title: composer.title, body: composer.body, topics, schedule: composer.schedule, assets });
    clearPublishFiles();
    form.dataset.saved = 'true';
    composer = { mediaType: composer.mediaType, title: '', body: '', topics: '', schedule: '', files: [], saving: false };
    toast('已保存到计划，尚未上传到小红书');
    location.hash = '#/ep/' + encodeURIComponent(result.id);
    await load();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    composer.saving = false;
    if (form.isConnected) form.querySelector('fieldset').disabled = false;
  }
});
addEventListener('beforeunload', e => {
  if (composer.files.length || composer.saving) { e.preventDefault(); e.returnValue = ''; }
});
