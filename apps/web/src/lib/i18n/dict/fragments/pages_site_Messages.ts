import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Messages.tsx` */
const fragment: Dictionary = {
  // ---- 会话列表 ----
  私信: 'Messages',
  新会话: 'New conversation',
  发起会话: 'Start a conversation',
  仅成员可见: 'Visible to members only',
  会话: 'Conversation',
  还没有消息: 'No messages yet',
  还没有会话: 'No conversations yet',
  '选择和一位成员开始对话。': 'Pick a member to start a conversation.',
  '当有人给你发消息时，会话会出现在这里。':
    'When someone messages you, the conversation shows up here.',
  '契约没有成员目录端点，因此无法从浏览器发起新会话；已有会话仍可正常读写。':
    'The contract has no member directory endpoint, so new conversations cannot be started from the browser; existing conversations can still be read and written.',
  返回会话列表: 'Back to the conversation list',

  // ---- 会话标题与消息 ----
  会: 'Conversation',
  '群聊 · {count} 人': { one: 'Group chat · 1 member', other: 'Group chat · {count} members' },
  正在载入会话: 'Loading conversations',
  正在载入消息: 'Loading messages',
  '还没有消息。说点什么吧。': 'No messages yet. Say something.',

  // ---- 输入框与发送 ----
  '输入消息，Enter 发送，Shift + Enter 换行':
    'Type a message. Enter to send, Shift + Enter for a new line',
  发送: 'Send',
  发送失败: 'Could not send',
  '选择一个会话，或者开始一段新的对话。': 'Pick a conversation, or start a new one.',

  // ---- 新建会话弹窗 ----
  '发起新会话': 'Start a new conversation',
  '选择一位成员就是私信；选择多位会创建群聊。':
    'One member starts a direct message; several create a group chat.',
  创建会话: 'Create conversation',
  创建失败: 'Could not create',
  无法加载成员: 'Could not load members',
  '当前站点没有其他可选成员。': 'This site has no other members to choose from.',
  '创建后你一定是成员；私信要求恰好一位其他成员。未读游标由服务端保存。':
    'You are a member as soon as it is created; a direct message needs exactly one other member. The read cursor is stored by the server.',
};

export default fragment;
