import type { Dictionary } from '../../plural';

/**
 * 来源：`apps/web/src/pages/admin/Redirects.tsx`
 *
 * 通用词（取消 / 保存 / 删除 / 加载更多 / 重试……）沿用 `dict/common.ts` 与其它
 * 页面片段里的既有条目，这里只放本页独有的文案。
 */
const fragment: Dictionary = {
  重定向: 'Redirects',
  '一条规则由「旧路径」指向「新路径」；同一旧路径只能有一条规则。已发布内容修改 slug 时，服务端会自动生成一条 source=slug_change 的规则，旧链接不会立刻失效。':
    'A rule points an old path at a new path, and each old path can have only one rule. When a published item changes its slug, the server creates a rule with source=slug_change automatically so existing links keep working.',
  规则怎么生效: 'How rules work',
  '访问旧路径时服务端按规则返回对应状态码并跳到新路径；301 / 308 适合永久搬家，302 适合临时调整。改 slug 自动生成的规则在这里也能看到，删掉它旧地址就不再跳转。':
    'When a visitor opens an old path, the server answers with the rule’s status code and sends them to the new path. Use 301 or 308 for permanent moves and 302 for temporary ones. Rules created by a slug change are listed here too; deleting one stops that redirect.',
  新建规则: 'New rule',
  编辑规则: 'Edit rule',
  旧路径: 'Old path',
  新路径: 'New path',
  跳转方向: 'Redirect direction',
  状态码: 'Status code',
  来源: 'Source',
  命中次数: 'Hits',
  '手工': 'Manual',
  '改 slug 自动生成': 'Created by slug change',
  '永久重定向': 'Permanent redirect',
  '临时重定向': 'Temporary redirect',
  '永久重定向（保留请求方法）': 'Permanent redirect (keeps method)',
  '{count} 次命中': { one: '1 hit', other: '{count} hits' },
  '{count} 条规则': { one: '1 rule', other: '{count} rules' },
  '搜索旧路径或新路径，回车确认': 'Search old or new paths; press Enter',
  搜索重定向规则: 'Search redirect rules',
  正在载入重定向规则: 'Loading redirect rules',
  '重定向规则加载失败。': 'Could not load redirect rules.',
  还没有重定向规则: 'No redirect rules yet',
  没有匹配的规则: 'No matching rules',
  '老链接需要继续可用时新建一条即可；改 slug 产生的规则也会出现在这里。':
    'Create a rule when an old link still needs to work; rules created by a slug change also appear here.',
  '旧路径是访客访问的地址，新路径是跳转目标；同一旧路径只能有一条规则。':
    'The old path is the address visitors open; the new path is where they should land. Each old path can have only one rule.',
  '删除这条规则？': 'Delete this rule?',
  '删除后旧路径不再跳转，访问它会直接落到 404。这个操作不能撤销。':
    'After deleting, the old path stops redirecting and now returns 404. This action cannot be undone.',
  删除规则: 'Delete rule',
  '规则已创建': 'Rule created',
  '规则已更新': 'Rule updated',
  '规则已删除': 'Rule deleted',
  '旧路径不能为空。': 'The old path cannot be empty.',
  '旧路径必须以 / 开头，例如 /a/old-title。':
    'The old path must start with /, for example /a/old-title.',
  '新路径不能为空。': 'The new path cannot be empty.',
  '新路径必须以 / 或 http(s):// 开头。':
    'The new path must start with / or http(s)://.',
  '新路径不能以 // 开头。': 'The new path cannot start with //.',
  '旧路径与新路径不能相同。': 'The old path and the new path cannot be the same.',
  '这个旧路径已经有一条规则了；同一旧路径只能有一条。':
    'This old path already has a rule; each old path can have only one.',
  '必须以 / 开头，例如 /a/old-title。': 'Must start with /, for example /a/old-title.',
  '站内路径以 / 开头；站外地址填 https:// 开头的完整链接。':
    'Use a leading / for paths on this site, or a complete https:// address for an external destination.',
  '301 永久、302 临时、308 永久且保留请求方法。':
    '301 is permanent, 302 is temporary, and 308 is permanent while keeping the request method.',
  这条规则是自动生成的: 'This rule was created automatically',
  '已发布内容修改 slug 时，服务端会自动创建 source=slug_change 的规则；在这里修改会覆盖自动维护的跳转目标。':
    'When a published item changes its slug, the server creates a rule with source=slug_change. Editing it here overrides the redirect target that is maintained automatically.',
  '路径由服务端规范化：旧路径会去掉查询串与结尾斜杠，新路径可以是站内路径或完整的 http(s) 地址。':
    'Paths are normalized by the server: query strings and trailing slashes are removed from the old path, while the new path may be a local path or a complete http(s) address.',
};

export default fragment;
