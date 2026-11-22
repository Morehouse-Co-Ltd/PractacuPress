/**
 * 安装向导的纯校验逻辑。
 *
 * 页面里的 `validate(step)` 只负责把这里的结果交给 `t()`；把数据库连接字段单独
 * 抽出来，安装步骤的必填规则就可以在没有 DOM 和后端的情况下直接测试。
 */

export interface DatabaseDraft {
  host: string;
  port: string;
  name: string;
  user: string;
  password: string;
}

/**
 * MySQL / PostgreSQL 的连接字段校验。
 *
 * 返回可直接交给 `t()` 的中文键；空串表示通过。SQLite 不调用这个函数。
 * 端口只接受 1–65535 的纯数字；密码按非空白字符判断必填，实际写入配置片段时
 * 仍保留用户输入的原始值。
 */
export function databaseDraftError(db: DatabaseDraft): string {
  if (!db.host.trim()) return '请填写数据库主机。';

  const port = db.port.trim();
  if (!port) return '请填写数据库端口。';
  if (!/^\d+$/.test(port)) return '数据库端口必须是 1 到 65535 之间的整数。';
  const numericPort = Number(port);
  if (numericPort < 1 || numericPort > 65535) {
    return '数据库端口必须是 1 到 65535 之间的整数。';
  }

  if (!db.name.trim()) return '请填写数据库名称。';
  if (!db.user.trim()) return '请填写数据库用户。';
  if (!db.password.trim()) return '请填写数据库密码。';
  return '';
}
