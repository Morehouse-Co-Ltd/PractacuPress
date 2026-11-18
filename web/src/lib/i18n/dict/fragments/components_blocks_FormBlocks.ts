import type { Dictionary } from '../../plural';

/**
 * 来源：`web/src/components/blocks/FormBlocks.tsx` 与
 * `web/src/lib/blocks.ts` 里的 P3 联系表单（`contact-form`）。
 *
 * 与查询块同一套做法：注册表定义与渲染器同一次改动，译文放同一个片段。已存在于其它
 * 片段的共用词（标题、发送、正在发送……）不重复收录。
 */
const fragment: Dictionary = {
  '读者给站长留言，提交后变成站内通知；带蜜罐与 60 秒冷却，不留存数据。':
    'Lets a reader leave a message for the site owner; it becomes an in-app notification. Includes a honeypot and a 60 second cooldown, and stores nothing else.',
  联系表单: 'Contact form',
  '显示在表单上方的 Markdown 说明，可留空。':
    'Markdown shown above the form. Leave it empty to hide it.',
  按钮文案: 'Button label',
  '留空时显示「发送」。': 'Leave empty to use “Send”.',
  成功文案: 'Success text',
  '发送成功后显示；留空时用默认文案。':
    'Shown after a successful send. Leave it empty to use the default wording.',
  显示姓名: 'Show the name field',
  '关掉后不要求留名，也不提交姓名。':
    'When off, the form asks for no name and sends none.',
  显示邮箱: 'Show the email field',
  '关掉后不收邮箱，站长无法回信。':
    'When off, the form asks for no address, so the owner cannot reply.',
  姓名: 'Name',
  回信邮箱: 'Reply address',
  留言: 'Message',
  网站: 'Website',
  发送: 'Send',
  '正在发送…': 'Sending…',
  '已经送到站长的信箱，谢谢。': 'It reached the site owner. Thank you.',
  '请先写下要发送的内容。': 'Write something to send first.',
  '留言最多 2000 个字符，请精简一下。':
    'The message is limited to 2000 characters. Please shorten it.',
  '名字太长，请缩短到 80 个字节以内（约 26 个汉字）。':
    'That name is too long. Keep it under 80 bytes (about 26 Chinese characters).',
  '回信地址太长了，请缩短一些。': 'That reply address is too long. Please shorten it.',
  '回信地址需要包含 @，例如 name@example.com。':
    'A reply address needs an @, for example name@example.com.',
  '刚发过一条，请稍后再试。': 'You just sent one. Please try again shortly.',
  '发送失败，请稍后再试。': 'Sending failed. Please try again shortly.',
  '演示模式下不会真的发送。': 'Demo mode does not really send anything.',
};

export default fragment;
