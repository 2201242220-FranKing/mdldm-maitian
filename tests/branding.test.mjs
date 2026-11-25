import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('every inner view renders the new brand in its shared navigation', () => {
  const ctx = vm.createContext({ document: { createElement: () => ({}), addEventListener() {} } });
  vm.runInContext(source('src/web/mt.js'), ctx);
  for (const view of ['traffic', 'calendar', 'convert', 'archive', 'system', 'ep']) {
    const html = vm.runInContext(`topbar({ health: {} }, ${JSON.stringify(view)})`, ctx);
    assert.match(html, /class="logo"[^>]*><img[^>]+icon-180\.png[^>]*>内容工作台<\/a>/);
  }
});

test('pages and default configuration use the content workspace name', () => {
  for (const file of ['src/web/board.html', 'src/web/pages.html']) {
    const html = source(file);
    assert.match(html, /<title>内容工作台<\/title>/);
    assert.match(html, /name="apple-mobile-web-app-title" content="内容工作台"/);
    assert.doesNotMatch(html, /麦田/);
  }
  assert.equal(JSON.parse(source('config.example.json')).name, '内容工作台');
});

test('login, notifications and widgets have no old application name', () => {
  for (const file of [
    'src/login.mjs', 'src/feishu.mjs', 'src/web.mjs',
    'scripts/widget/maitian-loader.js', 'scripts/widget/maitian-widget.js',
  ]) {
    const text = source(file);
    assert.match(text, /内容工作台/);
    assert.doesNotMatch(text, /麦田/);
  }
});

test('external publisher extension identity is preserved', () => {
  assert.match(source('src/plugin.mjs'), /eaaipbilkhibicihiollecmbpneikpnj/);
  assert.match(source('src/hub.mjs'), /麦田发布助手/);
});
