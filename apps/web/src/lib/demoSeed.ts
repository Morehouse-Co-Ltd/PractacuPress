import type {
  Asset,
  Comment,
  Content,
  Conversation,
  Member,
  Message,
  Notification,
  Role,
  Site,
  User,
} from '../types';
import type { ActivityEntry } from '../types';
import { renderSource } from './markdown';

export interface DemoUser extends User {
  email: string;
  password: string;
  role: Role;
}

export interface DemoContent extends Content {
  source_body: string;
  author_id: string;
  author_name: string;
}

export interface DemoComment extends Comment {
  author_id: string;
  author_name: string;
  created_at: string;
}

export interface DemoState {
  version: 1;
  site: Site;
  users: DemoUser[];
  contents: DemoContent[];
  comments: DemoComment[];
  reactions: { user_id: string; target_type: string; target_id: string; kind: string }[];
  bookmarks: { user_id: string; target_type: string; target_id: string }[];
  follows: { follower_id: string; followee_id: string }[];
  conversations: Conversation[];
  messages: Message[];
  notifications: Notification[];
  assets: Asset[];
  activity: ActivityEntry[];
  seeded_at: string;
}

const DAY = 86_400_000;
const BASE = Date.now();

function daysAgo(days: number, hour = 9): string {
  const d = new Date(BASE - days * DAY);
  d.setHours(hour, 20, 0, 0);
  return d.toISOString();
}

function cover(label: string, tone: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">
    <rect width="480" height="320" fill="${tone}"/>
    <g stroke="rgba(255,255,255,.22)" stroke-width="1">
      ${Array.from({ length: 11 }, (_, i) => `<line x1="${i * 48}" y1="0" x2="${i * 48}" y2="320"/>`).join('')}
      ${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="${i * 40}" x2="480" y2="${i * 40}"/>`).join('')}
    </g>
    <circle cx="356" cy="104" r="54" fill="rgba(255,255,255,.14)"/>
    <text x="34" y="268" font-family="Georgia,serif" font-size="30" fill="rgba(255,255,255,.92)">${label}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface SeedOptions {
  admin: { email: string; display_name: string; password: string };
  site: { name: string; domain: string; description: string; visibility_mode: Site['visibility_mode']; publish_mode: Site['publish_mode'] };
}

function article(
  state: Pick<DemoState, 'users'>,
  input: {
    id: string;
    title: string;
    slug: string;
    summary: string;
    body: string;
    authorId: string;
    status: DemoContent['status'];
    createdDays: number;
    publishedDays?: number;
    format?: 'markdown' | 'html' | 'plain';
  },
): DemoContent {
  const author = state.users.find((u) => u.id === input.authorId)!;
  const format = input.format ?? 'markdown';
  return {
    id: input.id,
    kind: 'article',
    status: input.status,
    title: input.title,
    slug: input.slug,
    summary: input.summary,
    source_format: format,
    rendered_html: renderSource(format, input.body),
    policy_version: 'policy-2026.10',
    published_at: input.publishedDays !== undefined ? daysAgo(input.publishedDays, 10) : undefined,
    created_at: daysAgo(input.createdDays, 9),
    updated_at: daysAgo(Math.max(0, input.createdDays - 2), 15),
    actions: [],
    author_id: author.id,
    author_name: author.display_name,
    source_body: input.body,
  };
}

function post(
  state: Pick<DemoState, 'users'>,
  input: {
    id: string;
    title: string;
    slug: string;
    summary: string;
    body: string;
    authorId: string;
    status: DemoContent['status'];
    createdDays: number;
    publishedDays?: number;
  },
): DemoContent {
  const author = state.users.find((u) => u.id === input.authorId)!;
  return {
    id: input.id,
    kind: 'post',
    status: input.status,
    title: input.title,
    slug: input.slug,
    summary: input.summary,
    source_format: 'markdown',
    rendered_html: renderSource('markdown', input.body),
    policy_version: 'policy-2026.10',
    published_at: input.publishedDays !== undefined ? daysAgo(input.publishedDays, 11) : undefined,
    created_at: daysAgo(input.createdDays, 11),
    updated_at: daysAgo(Math.max(0, input.createdDays - 1), 12),
    actions: [],
    author_id: author.id,
    author_name: author.display_name,
    source_body: input.body,
  };
}

const DEMO_TAXONOMY: Record<string, { category_id: string; tags: string[] }> = {
  cnt_house: { category_id: 'cat_writing', tags: ['独立出版', '工作流'] },
  cnt_whitespace: { category_id: 'cat_design', tags: ['排版', '阅读'] },
  cnt_community: { category_id: 'cat_community', tags: ['社区'] },
  cnt_workflow: { category_id: 'cat_product', tags: ['工作流', '独立出版'] },
  cnt_white: { category_id: 'cat_design', tags: ['排版', '阅读'] },
  cnt_ledger: { category_id: 'cat_writing', tags: ['独立出版'] },
  cnt_moderation: { category_id: 'cat_community', tags: ['社区', '工作流'] },
  cnt_neighbors: { category_id: 'cat_community', tags: ['社区', '阅读'] },
  cnt_autumn: { category_id: 'cat_product', tags: ['排版'] },
  cnt_algo: { category_id: 'cat_product', tags: ['独立出版'] },
  cnt_letters: { category_id: 'cat_writing', tags: ['独立出版'] },
  cnt_media: { category_id: 'cat_product', tags: ['工作流'] },
  pst_nesting: { category_id: 'cat_community', tags: ['社区'] },
  pst_rss: { category_id: 'cat_product', tags: ['阅读'] },
  pst_welcome: { category_id: 'cat_community', tags: ['社区'] },
  pst_maintenance: { category_id: 'cat_product', tags: ['工作流'] },
};

/** 给旧演示数据补上分类与标签；新种子直接复用同一张表。 */
export function applyDemoTaxonomy(contents: Content[]): boolean {
  let changed = false;
  for (const entry of contents) {
    const assigned = DEMO_TAXONOMY[entry.id];
    if (!assigned) continue;
    if (!entry.category_id) {
      entry.category_id = assigned.category_id;
      changed = true;
    }
    if (!entry.tags?.length) {
      entry.tags = [...assigned.tags];
      changed = true;
    }
  }
  return changed;
}

export function createSeed(options: SeedOptions): DemoState {
  const users: DemoUser[] = [
    {
      id: 'usr_admin',
      display_name: options.admin.display_name || '林知远',
      email: options.admin.email || 'admin@practacu.local',
      password: options.admin.password || 'practacu',
      role: 'platform_admin',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(120),
    },
    {
      id: 'usr_editor',
      display_name: '周宛',
      email: 'editor@practacu.local',
      password: 'practacu',
      role: 'editor',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(96),
    },
    {
      id: 'usr_chen',
      display_name: '陈默',
      email: 'chen@practacu.local',
      password: 'practacu',
      role: 'member',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(74),
    },
    {
      id: 'usr_su',
      display_name: '苏黎',
      email: 'su@practacu.local',
      password: 'practacu',
      role: 'member',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(52),
    },
    {
      id: 'usr_he',
      display_name: '何一',
      email: 'he@practacu.local',
      password: 'practacu',
      role: 'member',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(38),
    },
    {
      id: 'usr_gu',
      display_name: '顾南',
      email: 'gu@practacu.local',
      password: 'practacu',
      role: 'member',
      locale: 'zh-CN',
      status: 'active',
      created_at: daysAgo(21),
    },
  ];

  const site: Site = {
    id: 'site_main',
    slug: 'practacu',
    name: options.site.name || 'Practacu Press',
    domain: options.site.domain || 'press.local',
    visibility_mode: options.site.visibility_mode,
    publish_mode: options.site.publish_mode,
    disabled: false,
    description:
      options.site.description ||
      '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。',
  };

  const contents: DemoContent[] = [
    article({ users }, {
      id: 'cnt_house',
      title: '为小型刊物建一座自己的房子',
      slug: 'a-house-for-small-presses',
      summary:
        '当平台替你决定谁被看见，独立出版就不再只是排版问题。我们想要一间自己的房子：地基是内容，墙是规则，窗是对外开放。',
      authorId: 'usr_admin',
      status: 'published',
      createdDays: 14,
      publishedDays: 12,
      body: `每个写作者大概都经历过这样的时刻：文章发出去了，阅读量停在两位数，而首页推荐位上是另一套你完全不认识的语法。你开始怀疑，是不是标题不够长，是不是应该再加三个感叹号。

问题往往不在写作，而在房子。你一直住在别人的房子里。

## 房子与租约

平台提供的是租约，不是产权。租约当然有它的好处：水电齐全，拎包入住。但租约也意味着，涨租、改户型、甚至整栋楼被卖掉，都不需要经过你。

独立出版想解决的，首先是产权问题：

- **内容归作者。** 稿件、修订、评论和订阅关系，都可以导出。
- **规则可解释。** 什么会被推荐、什么会被折叠，写在明处。
- **数据可带走。** 关掉这间房子，人还在，稿子也还在。

> 独立不是拒绝平台，而是保留搬走的能力。

## 墙要自己砌

一间房子不能只有地基。墙是规则：谁能发稿，谁能审核，什么内容会被退回，退回之后怎么申诉。这些规则如果只存在于管理员脑子里，房子就还是纸糊的。

我们把它们写进站点设置里：访客模式、发布模式、四级角色、内容状态机。它们不性感，但决定了这间房子能不能住人。

## 窗要开着

最后是窗。一个只对自己开放的房子，本质上是一个仓库。我们保留公开浏览、搜索、评论和关注，也保留匿名读者的位置。

房子不必大。能遮雨，能招待几个朋友，能让写作者在夜里安静地改一段话，就够了。`,
    }),
    article({ users }, {
      id: 'cnt_whitespace',
      title: '排版的克制：留白不是空',
      slug: 'restraint-in-typesetting',
      summary: '留白不是没有内容，而是让内容有呼吸的地方。关于行高、字距、栏宽与一个编辑部的小小偏执。',
      authorId: 'usr_editor',
      status: 'published',
      createdDays: 11,
      publishedDays: 10,
      body: `排版的第一课，往往不是“加什么”，而是“不加什么”。

## 一行字该有多宽

西文排版里有个经验值：一行 45 到 75 个字符。中文没有空格，按字数算，大约 28 到 38 个字。超过这个范围，读者的眼睛在换行时会丢失位置，于是反复重读同一行。

我们把正文栏宽限制在 34 个字左右。这个数字不是审美，是生理。

## 行高是一口气

行高太紧，字与字挤在一起，像高峰期的地铁；行高太松，段落散开，读起来像在跳石墩。中文正文的行高，1.75 到 1.9 之间通常比较舒服。

我们用了 1.85。不是因为它最科学，而是因为它在小屏幕上也不至于散架。

## 空白的地方也在说话

标题上方的空白，是停顿；段落之间的空白，是换气；页面两侧的空白，是边界。把这些空白填满，读者就没有地方思考了。

> 好的排版让人忘记排版，只记得内容。

这也是本站默认白色的原因：白不是风格，是把注意力还给文字。`,
    }),
    article({ users }, {
      id: 'cnt_community',
      title: '社区不是评论区',
      slug: 'a-community-is-not-a-comment-box',
      summary: '把评论框装在文章底下，不会自动长出社区。社区需要身份、记忆和边界，还需要有人愿意打扫。',
      authorId: 'usr_chen',
      status: 'published',
      createdDays: 9,
      publishedDays: 8,
      body: `很多产品把“有评论区”当成“有社区”。这两件事的距离，大概等于“有厨房”和“会做饭”。

## 身份

匿名让表达更自由，也让责任更稀薄。我们选择让每个发言都挂着一个名字，哪怕这个名字只是一个昵称。名字会积累，积累会产生轻微的羞耻感，而羞耻感是文明的一部分。

## 记忆

社区需要记得发生过什么。谁曾经认真回答过问题，谁总是在深夜出现，谁的文章被反复引用。这些记忆不该只存在于某个人的脑子里。

## 边界

边界不是歧视，是秩序。哪些话可以说，哪些话会被折叠，折叠之后能不能申诉，都需要写清楚，并且对所有人一致。

## 打扫

最后，社区需要有人打扫。不是删帖，而是回复、置顶、把跑偏的讨论拉回来、给新来的人指路。这份工作很琐碎，也很重要。

我们只有三个人轮班。但至少，我们知道自己不是在经营一个评论框。`,
    }),
    article({ users }, {
      id: 'cnt_workflow',
      title: '从草稿到发布：一条内容要经过什么',
      slug: 'from-draft-to-published',
      summary: '草稿、待审核、发布、退回、归档。一张状态机图背后，是编辑权和作者权的分工。',
      authorId: 'usr_su',
      status: 'published',
      createdDays: 7,
      publishedDays: 6,
      body: `在 Practacu Press 里，一条内容不是“发出去”就完事了。它会经过一条明确的状态机。

## 五个状态

- **草稿**：只有作者和编辑能看到，可以反复修改。
- **待审核**：作者提交后进入队列，等待编辑处理。
- **已发布**：读者可见，内容冻结，修改需要重新走流程。
- **已退回**：编辑附上理由退回，作者可以改完再提交。
- **已归档**：从公开列表移出，但链接仍然有效。

## 三种发布模式

站点可以选择开放发布、审核发布、按角色发布。开放发布适合彼此信任的小团队；审核发布适合公开注册的社区；按角色发布则把“直接发布”的权限留给编辑。

模式不是装饰。它决定了作者点下“发布”之后，看到的是“已上线”还是“已提交，等待审核”。

## 谁能做什么

作者可以创建、编辑自己的草稿、提交审核、查看退回理由。编辑可以审核、发布、退回、归档。站点管理员还可以调整成员角色和站点规则。

有一条规则我们坚持了很久：**作者不能审核自己的稿子。** 哪怕他是编辑。

## 为什么值得这么麻烦

因为内容一旦公开，就不只是作者一个人的事。它会影响读者、影响站点、影响其他作者。状态机让每一次变更都有记录，也让责任落在具体的人身上。`,
    }),
    article({ users }, {
      id: 'cnt_white',
      title: '本站为什么默认白色',
      slug: 'why-white',
      summary: '深色模式很酷，但阅读首先需要光。我们选择一张白纸，然后小心地控制上面的一切。',
      authorId: 'usr_he',
      status: 'published',
      createdDays: 5,
      publishedDays: 4,
      body: `每次有人问“为什么不做深色模式”，我都会想起小时候在台灯下看书的经验。

## 白是底色，不是风格

白纸不参与表达。它退到后面，把黑字推到前面。对一篇三千字的文章来说，这种退让很重要。

深色模式适合夜晚，也适合代码。但长时间阅读大段中文，浅底深字仍然更省力。这不是怀旧，是眼科医生的建议。

## 白色最难做

白色看起来简单，实际上很难。纯白刺眼，灰白脏，暖白容易发黄。边框深一点显得脏，浅一点又看不见。阴影稍重就像网页模板，完全不用又会失去层次。

我们的做法是：

- 背景用 \`#ffffff\`，只在侧栏和表头用极浅的暖灰。
- 分隔线一律 1px，颜色控制在 \`#e7e7e1\` 附近。
- 不用大面积阴影，用留白和细线建立层级。
- 强调色只保留一种深绿，出现在链接和当前状态上。

## 克制是一种承诺

默认白色，意味着我们承诺不拿视觉效果抢内容的注意力。读者来这里是为了读字，不是为了看设计。

如果哪天你发现某个按钮太亮、某条线太重，欢迎写信告诉我们。那通常意味着我们违背了这个承诺。`,
    }),
    article({ users }, {
      id: 'cnt_ledger',
      title: '独立出版的账本',
      slug: 'the-ledger',
      summary: '一台服务器、一份域名、三个人的时间。把成本摊开写，独立出版才不是一句口号。',
      authorId: 'usr_admin',
      status: 'published',
      createdDays: 3,
      publishedDays: 2,
      body: `独立出版最浪漫的部分是“独立”，最不浪漫的部分是“出版”。

## 每个月的固定成本

- 服务器：一台 2 核 4G 的小机器，够跑 API、数据库和对象存储。
- 域名与证书：一年一次，金额可以忽略。
- 备份：对象存储的冷归档，按月计费。
- 人的时间：这部分最贵，也最容易被忽略。

## 钱从哪里来

我们目前只做两件事：读者自愿订阅，以及把排版和部署能力做成服务，卖给同样想做小刊物的人。不接广告，不做付费墙，不卖数据。

这不是道德优越，是能力有限。三条收入线会让我们没有时间写稿。

## 什么时候该担心

当服务器账单超过订阅收入，当维护时间挤掉写作时间，当“增长”开始要求我们改变内容。这三件事任何一件发生，都值得停下来重算一遍账。

> 可持续的小，比不可持续的大更难。

把账本公开，是为了让读者知道：你付的钱去了哪里，以及这间房子还能开多久。`,
    }),
    article({ users }, {
      id: 'cnt_moderation',
      title: '审核不是审查：一份社区编辑手册',
      slug: 'moderation-not-censorship',
      summary: '审核处理的是表达方式与边界，不是观点本身。我们试着把判断标准写成可以讨论的条款。',
      authorId: 'usr_editor',
      status: 'pending_review',
      createdDays: 2,
      body: `这篇文章想回答一个问题：编辑到底在审什么？

## 审的是边界，不是观点

我们不会因为“不同意”而退回一篇稿子。会被退回的，通常是这几类：人身攻击、未经证实的指控、侵犯隐私、明显的商业导流，以及违反站点明确列出的规则。

观点尖锐不是问题，事实错误才是。

## 退回要写理由

“不合适”不是理由。退回时必须写明：哪一段、哪句话、涉及哪条规则、可以怎么改。作者有权知道发生了什么。

## 作者可以申诉

申诉不是对抗，是纠错机制。编辑也会判断错误。我们保留一次复核，由另一位编辑处理。

## 审核记录要可追溯

每一次状态变更都记录操作者、时间、原因。这不是为了追责，是为了让规则可以被检验。

如果一份手册只能写在某个人心里，它就不是规则。`,
    }),
    article({ users }, {
      id: 'cnt_neighbors',
      title: '把读者当邻居',
      slug: 'readers-as-neighbors',
      summary: '数据把读者变成流量，邻居则意味着你会记得他住在哪、上次聊了什么。',
      authorId: 'usr_chen',
      status: 'pending_review',
      createdDays: 1,
      body: `“用户”是一个很方便的词。它把具体的人压缩成一个可以统计的单位。

我更愿意用“邻居”。

## 邻居意味着什么

你会在楼道里点头，会记得他家的猫叫什么，会在他搬走的时候送到门口。你不会给他打标签，也不会把他的一天切成七个转化漏斗。

## 订阅比推荐更像邻里

推荐算法关心的是下一次点击，订阅关心的是下一次见面。一个愿意留下邮箱的人，比一万个划过首页的人更像邻居。

## 慢一点没关系

我们不做实时热点，不做每日推送。一周两篇文章，够邻居们在周末读完。

如果有一天这里变得很热闹，希望它仍然像一个街区，而不是一个广场。`,
    }),
    article({ users }, {
      id: 'cnt_autumn',
      title: '秋季改版说明',
      slug: 'autumn-redesign-notes',
      summary: '调整了首页结构、评论层级和移动端字号。附上改动清单与未采纳的建议。',
      authorId: 'usr_su',
      status: 'draft',
      createdDays: 1,
      body: `这次改版不大，主要是三件事。

## 首页

把“最新”从三栏改成两栏，右侧留给编辑推荐和站点信息。信息密度降低了，但每篇文章的摘要更完整。

## 评论

嵌套从五层收到三层。更深的回复会被折叠到父评论下，不再继续缩进。

## 移动端

正文字号从 16px 提到 17px，行高 1.85。标题不再使用两端对齐。

## 没有采纳的

- 深色模式：先不做，理由见《本站为什么默认白色》。
- 无限滚动：保留分页，读者需要知道自己在哪。
- 阅读进度条：移动端加，桌面端暂不加。

预计下周发布。`,
    }),
    article({ users }, {
      id: 'cnt_algo',
      title: '关于（不）做算法推荐',
      slug: 'no-algorithm',
      summary: '我们试过一版推荐，最后把它下线了。原因不是技术，是它开始替编辑做价值判断。',
      authorId: 'usr_he',
      status: 'rejected',
      createdDays: 6,
      body: `去年冬天，我们做了一个很小的推荐系统：根据阅读完成率和评论数，给首页排序。

它很快奏效。点击率涨了 30%，首页停留时间翻倍。

然后问题出现了：长文被短文挤下去，严肃的稿子输给标题更抓人的稿子。编辑开始按照模型的偏好改标题，作者开始写更容易被推荐的题材。

我们花了两个月，把系统下线了。

## 不是反对算法

算法适合处理海量内容，我们一周只有两篇文章。用推荐系统解决一个不存在的问题，只会带来新的问题。

## 现在怎么做

首页由编辑手动排。推荐位保留三个，理由写在旁边。读者可以不同意，也可以在评论里说。

这很慢，但至少我们知道每个位置为什么在那里。`,
    }),
    article({ users }, {
      id: 'cnt_letters',
      title: '去年的十二封信',
      slug: 'twelve-letters',
      summary: '2025 年写给订阅者的十二封信，已归档。链接仍然有效，谢谢每一位回信的人。',
      authorId: 'usr_admin',
      status: 'archived',
      createdDays: 40,
      publishedDays: 36,
      body: `2025 年，我们给订阅者写了十二封信。

一月谈搬迁，二月谈预算，三月谈一次失败的改版。四月停更了两周，五月恢复。六月我们第一次收到读者的纸质回信。

七月到九月在整理旧稿。十月做了一次小型聚会，来了九个人。十一月讨论要不要接广告，结论是不接。十二月把这十二封信装订成册。

现在它们归档了。链接仍然有效，只是不再出现在首页。

谢谢每一位回信的人。`,
    }),
    article({ users }, {
      id: 'cnt_media',
      title: '图片上传策略更新',
      slug: 'upload-policy-update',
      summary: '上传改为两步：先开会话，再传字节，最后由安全服务检查。未通过检查的文件不会被引用。',
      authorId: 'usr_editor',
      status: 'pending_security_check',
      createdDays: 0,
      body: `从本周开始，站内上传改为两步流程。

1. 客户端提交文件名、大小和 MIME，服务端返回上传会话。
2. 客户端上传字节，服务端在完成时调用安全检查。
3. 只有检查结果为 clean 的文件才能被文章引用。

这样做的好处是，未通过检查的文件不会出现在任何页面上。代价是上传会多一次往返。

允许的类型：PNG、JPEG、WebP、GIF、PDF、纯文本。单个文件上限 25 MiB。

如果你遇到“安全检查不可用”的提示，请稍后重试。内容会保留，只是暂时不能发布。`,
    }),
  ];

  const posts: DemoContent[] = [
    post({ users }, {
      id: 'pst_nesting',
      title: '评论嵌套收窄到三层',
      slug: 'comment-depth',
      summary: '今天把嵌套从五层收到三层，更深的回复折叠到父评论下。',
      authorId: 'usr_chen',
      status: 'published',
      createdDays: 2,
      publishedDays: 2,
      body: `今天把评论嵌套从五层收到三层。

再深的讨论，缩进已经比内容还宽了。折叠到父评论下，读起来反而清楚。

有几位读者说找不到自己昨天的回复，试一下父评论右边的“展开回复”。`,
    }),
    post({ users }, {
      id: 'pst_rss',
      title: '还有人用 RSS 读我们吗？',
      slug: 'rss-check',
      summary: '想确认一下订阅源还有没有人在用，顺便决定要不要继续维护。',
      authorId: 'usr_he',
      status: 'published',
      createdDays: 3,
      publishedDays: 3,
      body: `想确认一下：还有人用 RSS 读我们吗？

后台显示每周有 40 多个抓取请求，但分不清是读者还是爬虫。如果你在用，回一句就好，我们继续维护。`,
    }),
    post({ users }, {
      id: 'pst_meeting',
      title: '编辑部周会：三个待定标题',
      slug: 'weekly-meeting',
      summary: '下周三篇稿子的标题还没定，先把候选写在这里。',
      authorId: 'usr_editor',
      status: 'draft',
      createdDays: 1,
      body: `周三篇稿子的标题还没定，候选如下：

1. 《审核不是审查》 / 《编辑到底在审什么》
2. 《把读者当邻居》 / 《订阅比推荐更像邻里》
3. 《图片上传策略更新》 / 《为什么上传要多一步》

倾向第一个，更直接。`,
    }),
    post({ users }, {
      id: 'pst_welcome',
      title: '新成员报到：欢迎苏黎',
      slug: 'welcome-su',
      summary: '苏黎加入编辑部，负责排版与移动端。',
      authorId: 'usr_su',
      status: 'published',
      createdDays: 6,
      publishedDays: 6,
      body: `大家好，我是苏黎。接下来负责排版和移动端，也会写一些关于设计的稿子。

之前在杂志社做版式，习惯了纸的边界。屏幕没有边界，还在适应。

请多指教。`,
    }),
    post({ users }, {
      id: 'pst_maintenance',
      title: '维护窗口：本周日 02:00–03:00',
      slug: 'maintenance-window',
      summary: '数据库迁移与备份，预计停机一小时。',
      authorId: 'usr_admin',
      status: 'published',
      createdDays: 4,
      publishedDays: 4,
      body: `本周日 02:00–03:00 做数据库迁移和全量备份，期间站点只读。

迁移前会先备份，失败就回滚。如果 03:30 还没恢复，会在通知里说明。`,
    }),
    post({ users }, {
      id: 'pst_ideas',
      title: '草稿箱里躺了半年的选题',
      slug: 'draft-ideas',
      summary: '整理草稿箱，发现六个没写完的选题，挑一个继续。',
      authorId: 'usr_chen',
      status: 'draft',
      createdDays: 8,
      body: `整理草稿箱，翻出六个没写完的选题：

- 为什么小刊物需要一份风格指南
- 读者来信的编辑伦理
- 一次失败的众筹复盘
- 纸质刊物还有未来吗
- 我们如何做事实核查
- 编辑的阅读量

最想写第三个，但需要当事人同意。`,
    }),
  ];

  // 分类与标签属于站点自定义配置，内容只保存引用；这里给演示内容补一组可读的初始值。
  applyDemoTaxonomy([...contents, ...posts]);

  const comments: DemoComment[] = [    {
      id: 'cmt_1',
      target_type: 'article',
      target_id: 'cnt_house',
      depth: 0,
      body: '“保留搬走的能力”这句说到心里了。我们去年把周刊从平台搬回自建站，最麻烦的不是技术，是订阅关系的迁移。',
      status: 'visible',
      author_id: 'usr_chen',
      author_name: '陈默',
      created_at: daysAgo(11, 14),
    },
    {
      id: 'cmt_2',
      target_type: 'article',
      target_id: 'cnt_house',
      parent_id: 'cmt_1',
      depth: 1,
      body: '订阅关系确实是命门。我们最后是让读者重新确认了一次邮箱，流失了大概三成，但留下来的人更稳定。',
      status: 'visible',
      author_id: 'usr_admin',
      author_name: '林知远',
      created_at: daysAgo(11, 16),
    },
    {
      id: 'cmt_3',
      target_type: 'article',
      target_id: 'cnt_house',
      parent_id: 'cmt_2',
      depth: 2,
      body: '三成这个数字很有参考价值。我们还在犹豫要不要做双写。',
      status: 'visible',
      author_id: 'usr_chen',
      author_name: '陈默',
      created_at: daysAgo(10, 9),
    },
    {
      id: 'cmt_4',
      target_type: 'article',
      target_id: 'cnt_house',
      depth: 0,
      body: '房子这个比喻很好。不过产权之外，还有一件事是维护成本，屋顶漏雨得自己爬上去修。',
      status: 'visible',
      author_id: 'usr_he',
      author_name: '何一',
      created_at: daysAgo(10, 10),
    },
    {
      id: 'cmt_5',
      target_type: 'article',
      target_id: 'cnt_whitespace',
      depth: 0,
      body: '34 个字这个数字我记下了。之前一直按 40 个字排，难怪读起来累。',
      status: 'visible',
      author_id: 'usr_su',
      author_name: '苏黎',
      created_at: daysAgo(9, 11),
    },
    {
      id: 'cmt_6',
      target_type: 'article',
      target_id: 'cnt_whitespace',
      parent_id: 'cmt_5',
      depth: 1,
      body: '也和字号有关。字号越小，一行能放的字越多，但眼睛更累。',
      status: 'visible',
      author_id: 'usr_editor',
      author_name: '周宛',
      created_at: daysAgo(9, 13),
    },
    {
      id: 'cmt_7',
      target_type: 'article',
      target_id: 'cnt_community',
      depth: 0,
      body: '“有厨房”和“会做饭”的类比太准确了。我们社区现在就处在有厨房但没人做饭的阶段。',
      status: 'visible',
      author_id: 'usr_gu',
      author_name: '顾南',
      created_at: daysAgo(7, 18),
    },
    {
      id: 'cmt_8',
      target_type: 'post',
      target_id: 'pst_nesting',
      depth: 0,
      body: '三层刚好。再深就变成论坛盖楼了。',
      status: 'visible',
      author_id: 'usr_admin',
      author_name: '林知远',
      created_at: daysAgo(2, 12),
    },
    {
      id: 'cmt_9',
      target_type: 'article',
      target_id: 'cnt_whitespace',
      depth: 0,
      body: '34 个字在小屏上会不会偏窄？我在手机上读的时候，一段要换四五次行。',
      status: 'pending_review',
      author_id: 'usr_gu',
      author_name: '顾南',
      created_at: daysAgo(1, 20),
    },
    {
      id: 'cmt_10',
      target_type: 'article',
      target_id: 'cnt_community',
      depth: 0,
      body: '（这条评论已被隐藏，用于演示审核状态。）',
      status: 'hidden',
      author_id: 'usr_he',
      author_name: '何一',
      created_at: daysAgo(3, 19),
    },
  ];

  const notifications: Notification[] = [
    {
      id: 'ntf_1',
      recipient_id: 'usr_admin',
      type: 'comment.created',
      actor_id: 'usr_chen',
      subject_id: 'cmt_1',
      payload: {
        actor_name: '陈默',
        title: '为小型刊物建一座自己的房子',
        excerpt: '“保留搬走的能力”这句说到心里了。',
        kind: 'article',
        target_id: 'cnt_house',
      },
      read: false,
      created_at: daysAgo(0, 9),
    },
    {
      id: 'ntf_2',
      recipient_id: 'usr_admin',
      type: 'reaction.created',
      actor_id: 'usr_su',
      subject_id: 'cnt_house',
      payload: {
        actor_name: '苏黎',
        title: '为小型刊物建一座自己的房子',
        kind: 'article',
        target_id: 'cnt_house',
      },
      read: false,
      created_at: daysAgo(0, 8),
    },
    {
      id: 'ntf_3',
      recipient_id: 'usr_admin',
      type: 'moderation.updated',
      subject_id: 'cnt_moderation',
      payload: {
        title: '审核不是审查：一份社区编辑手册',
        excerpt: '周宛 提交了审核请求。',
        kind: 'article',
        target_id: 'cnt_moderation',
      },
      read: false,
      created_at: daysAgo(1, 16),
    },
    {
      id: 'ntf_4',
      recipient_id: 'usr_admin',
      type: 'follow.created',
      actor_id: 'usr_gu',
      payload: { actor_name: '顾南', excerpt: '开始关注你。' },
      read: true,
      read_at: daysAgo(2, 9),
      created_at: daysAgo(2, 8),
    },
    {
      id: 'ntf_5',
      recipient_id: 'usr_admin',
      type: 'message.created',
      actor_id: 'usr_editor',
      payload: {
        actor_name: '周宛',
        excerpt: '下周的审核排期要不要调整？',
        conversation_id: 'cnv_editorial',
      },
      read: false,
      created_at: daysAgo(1, 10),
    },
    {
      id: 'ntf_6',
      recipient_id: 'usr_admin',
      type: 'comment.created',
      actor_id: 'usr_he',
      subject_id: 'cmt_4',
      payload: {
        actor_name: '何一',
        title: '为小型刊物建一座自己的房子',
        excerpt: '产权之外，还有维护成本。',
        kind: 'article',
        target_id: 'cnt_house',
      },
      read: true,
      read_at: daysAgo(9, 9),
      created_at: daysAgo(10, 10),
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'cnv_editorial',
      kind: 'group',
      created_by: 'usr_admin',
      members: ['usr_admin', 'usr_editor', 'usr_chen', 'usr_su'],
      title: '编辑部 · 十月',
      last_message: '下周的审核排期要不要调整？',
      updated_at: daysAgo(1, 10),
      unread: 1,
    },
    {
      id: 'cnv_zw',
      kind: 'direct',
      created_by: 'usr_editor',
      members: ['usr_admin', 'usr_editor'],
      title: '周宛',
      last_message: '图床那篇我改完了，麻烦看一眼。',
      updated_at: daysAgo(0, 8),
      unread: 0,
    },
  ];

  const messages: Message[] = [
    {
      id: 'msg_1',
      conversation_id: 'cnv_editorial',
      sender_id: 'usr_admin',
      sender_name: '林知远',
      body: '这周的稿子我看了，两篇待审的都可以发，图片那篇等安全服务恢复。',
      created_at: daysAgo(2, 9),
    },
    {
      id: 'msg_2',
      conversation_id: 'cnv_editorial',
      sender_id: 'usr_editor',
      sender_name: '周宛',
      body: '好。审核手册那篇要不要压到下周？这周已经排了两篇。',
      created_at: daysAgo(2, 10),
    },
    {
      id: 'msg_3',
      conversation_id: 'cnv_editorial',
      sender_id: 'usr_chen',
      sender_name: '陈默',
      body: '我无所谓，听排期。',
      created_at: daysAgo(1, 9),
    },
    {
      id: 'msg_4',
      conversation_id: 'cnv_editorial',
      sender_id: 'usr_editor',
      sender_name: '周宛',
      body: '下周的审核排期要不要调整？',
      created_at: daysAgo(1, 10),
    },
    {
      id: 'msg_5',
      conversation_id: 'cnv_zw',
      sender_id: 'usr_editor',
      sender_name: '周宛',
      body: '图床那篇我改完了，麻烦看一眼。',
      created_at: daysAgo(0, 8),
    },
    {
      id: 'msg_6',
      conversation_id: 'cnv_zw',
      sender_id: 'usr_admin',
      sender_name: '林知远',
      body: '收到，下午看。安全检查那边我先去问一下。',
      created_at: daysAgo(0, 9),
    },
  ];

  const assets: Asset[] = [
    {
      id: 'ast_cover_1',
      storage_key: 'demo/cover-house.svg',
      mime_type: 'image/svg+xml',
      size: 18_432,
      scan_status: 'clean',
      file_name: 'cover-house.png',
      url: cover('Issue 01', '#3c4a3e'),
    },
    {
      id: 'ast_cover_2',
      storage_key: 'demo/cover-type.svg',
      mime_type: 'image/svg+xml',
      size: 21_004,
      scan_status: 'clean',
      file_name: 'cover-type.png',
      url: cover('Type', '#5c5142'),
    },
    {
      id: 'ast_cover_3',
      storage_key: 'demo/cover-community.svg',
      mime_type: 'image/svg+xml',
      size: 16_820,
      scan_status: 'clean',
      file_name: 'cover-community.png',
      url: cover('Community', '#4a4551'),
    },
  ];

  const activity: ActivityEntry[] = [
    {
      id: 'act_1',
      at: daysAgo(0, 9),
      actor: '周宛',
      action: '提交审核',
      target: '审核不是审查：一份社区编辑手册',
      detail: '等待编辑处理',
    },
    {
      id: 'act_2',
      at: daysAgo(0, 8),
      actor: '周宛',
      action: '更新草稿',
      target: '图片上传策略更新',
      detail: '安全检查未完成',
    },
    {
      id: 'act_3',
      at: daysAgo(2, 10),
      actor: '林知远',
      action: '发布',
      target: '独立出版的账本',
    },
    {
      id: 'act_4',
      at: daysAgo(3, 15),
      actor: '林知远',
      action: '修改站点设置',
      target: 'Practacu Press',
      detail: '发布模式：审核发布',
    },
    {
      id: 'act_5',
      at: daysAgo(6, 11),
      actor: '周宛',
      action: '退回',
      target: '关于（不）做算法推荐',
      detail: '与本月专题不符',
    },
    {
      id: 'act_6',
      at: daysAgo(12, 10),
      actor: '林知远',
      action: '发布',
      target: '为小型刊物建一座自己的房子',
    },
  ];

  return {
    version: 1,
    site,
    users,
    contents: [...contents, ...posts],
    comments,
    reactions: [
      { user_id: 'usr_su', target_type: 'article', target_id: 'cnt_house', kind: 'like' },
      { user_id: 'usr_chen', target_type: 'article', target_id: 'cnt_whitespace', kind: 'like' },
    ],
    bookmarks: [],
    follows: [
      { follower_id: 'usr_chen', followee_id: 'usr_admin' },
      { follower_id: 'usr_gu', followee_id: 'usr_admin' },
    ],
    conversations,
    messages,
    notifications,
    assets,
    activity,
    seeded_at: new Date().toISOString(),
  };
}

export function roleOf(state: DemoState, userId?: string | null): Role {
  const user = state.users.find((u) => u.id === userId);
  return user?.role ?? 'member';
}

export function toPublicUser(user: DemoUser): User {
  return {
    id: user.id,
    display_name: user.display_name,
    locale: user.locale,
    status: user.status,
    created_at: user.created_at,
  };
}

export function toMember(user: DemoUser): Member {
  return {
    user_id: user.id,
    display_name: user.display_name,
    role: user.role,
    status: user.status === 'active' ? 'active' : 'suspended',
    email: user.email,
  };
}
