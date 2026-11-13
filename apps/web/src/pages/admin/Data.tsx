import { useCallback, useEffect, useState } from 'react';
import type { BackupArtifact, ImportConflictStrategy, SiteImportReport } from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import { errorText, useT } from '../../lib/i18n';
import { useTitle } from '../../lib/hooks';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Button, Callout, Field, Input, Select } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useStepUp } from '../../lib/stepUp';
import { RoleGate } from '../../components/Guards';

/** 把一次下载的 blob 交给浏览器保存；文件名由服务端 Content-Disposition 提供。 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** 数据与备份：全站导出/导入，以及平台管理员可见的实例备份。 */
export function DataPage() {
  const t = useT();
  const { site, me } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { ensureStepUp } = useStepUp();
  const demo = isDemo(backend);
  const canTransfer = !demo && typeof backend.exportSite === 'function';
  const platformAdmin = me?.role === 'platform_admin' && typeof backend.createBackup === 'function';
  useTitle(t('数据与备份'));

  const [publishedOnly, setPublishedOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  const [importFile, setImportFile] = useState<File | null>(null);
  const [conflict, setConflict] = useState<ImportConflictStrategy>('rename');
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<SiteImportReport | null>(null);

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

  return (
    <RoleGate capability="manage_site" need={t('站点管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('数据与备份')}</h1>
          <p>{t('导出可迁移的 Markdown 与图片，或为整个实例生成可校验的备份包。')}</p>
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
