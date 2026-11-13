import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ROUTE,
  BLOCKED_ADMIN_ROUTE,
  configuredAdminPath,
  createAdminHistory,
  toBrowserPath,
  toInternalPath,
} from './adminPathRoute';

/** 把地址栏放到某个路径，模拟「刷新后直接打开这个地址」。 */
function visit(pathname: string): void {
  window.history.replaceState(null, '', pathname);
}

beforeEach(() => {
  visit('/');
});

describe('地址翻译', () => {
  it('默认入口就是规范路径：两边一致', () => {
    expect(toInternalPath('/admin/content', '/admin', 'browser')).toBe('/admin/content');
    expect(toInternalPath('/admin', '/admin', 'browser')).toBe('/admin');
    expect(toBrowserPath('/admin/content', '/admin')).toBe('/admin/content');
  });

  it('地址栏只有配置的入口能进后台', () => {
    expect(toInternalPath('/manage', '/manage', 'browser')).toBe('/admin');
    expect(toInternalPath('/manage/settings', '/manage', 'browser')).toBe('/admin/settings');
    // 入口已改时直接打开 /admin：内部路径被改成不匹配后台的哨兵路径。
    expect(toInternalPath('/admin', '/manage', 'browser')).toBe(BLOCKED_ADMIN_ROUTE);
    expect(toInternalPath('/admin/content', '/manage', 'browser')).toBe(BLOCKED_ADMIN_ROUTE);
    // 其它站点路径原样通过。
    expect(toInternalPath('/articles', '/manage', 'browser')).toBe('/articles');
  });

  it('代码内部的 /admin 链接始终是后台，配置入口也能被识别', () => {
    expect(toInternalPath('/admin/content', '/manage', 'app')).toBe('/admin/content');
    expect(toInternalPath('/manage/content', '/manage', 'app')).toBe('/admin/content');
  });

  it('前缀必须按路径段匹配，不能把 /manage-x 当成后台', () => {
    expect(toInternalPath('/manage-x', '/manage', 'browser')).toBe('/manage-x');
    expect(toInternalPath('/administrator', '/admin', 'browser')).toBe('/administrator');
    expect(toInternalPath('/admin-panel', '/manage', 'browser')).toBe('/admin-panel');
  });

  it('多段入口与非法值', () => {
    expect(toBrowserPath('/admin/a/b', '/ops/console')).toBe('/ops/console/a/b');
    expect(configuredAdminPath('')).toBe('/admin');
    expect(configuredAdminPath('manage')).toBe('/admin');
    expect(configuredAdminPath('/manage/')).toBe('/manage');
  });
});

describe('createAdminHistory', () => {
  it('刷新后直接打开配置入口：内部路径就是 /admin，地址栏不变', () => {
    visit('/manage/settings?tab=1');
    const history = createAdminHistory('/manage');

    expect(history.location.pathname).toBe('/admin/settings');
    expect(history.location.search).toBe('?tab=1');
    expect(window.location.pathname).toBe('/manage/settings');
  });

  it('刷新后直接打开 /admin（入口已改）：渲染的是 404，不是后台', () => {
    visit('/admin/content');
    const history = createAdminHistory('/manage');

    expect(history.location.pathname).toBe(BLOCKED_ADMIN_ROUTE);
    expect(history.location.pathname.startsWith(ADMIN_ROUTE)).toBe(false);
  });

  it('站内跳 /admin 时地址栏显示配置入口', () => {
    visit('/');
    const history = createAdminHistory('/manage');
    const listener = vi.fn();
    history.listen(listener);

    history.push('/admin/content?kind=article');

    expect(history.location.pathname).toBe('/admin/content');
    expect(history.location.search).toBe('?kind=article');
    expect(window.location.pathname).toBe('/manage/content');
    expect(window.location.search).toBe('?kind=article');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].action).toBe('PUSH');
  });

  it('createHref 给出地址栏里的路径，链接不会写回 /admin', () => {
    visit('/');
    const history = createAdminHistory('/manage');

    expect(history.createHref('/admin/settings')).toBe('/manage/settings');
    expect(history.createHref({ pathname: '/admin/content', search: '?x=1' })).toBe(
      '/manage/content?x=1',
    );
    expect(history.createHref('/articles')).toBe('/articles');
  });

  it('入口变化时，正在后台里的页面保持不动、地址栏换成新入口', () => {
    visit('/admin/settings');
    const history = createAdminHistory('/admin');

    expect(history.location.pathname).toBe('/admin/settings');

    history.setAdminPath('/manage');

    // 站长刚在设置页保存了新入口，不能被踢出后台。
    expect(history.location.pathname).toBe('/admin/settings');
    expect(window.location.pathname).toBe('/manage/settings');
    expect(history.adminPath()).toBe('/manage');

    // 之后站内导航按新入口写地址栏。
    history.push('/admin/content');
    expect(window.location.pathname).toBe('/manage/content');
  });

  it('水合出与服务端一致的入口后，刷新时用对的入口进后台', () => {
    // 本机缓存还是默认入口时先按 /admin 渲染，随后服务端说入口是 /manage。
    visit('/manage');
    const history = createAdminHistory('/admin');
    expect(history.location.pathname).toBe('/manage');

    history.setAdminPath('/manage');

    expect(history.location.pathname).toBe('/admin');
    expect(window.location.pathname).toBe('/manage');
  });

  it('返回上一页（popstate）时重新按地址栏推导', () => {
    visit('/');
    const history = createAdminHistory('/manage');
    history.push('/admin/content');
    expect(window.location.pathname).toBe('/manage/content');

    // 模拟浏览器前进/后退：地址栏回到站点根。
    visit('/articles');
    window.dispatchEvent(new Event('popstate'));

    expect(history.location.pathname).toBe('/articles');
  });
});
