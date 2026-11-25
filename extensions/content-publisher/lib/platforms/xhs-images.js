// 本地开发版新增：小红书图文，只填写，不提交。

export const XHS_IMAGE_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image';
const TITLE = `document.querySelector('input[placeholder="填写标题会有更多赞哦"]')`;
const EDITOR = `document.querySelector('.tiptap.ProseMirror')`;
const IMAGE_INPUT = `[...document.querySelectorAll('input[type=file]')].find(i => /image|\\.png|\\.jpe?g|\\.webp/i.test(i.accept) && !/video/i.test(i.accept))`;
const IMAGE_ITEMS = `document.querySelectorAll('.img-preview-area .img-preview, .img-preview-list .img-preview, .image-item, .upload-item, .img-list .img-item')`;

// The video adapter remains untouched. This adapter never clicks publish.
export function xhsImageAdapter(base, cdp, common, images) {
  const { evaluate, setFiles, waitFor, setValue, focusEnd, typeLines, pressKey, sleep, click, byText, fire, insertText } = cdp;
  return {
    ...base,
    url: XHS_IMAGE_URL,
    ready: `!!(${IMAGE_INPUT})`,
    uploadDone: undefined,
    afterUpload: undefined,
    async fill(ctx) {
      const T = ctx.tabId, { p } = ctx;
      if (!await waitFor(T, `!!(${IMAGE_INPUT})`, 10000)) throw new Error('没有找到图文上传入口，请在小红书选择“上传图文”后重试');
      if (await evaluate(T, `!!${TITLE}?.value?.trim() || !!${EDITOR}?.innerText?.trim() || ${IMAGE_ITEMS}.length > 0`)) throw new Error('图文页面已有草稿内容，未再次上传，请先人工核对');
      await setFiles(T, IMAGE_INPUT, images);
      ctx.log(`开始上传 ${images.length} 张图片（按工程顺序）`);
      if (!await waitFor(T, `!!${TITLE} && !!${EDITOR} && !/上传中|上传失败|重新上传/.test(document.body.innerText)`, 120000, 1000)) {
        throw new Error('图片未上传完成或编辑器未出现，请人工检查，勿直接重传');
      }
      await click(T, byText('我知道了'));
      await setValue(T, TITLE, p.title);
      await common.checkTitle(ctx, `${TITLE}.value`, p.title);
      await focusEnd(T, EDITOR);
      await typeLines(T, p.body);
      if (p.topics?.length) {
        await pressKey(T, 'Enter'); await pressKey(T, 'Enter');
        const picked = await common.pickTopics(ctx, p.topics, `[...document.querySelectorAll('.item')]`);
        if (picked.length !== p.topics.length) throw new Error(`话题只识别了 ${picked.length}/${p.topics.length} 个，请人工补齐`);
      }
      const got = await evaluate(T, `${EDITOR}.innerText`);
      const normalize = s => String(s || '').replace(/\s/g, '');
      if (!normalize(got).includes(normalize(p.body))) throw new Error('图文正文回读不一致，请人工核对');
      const count = await evaluate(T, `${IMAGE_ITEMS}.length`);
      if (count !== images.length) throw new Error(`图片数量未核实：页面 ${count} 张，工程 ${images.length} 张，请人工检查顺序和完整性`);
      if (ctx.schedule) {
        const sw = `document.querySelector('.post-time-switch-container .d-switch-simulator')`;
        const input = `document.querySelector('.post-time-wrapper .d-datepicker-input-filter input')`;
        if (!await evaluate(T, `!!${sw}`)) throw new Error('没有找到图文定时开关');
        if (!await evaluate(T, `${sw}.classList.contains('checked')`)) await fire(T, sw);
        if (!await waitFor(T, `!!${input}`, 5000)) throw new Error('图文定时时间框未出现');
        await evaluate(T, `(()=>{const i=${input};i.focus();i.select()})()`);
        await insertText(T, ctx.schedule.text); await sleep(400); await pressKey(T, 'Enter');
        await evaluate(T, `${input}.blur()`);
        if (await evaluate(T, `${input}.value`) !== ctx.schedule.text) throw new Error('图文定时时间回读不一致');
      }
      ctx.note('图文已填好，请核对图片顺序、标题、正文和原创声明后手动发布');
    },
  };
}
