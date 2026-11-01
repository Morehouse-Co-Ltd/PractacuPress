import { useMemo, useState } from 'react';
import { useBackend, isDemo } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { readActivity, clearActivity } from '../../lib/activity';
import { activityCsv, activityTone, formatDateTime } from '../../lib/format';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  Modal,
  PageLoading,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useToast } from '../../lib/toast';

export function ActivityPage() {
  const backend = useBackend();
  const demo = isDemo(backend) ? backend : null;
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [clearOpen, setClearOpen] = useState(false);
  useTitle('网站日志');

  const data = useAsync(async () => {
    if (demo) {
      const [seeded, local] = await Promise.all([demo.activity(), Promise.resolve(readActivity())]);
      return [...local, ...seeded].sort((a, b) => b.at.localeCompare(a.at));
    }
    return readActivity();
  }, [backend, demo]);

  const items = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return data.data ?? [];
    return (data.data ?? []).filter((entry) =>
      `${entry.actor} ${entry.action} ${entry.target} ${entry.detail ?? ''}`.toLowerCase().includes(term),
    );
  }, [data.data, query]);

  const exportCsv = () => {
    const csv = activityCsv(items);
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `practacu-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.push('ok', '已导出 CSV');
  };

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>网站日志</h1>
          <p>
            {demo
              ? '演示后端记录的站点操作与本浏览器登录记录。真实后端把审计写入 audit_logs，但 v0.1.0 没有对外查询端点。'
              : '真实后端没有审计查询端点；这里记录的是本浏览器内执行的管理操作与登录。'}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv} disabled={!items.length}>
            导出 CSV
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            刷新
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="info" title="这不是服务端审计日志">
        设计文档要求所有管理操作、权限失败与安全事件写入 audit_logs，并在服务端保留。当前 OpenAPI
        没有暴露审计查询接口，因此本页只能展示：演示数据的种子记录，或此浏览器执行操作时留下的本地记录。
        它不能替代合规审计。
      </Callout>

      <div className="toolbar mt-20">
        <div className="inline-search" style={{ width: 280 }}>
          <Icon name="search" size={14} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索操作者、动作或对象"
            aria-label="搜索操作日志"
          />
        </div>
        <span className="toolbar-spacer" />
        <span className="tiny faint">{items.length} 条</span>
        {!demo ? (
          <Button variant="quiet" size="sm" icon="trash" onClick={() => setClearOpen(true)}>
            清空本地记录
          </Button>
        ) : null}
      </div>

      {data.loading ? (
        <PageLoading label="正在载入操作日志" />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="clock"
            title="还没有操作日志"
            body="发布内容、修改站点设置或调整用户组后，记录会出现在这里。"
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="panel-body">
            {items.map((entry) => (
              <div className="activity-row" key={entry.id}>
                <time>{formatDateTime(entry.at)}</time>
                <span className="act-actor">{entry.actor}</span>
                <span className="act-action">
                  <Badge tone={activityTone(entry.action)}>{entry.action}</Badge>
                </span>
                <span className="act-target" title={entry.target}>
                  {entry.target}
                </span>
                {entry.detail ? <span className="act-detail">{entry.detail}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="tiny faint mt-16">
        记录保存在浏览器 localStorage，上限 120 条；清除浏览器数据会一并清空。服务端审计以数据库为准。
      </p>

      <Modal
        open={clearOpen}
        title="清空本地操作日志？"
        description="只会删除这个浏览器里的记录，不影响服务端数据。"
        onClose={() => setClearOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setClearOpen(false)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                clearActivity();
                setClearOpen(false);
                data.reload();
                toast.push('ok', '本地记录已清空');
              }}
            >
              清空
            </Button>
          </>
        }
      />
    </>
  );
}
