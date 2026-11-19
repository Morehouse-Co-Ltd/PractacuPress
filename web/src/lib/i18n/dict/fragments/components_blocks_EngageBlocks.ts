import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/blocks/EngageBlocks.tsx` */
const fragment: Dictionary = {
  留言箱: 'Guestbook',
  '写句话吧…': 'Say a few words…',
  '当前后端还没有评论列表端点，留言暂时无法显示。':
    'This backend does not expose a comment list endpoint yet, so messages cannot be shown right now.',
  '留言读取失败。': 'Could not load the messages.',
  没有留言权限: 'No permission to leave messages',
  '站长可以在用户组里开启这项能力。': 'The site owner can enable this in the user groups.',
  留言已送出: 'Message sent',
  '通过审核后才会公开显示。': 'It becomes public once it passes review.',
  发送失败: 'Could not send',
  '{count} 条留言': { one: '1 message', other: '{count} messages' },
  留言入口已关闭: 'The guestbook is closed',
  '站长在「站点设置 → 评论」里关闭了评论；已有留言仍然保留。':
    'The site owner turned comments off under “Site settings → Comments”; existing messages are kept.',
  '给{title}留言': 'Leave a message for {title}',
  这个页面: 'this page',
  '发送中…': 'Sending…',
  留下这句话: 'Leave this message',
  '登录后就能留言，写多写少都可以。':
    'Sign in to leave a message — a line or a paragraph, either is fine.',
  去登录: 'Go to sign in',
  待审核: 'Pending review',
  还没有留言: 'No messages yet',
  '第一句话留给你。': 'The first one is yours.',
};

export default fragment;
