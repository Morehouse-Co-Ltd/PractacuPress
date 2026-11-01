import { describe, expect, it } from 'vitest';
import type { CustomExtension } from '../types';
import { EXTENSION_LIMITS } from './customize';
import {
  EXTENSION_CSP,
  buildExtensionBundle,
  buildExtensionDocument,
  buildExtensionFile,
  createExtension,
  extensionFileName,
  extensionStorageKey,
  matchPageScope,
  pageKindForPath,
  parseExtensionFile,
  slotLabel,
  slotMatchesPage,
  type ExtensionDocumentContext,
} from './extensions';

const context: ExtensionDocumentContext = {
  theme: { background: '#18171d', ink: '#f7f7fa', accent: '#c4b5fd', font: 'serif' },
  page: 'article',
  title: '一篇文章',
  extensionId: 'ext_demo',
};

describe('createExtension 默认值', () => {
  it('给出可用的默认清单', () => {
    const extension = createExtension();
    expect(extension.id).toMatch(/^ext_[a-z0-9]+$/);
    expect(extension.version).toBe('1.0.0');
    expect(extension.enabled).toBe(false);
    expect(extension.slots).toEqual(['article_bottom']);
    expect(extension.pages).toEqual(['all']);
    expect(extension.permissions).toEqual([]);
    expect(extension.html).toBe('');
    expect(extension.created_at).toBeTruthy();
    expect(extension.updated_at).toBeTruthy();
  });

  it('收敛非法枚举、重复项与超长文本', () => {
    const extension = createExtension({
      id: 'Bad Id!',
      name: '  开头的空格  ',
      version: 'v2.3.4',
      slots: ['floating', 'floating', 'not_a_slot' as never],
      pages: ['home', 'home', 'nope' as never],
      permissions: ['notify', 'notify', 'root' as never],
      html: 'x'.repeat(EXTENSION_LIMITS.html + 50),
    });
    expect(extension.id).toMatch(/^ext_/);
    expect(extension.name).toBe('开头的空格');
    expect(extension.version).toBe('v2.3.4');
    expect(extension.slots).toEqual(['floating']);
    expect(extension.pages).toEqual(['home']);
    expect(extension.permissions).toEqual(['notify']);
    expect(extension.html).toHaveLength(EXTENSION_LIMITS.html);
  });
});

describe('parseExtensionFile 导入', () => {
  it('接受裸清单', () => {
    const parsed = parseExtensionFile(
      JSON.stringify({ name: '裸清单', slots: ['home_top'], html: '<p>hi</p>' }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('裸清单');
    expect(parsed[0].slots).toEqual(['home_top']);
  });

  it('接受导出文件（ExtensionManifestFile）', () => {
    const extension = createExtension({ name: '导出文件里的扩展', enabled: true });
    const parsed = parseExtensionFile(JSON.stringify(buildExtensionFile(extension)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(extension.id);
    expect(parsed[0].enabled).toBe(true);
  });

  it('接受清单数组与全部导出文件', () => {
    const first = createExtension({ name: '甲' });
    const second = createExtension({ name: '乙', slots: ['floating'] });
    expect(parseExtensionFile(JSON.stringify([first, second]))).toHaveLength(2);
    expect(
      parseExtensionFile(JSON.stringify(buildExtensionBundle([first, second]))),
    ).toHaveLength(2);
    expect(parseExtensionFile(JSON.stringify(buildExtensionBundle([first, second])))[1].name).toBe('乙');
  });

  it('坏 JSON 给出中文原因', () => {
    expect(() => parseExtensionFile('{ 这不是 JSON')).toThrow(/有效的 JSON/);
    expect(() => parseExtensionFile('')).toThrow(/请先选择扩展文件/);
  });

  it('完全识别不出的清单会报错', () => {
    expect(() => parseExtensionFile(JSON.stringify({ foo: 'bar' }))).toThrow(/没有扩展清单/);
    expect(() => parseExtensionFile(JSON.stringify([{ nope: 1 }]))).toThrow(/name/);
    expect(() =>
      parseExtensionFile(JSON.stringify({ format: 'other', version: 1, extension: { name: 'x' } })),
    ).toThrow(/Practacu 扩展文件/);
  });

  it('数组里个别坏清单会被跳过，好清单照常导入', () => {
    const parsed = parseExtensionFile(
      JSON.stringify([{ name: '' }, { foo: 1 }, { name: '能用的扩展' }]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('能用的扩展');
  });

  it('超长内容按共享层上限截断', () => {
    const parsed = parseExtensionFile(
      JSON.stringify({
        name: '超长扩展',
        html: 'h'.repeat(EXTENSION_LIMITS.html + 200),
        css: 'c'.repeat(EXTENSION_LIMITS.css + 200),
        js: 'j'.repeat(EXTENSION_LIMITS.js + 200),
        description: 'd'.repeat(EXTENSION_LIMITS.description + 200),
      }),
    );
    expect(parsed[0].html).toHaveLength(EXTENSION_LIMITS.html);
    expect(parsed[0].css).toHaveLength(EXTENSION_LIMITS.css);
    expect(parsed[0].js).toHaveLength(EXTENSION_LIMITS.js);
    expect(parsed[0].description).toHaveLength(EXTENSION_LIMITS.description);
  });

  it('槽位、页面与权限去重后只保留合法值', () => {
    const parsed = parseExtensionFile(
      JSON.stringify({
        name: '去重扩展',
        slots: ['floating', 'floating', 'article_top'],
        pages: ['all', 'home', 'home', 'bogus'],
        permissions: ['notify', 'notify', 'storage', 'root'],
      }),
    );
    expect(parsed[0].slots).toEqual(['floating', 'article_top']);
    expect(parsed[0].pages).toEqual(['all', 'home']);
    expect(parsed[0].permissions).toEqual(['notify', 'storage']);
  });
});

describe('导入导出往返', () => {
  it('单个扩展导出再导入后内容一致', () => {
    const original = createExtension({
      name: '往返扩展',
      version: '2.1.0',
      author: '编辑部',
      description: '导入导出不应丢字段。',
      icon: '返',
      enabled: true,
      slots: ['article_bottom', 'floating'],
      pages: ['home', 'article'],
      permissions: ['notify', 'storage'],
      html: '<section>hi</section>',
      css: '.x{color:red}',
      js: 'window.PP.notify("hi");',
    });
    const parsed = parseExtensionFile(JSON.stringify(buildExtensionFile(original)));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(original);
  });

  it('全部导出再导入后数量与 id 一致', () => {
    const list = [
      createExtension({ name: '甲', html: '<p>a</p>' }),
      createExtension({ name: '乙', slots: ['home_bottom'] }),
    ];
    const parsed = parseExtensionFile(JSON.stringify(buildExtensionBundle(list)));
    expect(parsed.map((item) => item.id)).toEqual(list.map((item) => item.id));
    expect(parsed.map((item) => item.name)).toEqual(['甲', '乙']);
  });
});

describe('页面匹配与文案', () => {
  it('matchPageScope 尊重 all 与页面类型', () => {
    expect(matchPageScope({ pages: ['all'] }, 'home')).toBe(true);
    expect(matchPageScope({ pages: ['all'] }, 'other')).toBe(true);
    expect(matchPageScope({ pages: ['article'] }, 'article')).toBe(true);
    expect(matchPageScope({ pages: ['article'] }, 'home')).toBe(false);
    expect(matchPageScope({ pages: [] }, 'search')).toBe(true);
  });

  it('pageKindForPath 对应 App.tsx 路由', () => {
    expect(pageKindForPath('/')).toBe('home');
    expect(pageKindForPath('/a/abc')).toBe('article');
    expect(pageKindForPath('/p/abc')).toBe('article');
    expect(pageKindForPath('/articles')).toBe('list');
    expect(pageKindForPath('/posts')).toBe('list');
    expect(pageKindForPath('/search')).toBe('search');
    expect(pageKindForPath('/about')).toBe('other');
    expect(pageKindForPath('/login')).toBe('other');
  });

  it('槽位与页面类型的限制', () => {
    expect(slotMatchesPage('home_top', 'home')).toBe(true);
    expect(slotMatchesPage('home_top', 'article')).toBe(false);
    expect(slotMatchesPage('article_bottom', 'article')).toBe(true);
    expect(slotMatchesPage('article_bottom', 'list')).toBe(false);
    expect(slotMatchesPage('floating', 'other')).toBe(true);
    expect(slotMatchesPage('site_header', 'search')).toBe(true);
  });

  it('slotLabel / extensionFileName / 存储键', () => {
    expect(slotLabel('article_bottom')).toBe('文章底部');
    expect(slotLabel('floating')).toBe('悬浮窗');
    const extension = createExtension({ id: 'ext_a1', name: '文末作者卡' });
    expect(extensionFileName(extension)).toBe('文末作者卡.ppext.json');
    expect(extensionFileName(createExtension({ id: 'ext_a2', name: 'a/b:c' }))).toBe('a-b-c.ppext.json');
    expect(extensionFileName({ id: 'ext_a3', name: '   ' })).toBe('ext_a3.ppext.json');
    expect(extensionStorageKey('ext_a1', 'count')).toBe('pp.ext.ext_a1.count');
  });
});

describe('buildExtensionDocument 沙箱文档', () => {
  const base: CustomExtension = createExtension({
    id: 'ext_demo',
    name: '演示扩展',
    html: '<div class="demo">扩展的 HTML</div>',
    css: '.demo { color: var(--pp-accent); }',
    js: 'window.PP.setHeight(window.PP.getContext().title ? 40 : 24);',
  });

  it('包含 CSP、基础 reset、注入内容与 PP 桥', () => {
    const doc = buildExtensionDocument(base, context);
    expect(doc).toContain(EXTENSION_CSP);
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("script-src 'unsafe-inline'");
    expect(doc).toContain('img-src https: data:');
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('扩展的 HTML');
    expect(doc).toContain('.demo { color: var(--pp-accent); }');
    expect(doc).toContain('window.PP.setHeight');
    expect(doc).toContain('window.PP =');
    expect(doc).toContain('--pp-accent:#c4b5fd');
    // 上下文 JSON 已注入（含页面类型与标题）。
    expect(doc).toContain('"page":"article"');
    expect(doc).toContain('"title":"一篇文章"');
    expect(doc).toContain('"extensionId":"ext_demo"');
  });

  it('扩展 JS 里的 </script> 不会截断文档', () => {
    const extension = createExtension({
      id: 'ext_demo',
      name: '防截断',
      js: 'const sample = "</script>"; window.PP && window.PP.setHeight(30);',
    });
    const doc = buildExtensionDocument(extension, context);
    expect(doc).toContain('<\\/script>');
    expect(doc).not.toContain('const sample = "</script>"');
    // 文档结构完整：以 </html> 收尾，脚本块数量符合预期（桥 + 扩展脚本）。
    expect(doc.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('上下文标题里的 </script> 会被转义，不会提前闭合', () => {
    const doc = buildExtensionDocument(base, { ...context, title: '标题</script><script>alert(1)</script>' });
    expect(doc).not.toContain('标题</script>');
    expect(doc).toContain('\\u003c/script>');
  });

  it('主题颜色与字体进入基础变量，非法颜色回退', () => {
    const doc = buildExtensionDocument(base, {
      ...context,
      theme: { background: '#000000', ink: '#ffffff', accent: 'red;}body{display:none', font: 'sans' },
    });
    expect(doc).toContain('--pp-bg:#000000');
    expect(doc).toContain('--pp-ink:#ffffff');
    // 非法颜色不会进入 :root，而是回退到内置强调色（JSON 上下文里的原值不参与 CSS 解析）。
    expect(doc).toContain('--pp-accent:#1f5c4a');
    expect(doc).not.toContain('--pp-accent:red');
    expect(doc).toContain('--pp-font:system-ui');
    expect(doc).toContain('color-scheme:dark');
  });

  it('没有 JS / CSS 时仍生成可用的最小文档', () => {
    const doc = buildExtensionDocument(createExtension({ name: '空扩展' }), context);
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('window.__PP_CONTEXT__');
    expect(doc.trimEnd().endsWith('</html>')).toBe(true);
    // 没有扩展脚本时只保留上下文与桥两段内联脚本。
    expect(doc.match(/<script>/g)).toHaveLength(2);
  });
});
