import { useCallback, useEffect, useState } from 'react';
import type {
  BackupArtifact,
  Comment,
  Content,
  ContentKind,
  ImportConflictStrategy,
  SiteImportReport,
  TaxonomySettings,
} from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import { errorText, getLocale, useT } from '../../lib/i18n';
import { useTitle } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { formatBytes, formatDateTime } from '../../lib/format';
import { siteOrigin } from '../../lib/seo';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, Field, Input, Select, Toggle } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useStepUp } from '../../lib/stepUp';
import { RoleGate } from '../../components/Guards';
import {
  buildTypechoXml,
  buildWordPressWxr,
  exportFilename,
  normalizeSlug,
  parseImportXml,
  uniqueSlug,
  type ExportPayload,
  type ImportFormat,
  type ImportWarning,
  type IoComment,
  type IoContent,
  type ParsedImport,
} from '../../lib/wordpressIo';

/** 把一次下载的 blob 交给浏览器保存；文件名由服务端 Content-Disposition 提供。 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 分页拉取的上限；200 页 × 100 条远超正常站点规模，用来兜底坏游标。 */
const MAX_PAGES = 200;

/** 导入 XML 的大小上限：浏览器里解析，过大的文件会卡住页面。 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** 后端正文上限（与编辑器一致）；超出的导入内容截断并逐条说明。 */
const MAX_BODY_LENGTH = 200_000;

type WpAction = 'imported' | 'published' | 'submitted' | 'skipped' | 'failed';

interface WpImportItem {
  title: string;
  slug: string;
  kind: ContentKind;
  action: WpAction;
  /** 该条内容成功挂上的评论数。 */
  comments: number;
  reason?: string;
}

interface WpImportReport {
  format: ImportFormat;
  imported: number;
  published: number;
  submitted: number;
  skipped: number;
  failed: number;
  commentsImported: number;
  commentsSkipped: number;
  items: WpImportItem[];
  warnings: string[];
}

/** 数据与备份：全站导出/导入，WordPress / Typecho XML 迁移，以及平台管理员可见的实例备份。 */
export function DataPage() {
  const t = useT();
  const { site, me } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { ensureStepUp } = useStepUp();
  const { customization } = useCustomization();
  const demo = isDemo(backend);
  const canTransfer = !demo && typeof backend.exportSite === 'function';
  const platformAdmin = me?.role === 'platform_admin' && typeof backend.createBackup === 'function';
  useTitle(t('数据与备份'));
  const origin = siteOrigin(customization.seo, window.location.origin);

  const [publishedOnly, setPublishedOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const [importFile, setImportFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<ImportConflictStrategy>('rename');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<SiteImportReport | null>(null);

  // ---- WordPress / Typecho 导出 ----
  const [wpFormat, setWpFormat] = useState<ImportFormat>('wordpress-wxr');
  const [wpScope, setWpScope] = useState<'all' | ContentKind>('all');
  const [wpPublishedOnly, setWpPublishedOnly] = useState(false);
  const [wpWithComments, setWpWithComments] = useState(true);
  const [wpExporting, setWpExporting] = useState(false);
  const [wpExportNote, setWpExportNote] = useState('');

  // ---- WordPress / Typecho 导入 ----
  const [wpFile, setWpFile] = useState<File | null>(null);
  const [wpParsing, setWpParsing] = useState(false);
  const [wpParsed, setWpParsed] = useState<ParsedImport | null>(null);
  const [wpParseError, setWpParseError] = useState('');
  const [wpImportChoice, setWpImportChoice] = useState<'draft' | 'submit' | 'publish'>('draft');
  const [wpImportComments, setWpImportComments] = useState(true);
  const [wpImporting, setWpImporting] = useState(false);
  const [wpProgress, setWpProgress] = useState<{ done: number; total: number } | null>(null);
  const [wpImportReport, setWpImportReport] = useState<WpImportReport | null>(null);

  const [backups, setBackups] = useState<BackupArtifact[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [downloadingBackup, setDownloadingBackup] = useState('');
  const [backupError, setBackupError] = useState('');

  const loadBackups = useCallback(async () => {
    if (!platformAdmin || !backend.backups) return;
    setLoadingBackups(true);
    setBackupError('');
    try {
      setBackups(await backend.backups());
    } catch (err) {
      setBackupError(errorText(err));
    } finally {
      setLoadingBackups(false);
    }
  }, [backend, platformAdmin]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  const exportSite = async () => {
    if (!site || !backend.exportSite) return;
    setExporting(true);
    setError('');
    try {
      const { blob, filename } = await backend.exportSite(site.id, { publishedOnly });
      saveBlob(blob, filename);
      toast.push('ok', t('导出完成'), t('已下载 {name}', { name: filename }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setExporting(false);
    }
  };

  const importSite = async () => {
    if (!site || !importFile || !backend.importSite) return;
    // 导入会写入（覆盖时还会替换已有内容），必须先通过二次验证；取消则什么都不做。
    const ok = await ensureStepUp(
      conflict === 'overwrite' ? t('覆盖导入站点数据') : t('导入站点数据'),
    );
    if (!ok) return;
    setImporting(true);
    setError('');
    setReport(null);
    try {
      const result = await backend.importSite(site.id, importFile, { conflict });
      setReport(result);
      if (result.failed > 0) {
        toast.push(
          'info',
          t('导入完成，但有 {failed} 条失败', { failed: result.failed }),
          t('成功 {imported} · 覆盖 {overwritten} · 跳过 {skipped}', {
            imported: result.imported,
            overwritten: result.overwritten,
            skipped: result.skipped,
          }),
        );
      } else {
        toast.push(
          'ok',
          t('导入完成'),
          t('成功 {imported} · 覆盖 {overwritten} · 跳过 {skipped}', {
            imported: result.imported,
            overwritten: result.overwritten,
            skipped: result.skipped,
          }),
        );
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setImporting(false);
    }
  };

  /* ------------------------ WordPress / Typecho 迁移 ------------------------ */

  /** 按游标拉完某种内容的全部条目；坏游标最多翻 MAX_PAGES 页。 */
  const loadAllContent = async (kinds: ContentKind[]): Promise<Content[]> => {
    const collected: Content[] = [];
    for (const kind of kinds) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await backend.listContent(kind, { limit: 100, cursor });
        collected.push(...result.items);
        if (!result.has_more || !result.next_cursor) break;
        cursor = result.next_cursor;
      }
    }
    return collected;
  };

  /** 后台评论列表同样按游标拉全；后端没有该端点时返回 supported=false。 */
  const loadAllComments = async (): Promise<{ comments: Comment[]; supported: boolean }> => {
    const collected: Comment[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await backend.allComments({ status: 'all', limit: 100, cursor });
      if (!result.supported) return { comments: [], supported: false };
      collected.push(...result.items);
      if (!result.has_more || !result.next_cursor) break;
      cursor = result.next_cursor;
    }
    return { comments: collected, supported: true };
  };

  const exportWp = async () => {
    if (!site || !canTransfer || wpExporting) return;
    setWpExporting(true);
    setWpExportNote('');
    setError('');
    try {
      const kinds: ContentKind[] = wpScope === 'all' ? ['article', 'post'] : [wpScope];
      const all = await loadAllContent(kinds);
      const selected = wpPublishedOnly
        ? all.filter((item) => item.status === 'published')
        : all;

      // 分类名用于 WXR 的 <category>；读不到时不影响导出，只是分类留空。
      let taxonomy: TaxonomySettings | null = null;
      try {
        taxonomy = await backend.taxonomy(site.id);
      } catch {
        taxonomy = null;
      }
      const categoryNames = new Map(
        (taxonomy?.categories ?? []).map((term) => [term.id, term.name]),
      );

      let comments: Comment[] = [];
      let commentsSupported = true;
      if (wpWithComments) {
        try {
          const loaded = await loadAllComments();
          comments = loaded.comments;
          commentsSupported = loaded.supported;
        } catch {
          // 旧后端可能直接 404：评论是可选内容，不因为它让整个导出失败。
          comments = [];
          commentsSupported = false;
        }
      }

      const contentIds = new Set(selected.map((item) => item.id));
      const ioComments: IoComment[] = comments
        .filter(
          (comment) =>
            comment.status !== 'deleted' &&
            contentIds.has(comment.target_id) &&
            (comment.target_type === 'article' || comment.target_type === 'post'),
        )
        .map((comment) => ({
          content_id: comment.target_id,
          id: comment.id,
          parent_id: comment.parent_id,
          author: comment.author_name ?? '',
          body: comment.body,
          created_at: comment.created_at,
          approved: comment.status === 'visible',
        }));

      const items: IoContent[] = selected.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        slug: item.slug,
        summary: item.summary,
        html: item.rendered_html || item.source_body || '',
        source: item.source_body,
        source_format: item.source_format,
        status: item.status,
        published_at: item.published_at,
        created_at: item.created_at,
        updated_at: item.updated_at,
        tags: item.tags,
        category: item.category_id ? categoryNames.get(item.category_id) : undefined,
        author: item.author_name,
      }));

      const exportPayload: ExportPayload = {
        siteName: site.name,
        siteUrl: origin,
        siteDescription: site.description,
        language: getLocale(),
        authorName: me?.user.display_name,
        origin,
        items,
        comments: ioComments,
        generatedAt: new Date(),
      };
      const xml =
        wpFormat === 'wordpress-wxr'
          ? buildWordPressWxr(exportPayload)
          : buildTypechoXml(exportPayload);
      const filename = exportFilename(wpFormat);
      saveBlob(new Blob([xml], { type: 'application/xml;charset=utf-8' }), filename);

      const notes: string[] = [];
      if (!items.length) notes.push(t('没有符合条件的内容，文件里只有站点信息。'));
      if (wpWithComments && !commentsSupported) {
        notes.push(t('当前后端没有评论列表接口，本次导出不含评论。'));
      }
      if (wpWithComments && commentsSupported && ioComments.length !== comments.length) {
        notes.push(
          t('只导出了与所选内容关联的 {count} 条评论。', { count: ioComments.length }),
        );
      }
      notes.push(
        t('XML 不含媒体文件：正文里的图片已改写为绝对地址，WordPress / Typecho 导入后需要抓取或重新上传。'),
      );
      setWpExportNote(notes.join(' '));
      toast.push('ok', t('导出完成'), t('已下载 {name}', { name: filename }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWpExporting(false);
    }
  };

  /** 选择文件后立即解析并预览；解析失败只影响导入面板，不写任何数据。 */
  const parseWpFile = async (file: File) => {
    setWpParsing(true);
    setWpParseError('');
    setWpParsed(null);
    setWpImportReport(null);
    try {
      if (file.size > MAX_IMPORT_BYTES) {
        setWpParseError(t('XML 文件不能超过 20 MB。'));
        return;
      }
      const xml = await file.text();
      const parsed = parseImportXml(xml);
      setWpParsed(parsed);
      if (!parsed.posts.length && !parsed.comments.length) {
        setWpParseError(t('文件里没有找到可导入的文章或评论。'));
      }
    } catch (err) {
      const code = err instanceof Error ? err.message : '';
      setWpParseError(
        code === 'unknown_format'
          ? t('无法识别这个 XML：请选择 WordPress WXR 或 Typecho 备份文件。')
          : code === 'invalid_xml'
            ? t('XML 解析失败：文件可能已损坏。')
            : code === 'unsafe_xml'
              ? t('XML 含 DOCTYPE / ENTITY 声明，出于安全考虑已拒绝解析。')
              : errorText(err),
      );
    } finally {
      setWpParsing(false);
    }
  };

  /** 把解析结果里的提示翻译成当前语言的句子。 */
  const warningText = (warning: ImportWarning): string => {
    switch (warning.code) {
      case 'unsupported_post_type':
        return t('跳过 {count} 条不支持的内容类型：{type}', {
          count: warning.count ?? 1,
          type: warning.detail ?? 'unknown',
        });
      case 'empty_title':
        return t('有 {count} 条内容缺少标题，导入时会跳过。', { count: warning.count ?? 1 });
      case 'empty_body':
        return t('有 {count} 条内容缺少正文，导入时会跳过。', { count: warning.count ?? 1 });
      case 'empty_comment':
        return t('跳过 {count} 条空评论。', { count: warning.count ?? 1 });
      case 'orphan_comment':
        return t('跳过 {count} 条无法关联到文章的评论。', { count: warning.count ?? 1 });
      case 'invalid_date':
        return t('有 {count} 条时间无法解析，已留空。', { count: warning.count ?? 1 });
      case 'missing_wxr_version':
        return t('文件没有 wp:wxr_version，已按 WXR 1.x 尽力解析。');
      default:
        return t('导入提示');
    }
  };

  /** 新分类 / 标签的 slug：拉丁字母正常转写，中文用稳定短哈希兜底。 */
  const newTermSlug = (label: string, kind: 'category' | 'tag', seq: number): string => {
    const ascii = normalizeSlug(label);
    if (ascii) return ascii;
    let hash = 5381;
    for (const char of label) hash = ((hash * 33) ^ (char.codePointAt(0) ?? 0)) >>> 0;
    return `${kind}-${hash.toString(36)}-${seq}`;
  };

  /**
   * 执行导入：createDraft 逐条落库，再按选择发布/提交，最后把评论挂到新内容上。
   * 任何一条失败都不影响其它条目，结果全部汇总到报告里。
   */
  const runWpImport = async (parsed: ParsedImport): Promise<WpImportReport> => {
    if (!site) throw new Error(t('站点信息尚未就绪。'));
    const warnings: string[] = parsed.warnings.map(warningText);
    const items: WpImportItem[] = [];
    let imported = 0;
    let published = 0;
    let submitted = 0;
    let skipped = 0;
    let failed = 0;
    let commentsImported = 0;
    let commentsSkipped = 0;

    // 现有 slug 用于冲突改名：文章与帖子一起查，避免同名地址互相覆盖。
    const takenSlugs = new Set<string>();
    try {
      for (const kind of ['article', 'post'] as ContentKind[]) {
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await backend.listContent(kind, { limit: 100, cursor });
          for (const entry of result.items) {
            const slug = normalizeSlug(entry.slug);
            if (slug) takenSlugs.add(slug);
          }
          if (!result.has_more || !result.next_cursor) break;
          cursor = result.next_cursor;
        }
      }
    } catch {
      warnings.push(
        t('读取现有内容失败，slug 冲突检测已跳过；服务端若拒绝重复地址会逐条报错。'),
      );
    }

    // 分类法：分类要给 createDraft 的 category_id，标签按名称保存；都尽量复用已有项。
    let taxonomy: TaxonomySettings | null = null;
    try {
      taxonomy = await backend.taxonomy(site.id);
    } catch {
      taxonomy = null;
    }
    const categoryByName = new Map<string, string>();
    for (const term of taxonomy?.categories ?? []) {
      categoryByName.set(term.name.trim().toLowerCase(), term.id);
    }
    const tagByName = new Map<string, string>();
    for (const term of taxonomy?.tags ?? []) {
      tagByName.set(term.name.trim().toLowerCase(), term.name);
    }

    const resolveCategory = async (name: string): Promise<string | undefined> => {
      const label = name.trim();
      if (!label) return undefined;
      const key = label.toLowerCase();
      const known = categoryByName.get(key);
      if (known) return known;
      try {
        const term = await backend.createTaxonomyTerm(site.id, {
          kind: 'category',
          name: label,
          slug: newTermSlug(label, 'category', categoryByName.size + 1),
        });
        categoryByName.set(key, term.id);
        return term.id;
      } catch {
        return undefined;
      }
    };

    const resolveTag = async (name: string): Promise<string> => {
      const label = name.trim();
      if (!label) return '';
      const key = label.toLowerCase();
      const known = tagByName.get(key);
      if (known) return known;
      try {
        const term = await backend.createTaxonomyTerm(site.id, {
          kind: 'tag',
          name: label,
          slug: newTermSlug(label, 'tag', tagByName.size + 1),
        });
        tagByName.set(key, term.name);
        return term.name;
      } catch {
        tagByName.set(key, label);
        return label;
      }
    };

    const multiCategory = parsed.posts.some((post) => post.categories.length > 1);
    if (multiCategory) warnings.push(t('一篇内容只能有一个分类，多余分类已忽略。'));

    for (const [index, post] of parsed.posts.entries()) {
      setWpProgress({ done: index, total: parsed.posts.length });
      const title = post.title.trim().slice(0, 200);
      const body = post.body.trim();
      if (!title || !body) {
        skipped += 1;
        items.push({
          title: title || t('未命名'),
          slug: post.slug,
          kind: post.kind,
          action: 'skipped',
          comments: 0,
          reason: !title ? t('缺少标题') : t('缺少正文'),
        });
        continue;
      }

      const wanted = normalizeSlug(post.slug);
      let slug = '';
      let renamed = '';
      if (wanted) {
        slug = uniqueSlug(wanted, takenSlugs);
        if (slug !== wanted) renamed = wanted;
      }

      const categoryId = post.categories.length
        ? await resolveCategory(post.categories[0])
        : undefined;
      const tags: string[] = [];
      const seenTags = new Set<string>();
      for (const tagName of post.tags) {
        const canonical = await resolveTag(tagName);
        if (!canonical) continue;
        const key = canonical.toLowerCase();
        if (seenTags.has(key)) continue;
        seenTags.add(key);
        tags.push(canonical);
      }

      const notes: string[] = [];
      if (renamed) notes.push(t('slug 冲突，已改为 {slug}', { slug }));
      const truncated = body.length > MAX_BODY_LENGTH;
      if (truncated) notes.push(t('正文超过 20 万字符，已截断。'));

      try {
        const created = await backend.createDraft(post.kind, {
          title,
          slug: slug || undefined,
          summary: post.summary?.trim().slice(0, 500) || undefined,
          source_format: post.source_format,
          source_body: truncated ? body.slice(0, MAX_BODY_LENGTH) : body,
          category_id: categoryId,
          tags: tags.length ? tags : undefined,
        });
        imported += 1;
        let action: WpAction = 'imported';
        if (wpImportChoice !== 'draft') {
          try {
            await backend.contentAction(
              post.kind,
              created.id,
              wpImportChoice === 'publish' ? 'publish' : 'submit',
            );
            if (wpImportChoice === 'publish') {
              published += 1;
              action = 'published';
            } else {
              submitted += 1;
              action = 'submitted';
            }
          } catch (err) {
            notes.push(t('草稿已创建，但状态切换失败：{reason}', { reason: errorText(err) }));
          }
        }

        let postComments = 0;
        if (wpImportComments) {
          const related = parsed.comments.filter(
            (comment) => comment.postSourceId === post.sourceId,
          );
          const commentIdBySource = new Map<string, string>();
          for (const comment of related) {
            const commentBody = comment.body.trim();
            if (!commentBody) {
              commentsSkipped += 1;
              continue;
            }
            const prefix: string[] = [];
            if (comment.author.trim()) {
              prefix.push(t('原评论作者：{author}', { author: comment.author.trim() }));
            } else {
              prefix.push(t('由导入创建的评论'));
            }
            if (!comment.approved) prefix.push(t('原评论在来源站点未通过审核'));
            try {
              const parentId = comment.parentId
                ? commentIdBySource.get(comment.parentId)
                : undefined;
              const createdComment = await backend.createComment({
                target_type: post.kind,
                target_id: created.id,
                parent_id: parentId,
                body: `${prefix.join('\n')}\n\n${commentBody}`,
              });
              commentIdBySource.set(comment.id, createdComment.id);
              commentsImported += 1;
              postComments += 1;
            } catch {
              commentsSkipped += 1;
            }
          }
        }

        items.push({
          title,
          slug: created.slug || slug,
          kind: post.kind,
          action,
          comments: postComments,
          reason: notes.join('；') || undefined,
        });
      } catch (err) {
        failed += 1;
        items.push({
          title,
          slug,
          kind: post.kind,
          action: 'failed',
          comments: 0,
          reason: errorText(err),
        });
      }
    }
    setWpProgress({ done: parsed.posts.length, total: parsed.posts.length });

    if (wpImportComments && !parsed.comments.length) {
      warnings.push(t('文件里没有评论，已跳过评论导入。'));
    }
    if (!wpImportComments && parsed.comments.length) {
      warnings.push(
        t('本次选择不导入评论，已跳过 {count} 条。', { count: parsed.comments.length }),
      );
    }

    return {
      format: parsed.format,
      imported,
      published,
      submitted,
      skipped,
      failed,
      commentsImported,
      commentsSkipped,
      items,
      warnings,
    };
  };

  const importWp = async () => {
    if (!wpParsed || wpImporting || !site) return;
    // 与全站导入一致：批量写入前先通过二次验证；取消则什么都不做。
    const ok = await ensureStepUp(t('导入 WordPress / Typecho 内容'));
    if (!ok) return;
    setWpImporting(true);
    setWpImportReport(null);
    setError('');
    setWpProgress({ done: 0, total: wpParsed.posts.length });
    try {
      const result = await runWpImport(wpParsed);
      setWpImportReport(result);
      toast.push(
        result.failed > 0 ? 'info' : 'ok',
        t('导入完成'),
        t('已导入 {imported} · 跳过 {skipped} · 失败 {failed}', {
          imported: result.imported,
          skipped: result.skipped,
          failed: result.failed,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWpImporting(false);
      setWpProgress(null);
    }
  };

  const createBackup = async () => {
    if (!backend.createBackup) return;
    setCreatingBackup(true);
    setBackupError('');
    try {
      const artifact = await backend.createBackup();
      setBackups((current) => [artifact, ...current.filter((item) => item.id !== artifact.id)]);
      toast.push('ok', t('备份已生成'), artifact.file_name);
    } catch (err) {
      setBackupError(errorText(err));
    } finally {
      setCreatingBackup(false);
    }
  };

  const downloadBackup = async (artifact: BackupArtifact) => {
    if (!backend.downloadBackup) return;
    setDownloadingBackup(artifact.id);
    setBackupError('');
    try {
      const { blob, filename } = await backend.downloadBackup(artifact.id);
      saveBlob(blob, filename || artifact.file_name);
    } catch (err) {
      setBackupError(errorText(err));
    } finally {
      setDownloadingBackup('');
    }
  };

  const restoreCommand = `powershell -ExecutionPolicy Bypass -File scripts\\backup.ps1 restore -Archive .\\data\\backups\\<备份文件>.zip -Confirm`;

  const wpArticleCount = wpParsed?.posts.filter((post) => post.kind === 'article').length ?? 0;
  const wpPostCount = wpParsed?.posts.filter((post) => post.kind === 'post').length ?? 0;

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('数据与备份')}</h1>
          <p>{t('导出可迁移的 Markdown 与图片、WordPress / Typecho XML，或为整个实例生成可校验的备份包。')}</p>
        </div>
        <Badge tone={canTransfer ? 'ok' : 'muted'} dot>
          {canTransfer ? t('真实后端') : t('演示模式')}
        </Badge>
      </div>

      {error ? (
        <div className="mb-24">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      {!canTransfer ? (
        <Callout tone="info" icon="info" title={t('演示模式不生成真实文件')}>
          {t('连接真实后端后才能导出、导入或下载备份；演示数据只保存在这台浏览器里。')}
        </Callout>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('全站导出')}</h3>
            <p>{t('Markdown 带 front matter，附图片、站点设计、页面与分类标签。')}</p>
          </div>
          <Icon name="download" size={20} />
        </div>
        <div className="panel-body">
          <div className="form-stack">
            <Field
              label={t('导出范围')}
              hint={t('已发布内容适合迁移到别的写作工具；草稿默认也包含，便于换机继续写。')}
            >
              <Select
                value={publishedOnly ? 'published' : 'all'}
                onChange={(event) => setPublishedOnly(event.target.value === 'published')}
                disabled={!canTransfer || exporting}
              >
                <option value="all">{t('全部内容（含草稿与已归档）')}</option>
                <option value="published">{t('只导出已发布内容')}</option>
              </Select>
            </Field>
            <div className="row gap-8">
              <Button
                icon="download"
                loading={exporting}
                disabled={!canTransfer || exporting || !site}
                onClick={exportSite}
              >
                {t('导出 ZIP')}
              </Button>
              <span className="tiny faint">
                {t('图片会改写为包内相对路径，导入时再映射回本站媒体。')}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('导出到 WordPress / Typecho')}</h3>
            <p>
              {t('生成标准 XML，供 WordPress 的 WXR 导入器或 Typecho 迁移工具读取。')}
            </p>
          </div>
          <Icon name="download" size={20} />
        </div>
        <div className="panel-body">
          <div className="form-stack">
            <Field
              label={t('导出格式')}
              hint={t('WordPress 使用 WXR 1.2；Typecho 使用备份风格的 posts / comments XML。')}
            >
              <Select
                value={wpFormat}
                onChange={(event) => setWpFormat(event.target.value as ImportFormat)}
                disabled={!canTransfer || wpExporting}
              >
                <option value="wordpress-wxr">{t('WordPress WXR XML')}</option>
                <option value="typecho">{t('Typecho XML')}</option>
              </Select>
            </Field>
            <Field
              label={t('内容范围')}
              hint={t('只导出所选类型；分类与标签会一起写进 XML。')}
            >
              <Select
                value={wpScope}
                onChange={(event) =>
                  setWpScope(event.target.value as 'all' | ContentKind)
                }
                disabled={!canTransfer || wpExporting}
              >
                <option value="all">{t('文章与帖子')}</option>
                <option value="article">{t('仅文章')}</option>
                <option value="post">{t('仅帖子')}</option>
              </Select>
            </Field>
            <Field
              label={t('状态范围')}
              hint={t('草稿在 WordPress / Typecho 里也会是草稿状态。')}
            >
              <Select
                value={wpPublishedOnly ? 'published' : 'all'}
                onChange={(event) => setWpPublishedOnly(event.target.value === 'published')}
                disabled={!canTransfer || wpExporting}
              >
                <option value="all">{t('全部内容（含草稿）')}</option>
                <option value="published">{t('只导出已发布内容')}</option>
              </Select>
            </Field>
            <Toggle
              checked={wpWithComments}
              onChange={setWpWithComments}
              disabled={!canTransfer || wpExporting}
              label={t('包含评论')}
              description={t('仅评论列表可用时生效；无法关联到所选内容的评论会被跳过。')}
            />
            <Callout tone="info" icon="info" title={t('媒体文件不会进入 XML')}>
              {t('正文里的站内图片会改写成站点绝对地址；导入 WordPress / Typecho 后仍需由对方抓取或重新上传这些媒体。')}
            </Callout>
            <div className="row gap-8">
              <Button
                icon="download"
                loading={wpExporting}
                disabled={!canTransfer || wpExporting || !site}
                onClick={exportWp}
              >
                {t('导出 XML')}
              </Button>
              <span className="tiny faint">{t('评论作者与发布时间会一起写入。')}</span>
            </div>
            {wpExportNote ? <p className="tiny faint">{wpExportNote}</p> : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('全站导入')}</h3>
            <p>{t('从导出包创建草稿；每条独立落库并逐条报告。')}</p>
          </div>
          <Icon name="upload" size={20} />
        </div>
        <div className="panel-body">
          <div className="form-stack">
            <Field
              label={t('导出包')}
              hint={t('选择本站或另一个站点导出的 practacu-press-site-export zip。')}
            >
              <Input
                type="file"
                accept=".zip,application/zip"
                disabled={!canTransfer || importing}
                onChange={(event) => {
                  setImportFile(event.target.files?.[0] ?? null);
                  setReport(null);
                }}
              />
            </Field>
            <Field
              label={t('slug 冲突')}
              hint={t('标题相同不会阻止导入；这里处理的是地址（slug）已经被占用的情况。')}
            >
              <Select
                value={conflict}
                onChange={(event) => setConflict(event.target.value as ImportConflictStrategy)}
                disabled={!canTransfer || importing}
              >
                <option value="rename">{t('自动改名（追加 -2、-3）')}</option>
                <option value="skip">{t('跳过已存在的条目')}</option>
                <option value="fail">{t('保留冲突并记为失败')}</option>
                <option value="overwrite">{t('覆盖已存在的条目')}</option>
              </Select>
            </Field>
            <Callout tone="warn" icon="alert">
              {t('导入只创建草稿，不会自动发布；审核规则仍然生效。覆盖会通过正常的草稿保存流程更新原条目。')}
            </Callout>
            <div className="row gap-8">
              <Button
                icon="upload"
                loading={importing}
                disabled={!canTransfer || importing || !importFile || !site}
                onClick={importSite}
              >
                {t('开始导入')}
              </Button>
              {importFile ? <span className="tiny faint">{importFile.name}</span> : null}
            </div>

            {report ? (
              <div className="form-stack">
                <div className="row gap-8">
                  <Badge tone="ok">{t('成功 {count}', { count: report.imported })}</Badge>
                  <Badge tone="accent">{t('覆盖 {count}', { count: report.overwritten })}</Badge>
                  <Badge tone="muted">{t('跳过 {count}', { count: report.skipped })}</Badge>
                  <Badge tone={report.failed ? 'danger' : 'muted'}>
                    {t('失败 {count}', { count: report.failed })}
                  </Badge>
                  <Badge tone="neutral">{t('导入图片 {count}', { count: report.media_imported })}</Badge>
                  <Badge tone="neutral">{t('复用图片 {count}', { count: report.media_reused })}</Badge>
                </div>
                {report.warnings?.length ? (
                  <Callout tone="warn" icon="alert" title={t('导入提示')}>
                    <ul>
                      {report.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </Callout>
                ) : null}
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('文件')}</th>
                        <th>{t('标题')}</th>
                        <th>{t('地址（slug）')}</th>
                        <th>{t('结果')}</th>
                        <th>{t('说明')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.items.map((item) => (
                        <tr key={`${item.file}-${item.slug}`}>
                          <td className="mono">{item.file}</td>
                          <td className="cell-title">{item.title}</td>
                          <td className="mono">{item.slug}</td>
                          <td>
                            <Badge
                              tone={
                                item.action === 'failed'
                                  ? 'danger'
                                  : item.action === 'skipped'
                                    ? 'muted'
                                    : item.action === 'overwritten'
                                      ? 'accent'
                                      : 'ok'
                              }
                            >
                              {t(
                                item.action === 'failed'
                                  ? '失败'
                                  : item.action === 'skipped'
                                    ? '跳过'
                                    : item.action === 'overwritten'
                                      ? '已覆盖'
                                      : '已导入',
                              )}
                            </Badge>
                          </td>
                          <td className="tiny faint">{item.reason ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('从 WordPress / Typecho 导入')}</h3>
            <p>{t('读取 WXR 或 Typecho XML：先预览格式与数量，确认后创建草稿或按选择发布。')}</p>
          </div>
          <Icon name="upload" size={20} />
        </div>
        <div className="panel-body">
          <div className="form-stack">
            <Field
              label={t('XML 文件')}
              hint={t('支持 WordPress WXR 1.2 与 Typecho 备份 XML；文件只在浏览器里解析，不会上传到服务器。')}
            >
              <Input
                type="file"
                accept=".xml,text/xml,application/xml"
                disabled={!canTransfer || wpImporting || wpParsing}
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setWpFile(file);
                  if (file) void parseWpFile(file);
                  else {
                    setWpParsed(null);
                    setWpParseError('');
                    setWpImportReport(null);
                  }
                }}
              />
            </Field>
            {wpFile ? <p className="tiny faint">{wpFile.name}</p> : null}
            {wpParsing ? <p className="tiny faint">{t('正在解析…')}</p> : null}
            {wpParseError ? (
              <Callout tone="danger" icon="alert">
                {wpParseError}
              </Callout>
            ) : null}

            {wpParsed ? (
              <div className="form-stack">
                <div className="row gap-8">
                  <Badge tone="accent">
                    {wpParsed.format === 'wordpress-wxr' ? 'WordPress WXR' : 'Typecho XML'}
                  </Badge>
                  <Badge tone="ok">{t('文章 {count}', { count: wpArticleCount })}</Badge>
                  <Badge tone="ok">{t('帖子 {count}', { count: wpPostCount })}</Badge>
                  <Badge tone="neutral">
                    {t('评论 {count}', { count: wpParsed.comments.length })}
                  </Badge>
                </div>
                {wpParsed.title ? (
                  <p className="tiny faint">
                    {t('来源站点：{name}', { name: wpParsed.title })}
                  </p>
                ) : null}
                {wpParsed.warnings.length ? (
                  <Callout tone="warn" icon="alert" title={t('解析提示')}>
                    <ul>
                      {wpParsed.warnings.map((warning, index) => (
                        <li key={`${warning.code}-${warning.detail ?? ''}-${index}`}>
                          {warningText(warning)}
                        </li>
                      ))}
                    </ul>
                  </Callout>
                ) : null}
                {wpParsed.posts.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('标题')}</th>
                          <th>{t('类型')}</th>
                          <th>{t('地址（slug）')}</th>
                          <th>{t('状态')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wpParsed.posts.slice(0, 10).map((post, index) => (
                          <tr key={`${post.sourceId}-${index}`}>
                            <td className="cell-title">{post.title || t('未命名')}</td>
                            <td>
                              <Badge tone="muted">
                                {t(post.kind === 'article' ? '文章' : '帖子')}
                              </Badge>
                            </td>
                            <td className="mono">{post.slug || '—'}</td>
                            <td>
                              <Badge tone={post.published ? 'ok' : 'muted'}>
                                {t(post.published ? '已发布' : '草稿')}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {wpParsed.posts.length > 10 ? (
                  <p className="tiny faint">
                    {t('只显示前 10 条，确认导入时会处理全部 {count} 条。', {
                      count: wpParsed.posts.length,
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}

            <Field
              label={t('导入后的状态')}
              hint={t('先创建草稿，再按这里的选项切换；没有发布权限时会在报告里说明。')}
            >
              <Select
                value={wpImportChoice}
                onChange={(event) =>
                  setWpImportChoice(event.target.value as 'draft' | 'submit' | 'publish')
                }
                disabled={!canTransfer || wpImporting}
              >
                <option value="draft">{t('保持草稿')}</option>
                <option value="submit">{t('提交审核')}</option>
                <option value="publish">{t('直接发布（需要发布权限）')}</option>
              </Select>
            </Field>
            <Toggle
              checked={wpImportComments}
              onChange={setWpImportComments}
              disabled={!canTransfer || wpImporting}
              label={t('导入评论')}
              description={t('评论会挂到对应的新文章下；作者无法通过 API 指定，原名会写进正文前缀。')}
            />
            <Callout tone="warn" icon="alert" title={t('导入说明')}>
              {t('导入以当前管理员账户写入，无法保留原作者身份；分类与标签会尽量复用站点分类法，slug 冲突时会自动追加后缀。')}
            </Callout>
            <div className="row gap-8">
              <Button
                icon="upload"
                loading={wpImporting}
                disabled={!canTransfer || wpImporting || !wpParsed || !site}
                onClick={importWp}
              >
                {t('确认导入')}
              </Button>
              {wpProgress ? (
                <span className="tiny faint">
                  {t('已处理 {done} / {total}', {
                    done: wpProgress.done,
                    total: wpProgress.total,
                  })}
                </span>
              ) : null}
            </div>

            {wpImportReport ? (
              <div className="form-stack">
                <div className="row gap-8">
                  <Badge tone="ok">
                    {t('导入 {count}', { count: wpImportReport.imported })}
                  </Badge>
                  <Badge tone="accent">
                    {t('发布 {count}', { count: wpImportReport.published })}
                  </Badge>
                  <Badge tone="accent">
                    {t('提交 {count}', { count: wpImportReport.submitted })}
                  </Badge>
                  <Badge tone="muted">
                    {t('跳过 {count}', { count: wpImportReport.skipped })}
                  </Badge>
                  <Badge tone={wpImportReport.failed ? 'danger' : 'muted'}>
                    {t('失败 {count}', { count: wpImportReport.failed })}
                  </Badge>
                  <Badge tone="neutral">
                    {t('评论 {count}', { count: wpImportReport.commentsImported })}
                  </Badge>
                  <Badge tone="muted">
                    {t('跳过评论 {count}', { count: wpImportReport.commentsSkipped })}
                  </Badge>
                </div>
                {wpImportReport.warnings.length ? (
                  <Callout tone="warn" icon="alert" title={t('导入提示')}>
                    <ul>
                      {wpImportReport.warnings.map((warning, index) => (
                        <li key={`${warning}-${index}`}>{warning}</li>
                      ))}
                    </ul>
                  </Callout>
                ) : null}
                {wpImportReport.items.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('标题')}</th>
                          <th>{t('类型')}</th>
                          <th>{t('地址（slug）')}</th>
                          <th>{t('结果')}</th>
                          <th>{t('评论')}</th>
                          <th>{t('说明')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wpImportReport.items.map((item, index) => (
                          <tr key={`${item.slug}-${index}`}>
                            <td className="cell-title">{item.title}</td>
                            <td>
                              <Badge tone="muted">
                                {t(item.kind === 'article' ? '文章' : '帖子')}
                              </Badge>
                            </td>
                            <td className="mono">{item.slug || '—'}</td>
                            <td>
                              <Badge
                                tone={
                                  item.action === 'failed'
                                    ? 'danger'
                                    : item.action === 'skipped'
                                      ? 'muted'
                                      : item.action === 'imported'
                                        ? 'ok'
                                        : 'accent'
                                }
                              >
                                {t(
                                  item.action === 'failed'
                                    ? '失败'
                                    : item.action === 'skipped'
                                      ? '跳过'
                                      : item.action === 'published'
                                        ? '已发布'
                                        : item.action === 'submitted'
                                          ? '已提交'
                                          : '已导入',
                                )}
                              </Badge>
                            </td>
                            <td className="cell-num">{item.comments || ''}</td>
                            <td className="tiny faint">{item.reason ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('实例备份')}</h3>
            <p>{t('数据库全量 + 媒体 + 站点设计，manifest 记录版本与逐文件 SHA-256。')}</p>
          </div>
          <Icon name="database" size={20} />
        </div>
        <div className="panel-body">
          {!platformAdmin ? (
            <Callout tone="info" icon="info" title={t('仅平台管理员可备份整个实例')}>
              {t('站点管理员可用上方的全站导出迁移自己的内容；实例备份包含所有站点，因此不在这里开放。')}
            </Callout>
          ) : (
            <div className="form-stack">
              <div className="row gap-8">
                <Button
                  icon="database"
                  loading={creatingBackup}
                  disabled={creatingBackup}
                  onClick={createBackup}
                >
                  {t('立即创建备份')}
                </Button>
                <Button variant="secondary" icon="refresh" loading={loadingBackups} onClick={loadBackups}>
                  {t('刷新列表')}
                </Button>
              </div>
              {backupError ? (
                <Callout tone="danger" icon="alert">
                  {backupError}
                </Callout>
              ) : null}
              {backups.length === 0 && !loadingBackups ? (
                <p className="tiny faint">
                  {t('还没有备份包。SQLite 会生成一致快照；MySQL / PostgreSQL 请用各自的 dump 工具。')}
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('文件')}</th>
                        <th>{t('时间')}</th>
                        <th>{t('大小')}</th>
                        <th>{t('媒体')}</th>
                        <th>{t('校验')}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {backups.map((artifact) => (
                        <tr key={artifact.id}>
                          <td className="mono">{artifact.file_name}</td>
                          <td>{formatDateTime(artifact.created_at)}</td>
                          <td className="cell-num">{formatBytes(artifact.size)}</td>
                          <td>
                            <Badge tone={artifact.includes_media ? 'ok' : 'muted'}>
                              {artifact.includes_media ? t('已包含') : t('未包含')}
                            </Badge>
                          </td>
                          <td className="mono tiny" title={artifact.sha256}>
                            {artifact.sha256.slice(0, 12)}…
                          </td>
                          <td className="cell-actions">
                            <Button
                              variant="secondary"
                              size="sm"
                              icon="download"
                              loading={downloadingBackup === artifact.id}
                              onClick={() => downloadBackup(artifact)}
                            >
                              {t('下载')}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {backups.some((artifact) => artifact.warnings?.length) ? (
                <Callout tone="warn" icon="alert" title={t('备份范围提示')}>
                  <ul>
                    {backups
                      .flatMap((artifact) => artifact.warnings ?? [])
                      .filter((warning, index, all) => all.indexOf(warning) === index)
                      .map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                  </ul>
                </Callout>
              ) : null}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('恢复')}</h3>
            <p>{t('恢复会替换数据库文件，只能在服务停止后由命令行执行。')}</p>
          </div>
          <Icon name="server" size={20} />
        </div>
        <div className="panel-body">
          <div className="form-stack">
            <Callout tone="warn" icon="alert" title={t('恢复前自动做一次安全备份')}>
              {t('命令会先校验 manifest 与每个文件的 SHA-256，拒绝覆盖非空库，除非显式加 -Confirm；随后自动备份当前数据，再替换数据库与本地媒体，最后重新应用增量迁移并校验表结构。')}
            </Callout>
            <div>
              <p className="tiny faint">{t('在仓库根目录执行：')}</p>
              <pre className="code-block">{restoreCommand}</pre>
            </div>
            <p className="tiny faint">
              {t('MySQL / PostgreSQL 不使用此命令：请用 mysqldump / pg_dump 备份数据库，媒体目录单独复制。S3 媒体不进入备份包，需要按桶单独备份。')}
            </p>
          </div>
        </div>
      </section>
    </RoleGate>
  );
}
