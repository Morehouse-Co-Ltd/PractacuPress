/**
 * Practacu Press 前端类型。
 *
 * 全部来自 `packages/contracts/openapi/openapi.yaml`（v0.1.0）。
 * 带 `?` 的前端扩展字段只会在演示数据层出现；连接真实后端时按缺失处理，
 * 界面不得依赖它们完成权限或安全判断。
 */

import type { Locale } from './lib/i18n/locales';

export type Role = 'platform_admin' | 'site_admin' | 'editor' | 'member';
export type VisibilityMode = 'public' | 'members_only';
/**
 * 站点形态。
 * - community：访客可以自助注册，登录后评论、收藏与投稿；权限按权限组划分。
 * - personal：个人博客，关闭自助注册；站长可以在后台创建账户，所有账户都能进入后台。
 */
export type SiteKind = 'community' | 'personal';
export type PublishMode = 'open' | 'review' | 'role_based';
export type TargetType = 'article' | 'post' | 'comment' | 'user' | 'page';
export type ContentKind = 'article' | 'post';
export type SourceFormat = 'markdown' | 'html' | 'plain';
export type ContentStatus =
  | 'draft'
  | 'pending_review'
  | 'published'
  | 'rejected'
  | 'archived'
  | 'pending_security_check';
export type ContentAction =
  | 'submit'
  | 'publish'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'security-retry';
export type CommentStatus = 'visible' | 'hidden' | 'deleted' | 'pending_review';
export type ScanStatus = 'pending' | 'clean' | 'rejected' | 'needs_manual_review';
export type UploadStatus = 'pending' | 'uploaded' | 'completed' | 'expired';

export interface User {
  id: string;
  display_name: string;
  locale: string;
  status: 'active' | 'disabled';
  created_at: string;
}

export interface Session {
  user: User;
  token_type: 'Bearer';
  access_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  csrf_token: string;
}

export interface Me {
  user: User;
  role: Role;
  site_id: string;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  domain: string;
  visibility_mode: VisibilityMode;
  publish_mode: PublishMode;
  disabled: boolean;
  /** 设置接口接受 description，但 Site 响应未声明；连接真实后端时可能缺失。 */
  description?: string;
  /**
   * 站点是否开放自助注册（O-3）。
   *
   * 缺失时按开放处理：旧后端与升级前保存的配置都不带这个字段，误关注册比多显示
   * 一个注册入口代价大得多。
   */
  registration_open?: boolean;
}

/** 主域名的 TXT 归属验证信息（V-12）。 */
export interface SiteDomainVerification {
  domain: string;
  verified: boolean;
  verification_token: string;
  /** TXT 记录名，例如 _practacu-verify.press.example.com。 */
  record_name: string;
  /** 记录类型，后端固定返回 TXT。 */
  record_type: string;
}

/** 立即验证主域名归属的结果。 */
export interface SiteDomainVerificationResult {
  verified: boolean;
  domain: string;
}

export interface Member {
  user_id: string;
  display_name: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  email?: string;
}

/**
 * 公开作者资料：作者归档（/u/{id}）用。
 *
 * 只包含公开主页需要的信息，不返回邮箱、在线状态或私有设置。
 */
export interface PublicProfile {
  user_id: string;
  display_name: string;
  role: Role;
  created_at: string;
}

/** 管理员创建账户。 */
export interface NewMemberInput {
  email: string;
  display_name: string;
  password: string;
  /** 个人博客忽略该字段：所有账户都是最高管理员。 */
  role?: Role;
}

export interface Content {
  id: string;
  kind: ContentKind;
  status: ContentStatus;
  title: string;
  slug: string;
  summary?: string;
  source_format: SourceFormat;
  rendered_html: string;
  policy_version: string;
  published_at?: string;
  created_at: string;
  updated_at: string;
  actions: ContentAction[];
  /** 演示数据扩展：契约 v0.1.0 的 Content 不含作者字段。 */
  author_id?: string;
  author_name?: string;
  /** 演示数据扩展：契约没有读取草稿源文的端点，编辑时可能缺失。 */
  source_body?: string;
  category_id?: string;
  /** 文章标签以名称保存；主题与后台都按名称展示。 */
  tags?: string[];
}

export interface ContentPage {
  items: Content[];
  next_cursor: string;
  has_more: boolean;
}

export interface DraftInput {
  title: string;
  slug?: string;
  summary?: string;
  source_format?: SourceFormat;
  source_body: string;
  category_id?: string;
  tags?: string[];
}

export interface Comment {
  id: string;
  target_type: TargetType;
  target_id: string;
  parent_id?: string;
  depth: number;
  body: string;
  status: CommentStatus;
  /** 演示数据扩展：契约不返回评论作者。 */
  author_id?: string;
  author_name?: string;
  created_at?: string;
}

export interface ToggleResult {
  active: boolean;
}

export interface Upload {
  id: string;
  file_name: string;
  storage_key: string;
  status: UploadStatus;
  expires_at: string;
}

export interface Asset {
  id: string;
  storage_key: string;
  mime_type: string;
  size: number;
  scan_status: ScanStatus;
  scan_reason?: string;
  /** 展示地址：`/api/v1/media/{id}`。 */
  url?: string;
  file_name?: string;
  /** `GET /media` 返回：上传用途；早期数据可能没有这个字段。 */
  purpose?: StorageScope;
  /** `GET /media` 返回：上传时间。 */
  created_at?: string;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  created_by: string;
  members: string[];
  /** 演示数据扩展：契约不返回会话标题与最后一条消息。 */
  title?: string;
  last_message?: string;
  updated_at?: string;
  unread?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  sender_name?: string;
}

export interface Notification {
  id: string;
  type: string;
  /** 演示数据扩展：契约按当前用户过滤，不返回收件人字段。 */
  recipient_id?: string;
  actor_id?: string;
  subject_id?: string;
  payload: Record<string, string>;
  read: boolean;
  read_at?: string;
  created_at: string;
}

export interface AppEvent {
  id: string;
  type: string;
  occurred_at?: string;
  site_id: string;
  payload: Record<string, unknown>;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
  request_id: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string;
  has_more: boolean;
}

export interface ProbeResult {
  health: 'ok' | 'fail';
  ready: 'ready' | 'unready' | 'fail';
  openapi: boolean;
  detail?: string;
}

export interface CommentsResult {
  items: Comment[];
  /**
   * v0.1.0 契约只提供评论的创建 / 编辑 / 删除，没有列表端点。
   * 演示模式为 true；真实后端在补齐 `GET /comments` 之前为 false，界面需要明确告知。
   */
  supported: boolean;
}

/** 后台评论查询。 */
export interface CommentQuery {
  target_type?: TargetType;
  target_id?: string;
  status?: CommentStatus | 'all';
  /** 按正文与作者搜索。 */
  q?: string;
  limit?: number;
  cursor?: string;
}

/** 后台评论列表：比前台多出状态统计与服务端支持标记。 */
export interface CommentPage {
  items: Comment[];
  next_cursor: string;
  has_more: boolean;
  supported: boolean;
  counts?: Partial<Record<CommentStatus | 'all', number>>;
}

export type CommentModerationAction = 'approve' | 'hide' | 'delete';

export interface SessionState {
  status: 'loading' | 'ready' | 'anonymous';
  session: Session | null;
  me: Me | null;
  site: Site | null;
}

export type BackendMode = 'live' | 'demo';

export type HeadingFont = 'serif' | 'sans';

/** 明暗模式。夜航主题深色优先，纸白主题浅色优先；切换只换令牌不改结构。 */
export type ThemeMode = 'light' | 'dark';

/** 主题令牌键。完整令牌可由主题工坊逐项覆盖。 */
export type ThemeTokenKey =
  | 'background'
  | 'ink'
  | 'accent'
  | 'bg_subtle'
  | 'bg_sunken'
  | 'ink_soft'
  | 'muted'
  | 'faint'
  | 'line'
  | 'line_strong'
  | 'accent_soft'
  | 'accent_ink'
  | 'prose';

/** 布局变体：classic 编辑排版风（纸白），bento 杂志网格风（夜航）。 */
export type LayoutVariant = 'classic' | 'bento';

/** 区块入场动画。全部走 CSS 类，reduce 动效时自动降级。 */
export type BlockAnimation = 'none' | 'fade' | 'fade-up' | 'slide-left' | 'slide-right' | 'zoom';

/** 主题的柔化与过渡效果。 */
export interface ThemeSoftenSettings {
  /** 总开关；关闭时所有柔化变量归零。 */
  enabled: boolean;
  /** 强度 0–100：越大，背景光晕与组件混色越明显。 */
  strength: number;
  /** 背景与组件颜色过渡时长（毫秒）。 */
  transition_ms: number;
  /** 背景叠加柔光渐变。 */
  gradient: boolean;
  /** 卡片、面板与页头等组件混入主题色，削弱硬边界。 */
  blend_components: boolean;
  /** 柔化模糊半径（px），主要用于页头/浮层。 */
  blur: number;
}

export interface ThemeSettings {
  preset: string;
  mode: ThemeMode;
  background: string;
  ink: string;
  accent: string;
  /** 完整令牌覆盖（主题工坊的高级自定义）。键为 ThemeTokenKey。 */
  tokens?: Partial<Record<ThemeTokenKey, string>>;
  heading_font: HeadingFont;
  /** 正文（文章页）字号，14–20 px。 */
  body_size: number;
  /** 正文栏宽，640–860 px。 */
  content_width: number;
  /** 圆角基准，0–12 px。 */
  radius: number;
  /** 柔化与过渡；旧主题缺省时按关闭处理。 */
  soften: ThemeSoftenSettings;
}

/**
 * 外观分区：主题可以声明自己需要哪些外观设置。
 *
 * 外观页只渲染主题声明过的分区；没声明的分区隐藏，站长仍然可以通过
 * 「主题设置 → 导航与页脚」等入口改数据，只是不在外观页出现。
 */
export type AppearanceSectionId =
  | 'hero'
  | 'branding'
  | 'announcement'
  | 'custom_css';

/** 主题绑定的外观功能。缺省表示支持全部内置分区。 */
export interface ThemeAppearance {
  sections: AppearanceSectionId[];
}

/**
 * 一套“大主题”：完整配色与排版 + 布局变体。
 *
 * 原版（classic 单栏）与夜航（bento 双栏）是内置主题；导入、创建或另存的主题
 * 保存在 `SiteCustomization.themes`，选中 id 保存在 `active_theme`。
 */
export interface SiteTheme {
  id: string;
  name: string;
  note: string;
  variant: LayoutVariant;
  theme: ThemeSettings;
  /** 主题制作者声明的外观功能；缺省时按内置全集处理。 */
  appearance?: ThemeAppearance;
}

export type ExtensionId =
  | 'reading_progress'
  | 'toc'
  | 'code_copy'
  | 'share'
  | 'announcement'
  | 'back_to_top';

/* ------------------------------------------------------------------ *
 * 创作者扩展（沙箱运行）
 *
 * 内置扩展是随前端发布的能力开关；这里描述的是站长 / 创作者自己制作、
 * 通过清单导入的扩展。扩展只能声明挂载位置与受限能力，HTML / CSS / JS
 * 一律跑在 sandbox iframe 里，不接触主站 DOM 与登录态。
 * ------------------------------------------------------------------ */

/** 扩展在站点前台出现的位置。 */
export type ExtensionSlot =
  | 'site_header'
  | 'site_footer'
  | 'home_top'
  | 'home_bottom'
  | 'article_top'
  | 'article_bottom'
  | 'article_side'
  | 'floating';

/** 扩展声明自己适用于哪些页面；缺省是 all。 */
export type ExtensionPageScope = 'all' | 'home' | 'article' | 'list' | 'search';

/** 扩展可以申请的受限能力；没申请的能力在沙箱桥里直接拒绝。 */
export type ExtensionPermission =
  | 'notify'
  | 'open_link'
  | 'navigate'
  | 'clipboard'
  | 'theme'
  | 'storage';

/** 一个创作者扩展的完整清单。 */
export interface CustomExtension {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** 扩展管理页显示的单字符图标，留空用名称首字。 */
  icon?: string;
  enabled: boolean;
  slots: ExtensionSlot[];
  pages: ExtensionPageScope[];
  permissions: ExtensionPermission[];
  /** 沙箱正文 HTML，只在这个扩展自己的 iframe 里渲染。 */
  html: string;
  /** 沙箱样式，注入 iframe。 */
  css: string;
  /** 沙箱脚本，注入 iframe；可使用受限的 window.PP 桥。 */
  js: string;
  created_at: string;
  updated_at: string;
}

/** 扩展导入 / 导出文件的外层结构（`.ppext.json`）。 */
export interface ExtensionManifestFile {
  format: 'practacu-extension';
  version: 1;
  exported_at?: string;
  extension: CustomExtension;
}

/**
 * 文章自定义封面。
 *
 * 契约没有封面字段，而封面又是纯展示层的东西：这里按内容 id 存一份覆盖配置，
 * 列表卡片与详情页渲染时优先使用它，没有配置就继续用程序化封面。随
 * 「外观 → 导出配置」一起迁移。
 */
export interface ArticleCover {
  /** 内容 id（Content.id）。 */
  id: string;
  /** http(s) 地址、站内路径或以 data:image/ 开头的内联图片。 */
  url: string;
  alt?: string;
  /** 图片裁剪焦点，竖图通常需要顶部。 */
  position?: 'center' | 'top' | 'bottom';
  /** 勾选后列表与详情页都不显示封面（保留配置，可随时恢复）。 */
  hidden?: boolean;
}

/** 站点自定义页面。契约 v0.1.0 没有页面端点，页面存在本地安装配置里。 */
export interface SitePage {
  id: string;
  title: string;
  slug: string;
  summary?: string;
  /**
   * 旧版页面的 Markdown 正文。
   *
   * 页面内容现在只由「页面编排」的区块（layout.blocks）承载；这个字段仅用于
   * 读取旧数据时迁移成一个「文本」区块，保存页面时会被清空，前台不再渲染。
   */
  body: string;
  status: 'draft' | 'published';
  show_in_nav: boolean;
  created_at: string;
  updated_at: string;
  /** 页面模板（关于页 Bento / 友链墙 / 时间线 / 空白）。 */
  template?: string;
  /** 页面内容的组件编排；页面内容全部来自这里。 */
  layout?: ScreenLayout;
}

/** 首页精选网格里一格占几列几行。 */
export type TileSpan = '1x1' | '2x1' | '1x2' | '2x2';

/**
 * 置顶到首页的文章。
 *
 * 契约没有置顶端点，置顶名单和主题、页面一样只存在本地安装配置里（可随导出的 JSON 迁移）。
 * 只存 id 与占格，标题、封面、摘要渲染时从内容流里实时取，文章改了标题首页跟着变。
 */
export interface HomePin {
  id: string;
  span: TileSpan;
}

export interface ThemeSettings {
  preset: string;
  background: string;
  ink: string;
  accent: string;
  heading_font: HeadingFont;
  /** 正文（文章页）字号，14–20 px。 */
  body_size: number;
  /** 正文栏宽，640–860 px。 */
  content_width: number;
  /** 圆角基准，0–12 px。 */
  radius: number;
}

/** 首页首屏文案。留空表示使用站点默认值。 */
export interface HeroSettings {
  kicker: string;
  /** 支持换行；用 *文字* 标记斜体强调。 */
  title: string;
  lede: string;
}

/** 顶部导航里的二级入口。 */
export interface NavChild {
  id: string;
  label: string;
  /** 站内路径或 http(s) 外链；留空表示只显示文字。 */
  href: string;
  /** 内置图标名；留空不显示。 */
  icon?: string;
}

/** 二级导航的展示方式：横排胶囊栏，或下拉菜单。 */
export type NavSubStyle = 'bar' | 'dropdown';

/** 顶部导航图标相对文字的位置。 */
export type NavIconPosition = 'left' | 'right' | 'none';

/**
 * 顶部导航的一个 Tab。
 *
 * `href` 可以是站内路径（`/about`）或 http(s) 外链；留空时该 Tab 不可点击，
 * 用来做分组标题。文字、图标、二级入口与展示方式都由站长自己定。
 */
export interface NavTab {
  id: string;
  label: string;
  href: string;
  /** 内置图标名（见 navigation.ts 的 NAV_ICON_CHOICES）；留空不显示。 */
  icon?: string;
  /** 图标位置；缺省沿用 layout.nav_icon_position。 */
  icon_position?: NavIconPosition;
  /** 二级入口；有子项时可按 layout.nav_sub_style 渲染成二级栏或下拉菜单。 */
  children?: NavChild[];
  /** 该 Tab 的二级入口展示方式；缺省沿用 layout.nav_sub_style。 */
  sub_style?: NavSubStyle;
}

/** 页脚里的一个条目：文字 + 可选链接。 */
export interface FooterLink {
  id: string;
  label: string;
  /** 站内路径、http(s) 外链；留空表示只显示文字。 */
  href: string;
}

/** 软件 / 社交快捷链接的图标来源。 */
export type SocialPlatform =
  | 'github'
  | 'x'
  | 'mastodon'
  | 'rss'
  | 'email'
  | 'website'
  | 'custom';

/** 页头左上角或页脚底栏上方的一条快捷链接。 */
export interface SocialLink {
  id: string;
  platform: SocialPlatform;
  /** 显示文字；图标链接在页头只用作 aria-label/title。 */
  label: string;
  /** http(s) 外链、mailto: 或站内路径。 */
  url: string;
}

/** 页脚的一栏：标题 + 若干条目。 */
export interface FooterColumn {
  id: string;
  title: string;
  links: FooterLink[];
}

/**
 * 页头（最上方 Tab 栏）的样式变体。
 * - classic：整条吸顶，滚动后加一点阴影；
 * - transparent：页面顶部透明，向下滚动后恢复底色；
 * - float：滚动后收缩成一条悬浮圆角胶囊，可配高斯模糊。
 */
export type HeaderStyle = 'classic' | 'transparent' | 'float';

export interface LayoutSettings {
  brand_sub: string;
  show_articles: boolean;
  show_posts: boolean;
  show_search: boolean;
  /** 页头样式；缺省按经典吸顶。 */
  header_style?: HeaderStyle;
  /** 页头背景是否高斯模糊；缺省开启（与旧版观感一致）。 */
  header_blur?: boolean;
  /** 高斯模糊强度（px），4–24。 */
  header_blur_amount?: number;
  /** 向下滚动多少像素后切换到「滚动后」样式。 */
  header_threshold?: number;
  footer_text: string;
  /**
   * 顶部导航 Tab。
   * - 缺省（undefined）：自动模式，按 show_* 与「加入站点导航」的页面生成；
   * - 数组（可以为空）：完全按这里的条目渲染。
   */
  nav_tabs?: NavTab[];
  /** 顶部导航整体对齐方式；缺省或旧配置按左侧。 */
  nav_align?: 'left' | 'center' | 'right';
  /** 图标默认在文字左侧还是右侧；单个 Tab 可以覆盖。 */
  nav_icon_position?: NavIconPosition;
  /** 有二级入口时默认的展示方式：二级胶囊栏或下拉菜单。 */
  nav_sub_style?: NavSubStyle;
  /** 二级栏是否展示图标；下拉菜单始终展示已配置的图标。 */
  nav_sub_show_icons?: boolean;
  /**
   * 软件 / 社交快捷链接。
   * 夜航主题会显示在页头左上角品牌旁；所有主题都会在页脚最下方底栏上方显示。
   */
  social_links: SocialLink[];
  /** 页脚栏目。空数组表示页脚只保留品牌块与版权行。 */
  footer_columns: FooterColumn[];
  /** 页脚品牌区标题；留空使用站点名称。 */
  footer_brand_name: string;
  /** 页脚品牌区副标题；留空沿用品牌副标题（brand_sub）。 */
  footer_brand_sub: string;
  /** 页脚品牌区简介；留空使用站点简介。 */
  footer_brand_desc: string;
  /** 是否在页脚品牌区显示站点状态标签（公开浏览 / 审核发布等）。 */
  footer_show_tags: boolean;
  /** 自定义状态标签，用逗号或「、」分隔；留空时显示站点真实状态。 */
  footer_tags: string;
  /** 页脚最下方右侧的说明文字；留空隐藏。 */
  footer_note: string;
  /** 工信部 ICP 备案号，例如「京 ICP 备 00000000 号」。 */
  icp: string;
  /** 公安网备号，例如「京公网安备 11010502030123 号」。 */
  police: string;
  /** 公安网备图标地址；留空使用内置盾牌图标。 */
  police_icon?: string;
  /** 是否在页脚展示中国内地备案信息；海外站点可以保持关闭。 */
  show_filing: boolean;
  /** 站点图标（favicon）地址；留空使用内置图标。 */
  site_icon?: string;
  announcement: string;
  announcement_link: string;
  hero: HeroSettings;
  /** 布局变体。bento 下右栏常驻，侧栏开关被忽略。 */
  variant: LayoutVariant;
}

/* ---------- 人机验证 ---------- */

/**
 * 人机验证（CAPTCHA）设置。
 *
 * 契约 v0.1.0 没有验证端点，因此这里保存的是站点侧的配置意图：是否启用、
 * 用哪家服务与要保护哪些表单。密钥只用于生成服务端环境变量，不写入安装配置。
 */
export type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'recaptcha';

export interface HumanVerificationSettings {
  enabled: boolean;
  provider: HumanVerificationProvider;
  /** 前端可见的 Site Key。 */
  site_key: string;
  /** 要保护的表单场景。 */
  on_login: boolean;
  on_register: boolean;
  on_comment: boolean;
}

/* ---------- 评论 ---------- */

/**
 * 评论设置。契约 v0.1.0 没有站点级评论配置端点，因此和主题一样保存在本地安装配置里。
 * `require_review` 为真时，新评论进入 pending_review，需要通过后台「评论管理」放行。
 */
export interface CommentSettings {
  enabled: boolean;
  require_review: boolean;
  /** 评论须知，显示在评论框上方；留空则不显示。 */
  notice: string;
}

/* ---------- 权限组 ---------- */

/**
 * 权限组。个人博客固定只有 owner；社区站点分五组：
 * 游客（未登录）、成员、审核员、管理员、最高管理员。
 */
export type PermissionGroupId = 'guest' | 'member' | 'moderator' | 'admin' | 'owner';

/** 权限能力。界面上的按钮、导航与页面访问统一按能力判断。 */
export type CapabilityId =
  | 'read_content'
  | 'comment'
  | 'write_content'
  | 'moderate_content'
  | 'moderate_comment'
  | 'manage_member'
  | 'manage_site'
  | 'manage_permission'
  | 'view_log';

export interface PermissionGroup {
  /** 该组账户可以进入管理后台。游客没有账户，此字段恒为 false。 */
  admin_access: boolean;
  capabilities: Record<CapabilityId, boolean>;
}

export type PermissionSettings = Record<PermissionGroupId, PermissionGroup>;

/** 组件通用外观：圆角档位。 */
export type BlockRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';

/** 组件通用外观：阴影档位。 */
export type BlockShadow = 'none' | 'sm' | 'md' | 'lg' | 'glow';

/**
 * 组件通用外观：裁剪方式。
 * `clip` 只裁掉溢出内容；比例值额外设置 aspect-ratio，相当于一个相框。
 */
export type BlockCrop = 'none' | 'clip' | '16:9' | '4:3' | '3:2' | '1:1' | '2:1';

/**
 * 组件通用外观。
 *
 * 全部字段都是受限枚举或标量，随区块一起 JSON 序列化；渲染时只变成最外层
 * `<section class="pp-block">` 上的内联样式，不生成全局样式表，因此不会影响
 * 其他区块，也仍然允许 `custom_css` 覆盖。
 */
export interface BlockAppearance {
  radius?: BlockRadius;
  shadow?: BlockShadow;
  crop?: BlockCrop;
  /** `#rgb` / `#rrggbb` / `#rrggbbaa`；空表示透明。 */
  background?: string;
  /** 0–64 px；0 表示不额外留白。 */
  padding?: number;
  /** 用主题细分割线描一圈边框。 */
  border?: boolean;
}

/**
 * 无代码区块实例：一个默认组件 + 自己的命名、属性覆盖与入场动画。
 * 属性值只允许标量，保证配置可 JSON 序列化、可导入导出。
 */
export interface BlockInstance {
  id: string;
  type: string;
  /** 后台里的显示名，方便在长编排里认出它。 */
  title: string;
  props: Record<string, string | number | boolean>;
  animation: BlockAnimation;
  hidden: boolean;
  /**
   * 在夜航双栏布局里的位置：整幅（横跨两栏）/ 主栏 / 侧栏。
   * 缺省时按区块类型的默认值决定（见 lib/blocks.ts 的 resolveArea）。
   */
  area?: BlockArea;
  /** 容器类区块的子区块。没有该字段就是普通平铺区块。 */
  children?: BlockInstance[];
  /** 在分栏容器里的列号，从 1 开始；根级区块忽略。 */
  column?: number;
  /** 编排器里直接拖拽调整的宽度（px）；缺省表示撑满可用宽度。 */
  width?: number;
  /** 编排器里直接拖拽调整的最小高度（px）。 */
  height?: number;
  /** 组件级 CSS 声明，只作用于这个区块本身。 */
  custom_css?: string;
  /** 通用外观（圆角、阴影、裁剪、背景、内边距、描边）；缺省表示出厂观感。 */
  appearance?: BlockAppearance;
  /**
   * 归一化时无法识别的区块类型：保留原样、不渲染、保存时写回。
   * 这样从更新版本导出的设计不会因为本版本不认识而在下一次保存时永久消失。
   */
  unsupported?: boolean;
}

/** 夜航双栏布局的落位。 */
export type BlockArea = 'full' | 'main' | 'side';

/** 页面编排里可单独设置的设备。 */
export type BuilderDevice = 'desktop' | 'tablet' | 'mobile';

/** 一个界面的组件编排。 */
export interface ScreenLayout {
  blocks: BlockInstance[];
  /**
   * 开启「不同设备分割」后为 true：桌面 / 平板 / 手机各有一份独立编排。
   * 关闭或不存在的旧配置继续共用 blocks。
   */
  device_split?: boolean;
  /** 各设备的独立编排；缺失的设备回退到桌面，再回退到 blocks。 */
  devices?: Partial<Record<BuilderDevice, { blocks: BlockInstance[] }>>;
}

/* ---------- 思维链（无代码逻辑） ---------- */

export type LogicTriggerType =
  | 'page_load'
  | 'scroll_depth'
  | 'idle'
  | 'click_block'
  | 'hover_block'
  | 'dark_on'
  | 'dark_off'
  | 'always';

export type LogicConditionType =
  | 'is_mobile'
  | 'is_desktop'
  | 'is_logged_in'
  | 'is_anonymous'
  | 'is_personal'
  | 'is_dark'
  | 'is_light'
  | 'is_home';

export type LogicActionType =
  | 'show_block'
  | 'hide_block'
  | 'pulse_block'
  | 'animate_block'
  | 'scroll_to_block'
  | 'switch_mode'
  | 'open_search'
  | 'open_command';

export interface LogicStep {
  id: string;
  kind: 'trigger' | 'condition' | 'action';
  type: string;
  config: Record<string, string | number | boolean>;
}

/** 一条思维链：触发 → 若干条件 → 若干动作，全部满足才执行。 */
export interface LogicChain {
  id: string;
  name: string;
  enabled: boolean;
  steps: LogicStep[];
}

export interface LogicSettings {
  chains: LogicChain[];
}

export type AuthProviderId = 'phone' | 'google' | 'github' | 'wechat';

/**
 * 一种额外的登录方式。client_id / redirect_uri / scope / note 都是非机密配置，
 * 会随安装配置保存在浏览器；Client Secret、短信密钥只应存在于服务端。
 */
export interface AuthProviderSettings {
  enabled: boolean;
  /** 手机：短信签名；OAuth：Client ID / AppID。 */
  client_id: string;
  /** OAuth 回调地址；手机验证码留空。 */
  redirect_uri: string;
  /** 手机：模板编号；OAuth：scope。 */
  extra: string;
  /** 备注：短信服务商、公众号类型等，只用于显示。 */
  note: string;
}

export type AuthSettings = Record<AuthProviderId, AuthProviderSettings>

/**
 * 服务端邮件（SMTP）配置的非机密部分。
 *
 * 与登录方式一样，密码只用于生成 .env 片段，不写入浏览器配置；这里存的是站长填过的
 * 主机、端口、加密方式与发件人，方便下次打开后台时还原表单。
 */
export interface MailSettings {
  /** 站长的意愿：是否开放找回密码。真实能否发信仍由服务端 SMTP 决定。 */
  enabled: boolean;
  host: string;
  port: string;
  encryption: MailEncryption;
  username: string;
  from: string;
  from_name: string;
  /** 对外站点地址，用于重置链接；留空表示使用请求来源。 */
  public_base_url: string;
}

export type MailEncryption = 'starttls' | 'ssl' | 'none';

/** 服务端是否具备找回密码能力。来自 GET /auth/password-reset/policy。 */
export interface PasswordResetPolicy {
  enabled: boolean;
  delivery: 'email';
  /** 重置链接有效期（秒）。 */
  expires_in: number;
  /** 同一账户两次请求之间的最小间隔（秒）。 */
  cooldown: number;
}

export interface PasswordResetTicket {
  status: 'accepted';
  delivery: 'email';
  expires_in: number;
  /**
   * 仅演示模式返回：没有真实邮件服务时，前端直接把令牌交回给用户，
   * 让「忘记密码」流程在本地也能完整走通。
   */
  token?: string;
}

export interface SiteCustomization {
  /**
   * 站点语言：`zh-CN` 或 `en`。
   *
   * 站点级设置，不是访客级偏好；旧配置没有这个字段，`readCustomization`
   * 会归一化成简体中文。它随站点设计一起存到服务端，所以换浏览器、换设备
   * 看到的语言是一致的。
   */
  language?: Locale;
  theme: ThemeSettings;
  layout: LayoutSettings;
  /** 当前选中的大主题 id：default、night 或自定义主题 id。 */
  active_theme?: string;
  /** 导入或另存的自定义大主题。 */
  themes?: SiteTheme[];
  /** 首页组件编排。空数组表示按布局变体使用默认编排。 */
  home: ScreenLayout;
  /** 文章详情页附加区块编排；在文章正文之后、评论区之前渲染。 */
  article?: ScreenLayout;
  pages: SitePage[];
  /** 置顶到首页的文章（按数组顺序排版），在「内容库」里勾选。 */
  pins: HomePin[];
  /** 文章自定义封面：按内容 id 覆盖程序化封面。 */
  covers: ArticleCover[];
  /** 内置扩展开关。 */
  extensions: Record<ExtensionId, boolean>;
  /** 创作者制作 / 导入的沙箱扩展。 */
  custom_extensions: CustomExtension[];
  /** 思维链（无代码逻辑）。 */
  logic: LogicSettings;
  /** 站点设置 · 人机验证（CAPTCHA）意图配置。 */
  verification: HumanVerificationSettings;
  /** 评论开关、先审后发与评论须知。 */
  comments: CommentSettings;
  /** 分类与标签；契约 v0.1.0 没有分类端点，因此与外观一起保存在本地配置。 */
  taxonomy: TaxonomySettings;
  /** 社区站点的权限组配置；个人博客忽略这份配置，所有账户都是最高权限。 */
  permissions: PermissionSettings;
  /** 搜索引擎与分享卡片的站点级设置。 */
  seo: SeoSettings;
  custom_css: string;
}

/** 分类或标签。两者结构相同，只是用途不同。 */
export interface TaxonomyTerm {
  id: string;
  name: string;
  slug: string;
  description?: string;
  /** 只有分类使用颜色，用来在列表和卡片上区分。 */
  color?: string;
}

export interface TaxonomySettings {
  categories: TaxonomyTerm[];
  tags: TaxonomyTerm[];
}

export type TaxonomyKind = 'category' | 'tag';

export interface TaxonomyTermInput {
  kind: TaxonomyKind;
  name: string;
  slug: string;
  description?: string;
  color?: string;
}

/**
 * 站点级 SEO 设置。
 *
 * 单页应用没有服务端模板，这些值由前端在渲染时写入 <head>：爬虫执行 JS 时能读到，
 * 社交平台的抓取器大多不执行 JS，所以分享卡片的最终效果仍取决于托管方是否预渲染。
 */
export interface SeoSettings {
  /** 标题模板，支持 {title} 与 {site}。 */
  title_template: string;
  /** 站点默认描述，文章没有摘要时使用。 */
  default_description: string;
  keywords: string;
  /** 默认分享图，支持绝对地址与站内路径。 */
  share_image: string;
  /** Twitter / X 账号，带不带 @ 都可以。 */
  twitter: string;
  /** 是否允许搜索引擎收录；关闭时全站输出 noindex。 */
  indexable: boolean;
  /** 生成 canonical 与 sitemap 时使用的站点地址；留空取当前访问地址。 */
  canonical_base: string;
  /** 发布者名称，写入结构化数据。 */
  publisher: string;
  verification: {
    google: string;
    baidu: string;
    bing: string;
  };
}

/* ---------- 访问限制 / 域名绑定 / 性能优化 / 加载动画 ---------- */

/**
 * 一条访问限制规则。
 *
 * 浏览器端按滑动窗口统计；真正的 IP 级限制仍由反向代理或 API 的
 * `RATE_LIMIT_PER_MINUTE` 执行，后台会生成对应的配置片段。
 */
export interface RateRule {
  enabled: boolean;
  /** 一个窗口内允许的次数。 */
  limit: number;
  /** 滑动窗口长度（秒）。 */
  window_seconds: number;
  /** 触发后临时拒绝访问的时长（秒）。 */
  block_seconds: number;
}

export type AccessReason = 'page_switch' | 'request' | 'tabs';

/** 访问限制（浏览器端保护 + 网关配置生成）。 */
export interface AccessSettings {
  /** 总开关。关闭时三条浏览器端规则都不生效。 */
  enabled: boolean;
  /** 限制一段时间内切换页面的次数。 */
  page_switch: RateRule;
  /** 限制页面脚本发起的后端请求次数。 */
  requests: RateRule;
  /** 同一浏览器同时打开的站点标签页数量；网关里对应每 IP 并发连接。 */
  tabs: { enabled: boolean; limit: number };
  /** 触发限制时给访客看的提示。 */
  message: string;
}

/** TLS 证书配置；只保存部署意图与服务器上的证书路径，不保存私钥内容。 */
export interface TlsSettings {
  /** off：只用 HTTP；letsencrypt：certbot 自动签发；manual：已有证书文件。 */
  mode: 'off' | 'letsencrypt' | 'manual';
  /** Let's Encrypt 通知邮箱。 */
  email: string;
  /** 手动证书的 fullchain 路径（服务器上）。 */
  cert_path: string;
  /** 手动证书的私钥路径（服务器上）。 */
  key_path: string;
  /** 生成网关配置时附加 HSTS。 */
  hsts: boolean;
}

/** 域名绑定白名单与网关配置。 */
export interface DomainSettings {
  enabled: boolean;
  /** 主域名快照；真实主域名以 Site.domain 为准，可在「访问与域名」直接设置。 */
  primary: string;
  /** 额外允许的域名，支持 `*.example.com`。 */
  aliases: string[];
  /** 把 `www.example.com` 视为主域名的别名。 */
  allow_www: boolean;
  /** 本地开发时允许 localhost / 127.0.0.1。 */
  allow_localhost: boolean;
  /** 允许直接通过 IP 访问。 */
  allow_ip: boolean;
  /** 生成网关配置时把别名域名 301 到主域名。 */
  redirect_primary: boolean;
  /** 生成网关配置时强制 HTTPS。 */
  https_only: boolean;
  /** TLS 证书配置。 */
  tls: TlsSettings;
  /** 允许跨域调用 API 的浏览器来源；留空时由绑定域名推导。 */
  cors_origins: string[];
  /** 站点 Cookie 作用域，例如 `.example.com`；留空表示仅当前主机。 */
  cookie_domain: string;
  /** 反向代理地址/CIDR；用于 API 识别真实客户端 IP。 */
  trusted_proxies: string[];
}

/**
 * 性能优化。
 *
 * 重点不是“看起来更快”，而是减少 API、数据库和静态资源的压力：限制首屏读取量、
 * 合并重复请求、懒加载媒体，并把网关/API 的超时、缓存与连接池参数生成到可部署的
 * 配置片段里。服务器参数仍需部署方应用（写进 .env 或 Nginx 后重启）。
 */
export interface PerformanceSettings {
  /** 首页与模板页一次读取的内容条数。 */
  feed_limit: number;
  /** 归档页每页条数。 */
  archive_limit: number;
  /** 对 GET 请求做去重与短缓存，减少重复请求和服务端查询。 */
  request_cache: boolean;
  /** 短缓存时间（秒）。 */
  cache_ttl: number;
  /** 视频、嵌入站点与图片的懒加载；减少首屏带宽。 */
  lazy_media: boolean;
  /** 关闭前台入场动画、过渡与平滑滚动。 */
  disable_animations: boolean;
  /** 需要提前建立连接的外部来源，例如字体或图床地址。 */
  preconnect: string[];
  /** 生成网关配置时开启 gzip。 */
  gzip: boolean;
  /** 带 hash 静态资源的缓存天数。 */
  static_cache_days: number;
  /** 网关 keepalive 秒数。 */
  keepalive_timeout: number;
  /** 网关允许的请求体上限（MB）；过小会影响上传，过大会占内存。 */
  client_max_body_size_mb: number;
  /** 网关读超时（秒），避免慢请求长期占用连接。 */
  proxy_read_timeout: number;
  /** API 读超时（秒）。 */
  api_read_timeout: number;
  /** API 空闲连接超时（秒）。 */
  api_idle_timeout: number;
  /** 数据库最大打开连接数；0 表示按驱动默认。 */
  db_max_open_conns: number;
  /** 数据库最大空闲连接数；0 表示按驱动默认。 */
  db_max_idle_conns: number;
  /** 数据库连接最长生命周期（秒）。 */
  db_conn_max_lifetime: number;
}

export type StorageDriver = 'local' | 's3';

/** 存储用途：文章媒体、站点图片、用户头像、用户数据/附件。 */
export type StorageScope = 'content' | 'site' | 'avatar' | 'attachment';

/**
 * 一套命名的储存策略。
 *
 * 浏览器只能记录部署意图：真正用到哪种存储由 API 进程启动时的 `STORAGE_*`
 * 环境变量决定。后台把「策略 + 用途分配」翻译成可直接粘贴的 `.env` 片段，
 * 切换后需要重启 API，已有文件不会自动搬家。云对象存储兼容任何 S3 实现
 * （AWS S3、MinIO、阿里云 OSS、腾讯云 COS 等）；公开读权限与防盗链由桶策略
 * 或 CDN 决定。
 */
export interface StorageStrategy {
  /** 稳定 id，只允许小写字母、数字、下划线与连字符；用途用它引用策略。 */
  id: string;
  /** 展示名，必填且唯一，最多 40 个字符。 */
  name: string;
  /** 本地存储或 S3 兼容云对象存储。 */
  driver: StorageDriver;
  /** driver=local 时的本地目录；相对路径基于 API 进程的工作目录。 */
  local_dir: string;
  /** driver=s3 时的桶名；云策略必填。 */
  s3_bucket: string;
  /** driver=s3 时的对象键前缀，同一桶多站点时用来隔离。 */
  s3_prefix: string;
  /** S3 兼容端点；AWS 留空，MinIO / OSS / COS 填各自地址。 */
  s3_endpoint: string;
  /** 区域；SDK 对 MinIO 也要求一个值，留空时按 us-east-1 处理。 */
  s3_region: string;
  /**
   * 访问密钥 ID。可以保存在本地安装配置里；密钥（secret）不保存，
   * 只存在于页面的组件状态，用于生成 `.env` 片段。
   */
  s3_access_key: string;
  /**
   * 期望的公开访问前缀（例如 CDN 域名）。
   *
   * 仅用于前端记录与排查，API 不读取这个值；公开读权限由桶策略或 CDN 决定。
   */
  s3_public_base_url: string;
}

/**
 * 媒体储存设置。
 *
 * `strategies` 是用户自己增删改的命名策略；`scopes` 把四个用途各自指向一套
 * 策略的 id。旧版配置（全局 driver + 分用途覆盖）由 `normalizeStorage()`
 * 迁移成这个形状，因此页面永远只需要处理这里的一种模型。
 */
export interface StorageSettings {
  /** 至少一套，最多 8 套。 */
  strategies: StorageStrategy[];
  /** 值 = strategies 里某个策略的 id；四个键必须齐全且都是合法 id。 */
  scopes: Record<StorageScope, string>;
  /** 仅前端提示：期望的单文件上限（MB）。真正的上限由 API 与安全服务决定。 */
  max_upload_mb: number;
}

export type LoadingPreset =
  | 'spinner'
  | 'dots'
  | 'pulse'
  | 'bar'
  | 'orbit'
  | 'skeleton'
  | 'shimmer'
  | 'skeleton-shimmer';

/** 站点前台加载动画。 */
export interface LoadingSettings {
  enabled: boolean;
  preset: LoadingPreset;
  text: string;
  /** 强调色跟随主题，或使用自定义颜色。 */
  accent_mode: 'theme' | 'custom';
  accent: string;
  /** 背景跟随主题，或使用自定义颜色。 */
  background_mode: 'theme' | 'custom';
  background: string;
  /** 动画图形尺寸（px）。 */
  size: number;
  /** 最短展示时长（ms），避免一闪而过。 */
  min_duration_ms: number;
  /** 首次打开站点时显示。 */
  show_on_first_load: boolean;
  /** 站点内切换页面时显示。 */
  show_on_navigation: boolean;
  /** 只作用于加载画面的附加 CSS。 */
  custom_css: string;
}

export interface WebConfig {
  version: 1;
  setup_complete: boolean;
  mode: BackendMode;
  api_base: string;
  site_id: string;
  database: 'sqlite' | 'mysql' | 'postgres';
  created_at: string;
  docs_url: string;
  /** 旧配置没有这个字段，按社区站点处理。 */
  site_kind?: SiteKind;
  /** 站长登录邮箱：只用于个人博客的登录提示与前端校验，不是凭据。 */
  owner_email?: string;
  /** 后台入口地址别名，例如 /manage；缺省为 /admin。 */
  admin_path?: string;
  /**
   * 匿名访客的只读配置：由启动探测（`lib/visitorBootstrap.ts`）构造，只存在内存里。
   *
   * 带这个标记的配置不写回 localStorage，也不参与「安装校验 / 设计水合 / 设计回写」，
   * 避免把访客浏览器误当成一次真实安装。
   */
  visitor?: boolean;
  /** 匿名访客的站点名：真实 Site 对象要登录后才能拿到，访客用 setup/status 的结果。 */
  visitor_site_name?: string;
  /**
   * 匿名访客看到的注册开关（来自 setup/status 的 registration_open）。
   *
   * 缺省表示旧后端：按开放处理；false 时前台隐藏注册入口、注册页显示关闭提示。
   */
  visitor_registration_open?: boolean;
  /** 主题、页面与扩展。旧配置缺省时按默认外观处理。 */
  customization?: SiteCustomization;
  /** 邮箱之外的登录方式。旧配置缺省时全部关闭。 */
  auth?: AuthSettings;
  /** 服务端邮件（SMTP）的非机密配置；密码不在这里。 */
  mail?: MailSettings;
  /** 访问限制（浏览器端）与网关配置生成。旧配置缺省时关闭保护。 */
  access?: AccessSettings;
  /** 域名绑定白名单。旧配置缺省时不做域名校验。 */
  domains?: DomainSettings;
  /** 前端性能优化开关。旧配置缺省时使用稳妥默认值。 */
  performance?: PerformanceSettings;
  /** 媒体存储策略（本地目录 / S3 兼容）；旧配置缺省时使用本地目录。 */
  storage?: StorageSettings;
  /** 站点前台加载动画。旧配置缺省时关闭。 */
  loading?: LoadingSettings;
  /**
   * 切到个人博客前的角色快照。个人博客会把所有账户提升为站点管理员，
   * 这里记住原角色，切回社区站点时逐一恢复。
   */
  role_snapshot?: Record<string, Role>;
}

export interface ActivityEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: string;
}
