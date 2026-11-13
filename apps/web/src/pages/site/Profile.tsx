import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, errorText } from '../../lib/hooks';
import { useCustomization } from '../../lib/customize';
import { formatDate, ROLE_LABEL } from '../../lib/format';
import { isPersonalSite } from '../../lib/site';
import { usePermissions } from '../../lib/usePermissions';
import { Button, EmptyState, Field, Input, Modal, Skeleton, Textarea } from '../../components/ui';
import { Avatar } from '../../components/ui';
import { ArticleCard } from '../../components/blocks/DataBlocks';
import { useToast } from '../../lib/toast';
import { useSeo, personJsonLd } from '../../lib/seo';
import { useT } from '../../lib/i18n';
import { useMediaSrc } from '../../lib/assetUrl';
import { passwordProblem, passwordProblemText } from '../../lib/passwordPolicy';
import { TwoFactorPanel } from '../../components/TwoFactorPanel';

/** 资料头像：有素材时读取媒体库，没有时退回姓名首字。 */
function AvatarImage({
  assetId,
  name,
  size,
}: {
  assetId?: string;
  name: string;
  size: number;
}) {
  const { src } = useMediaSrc(assetId ? `/api/v1/media/${assetId}` : '');
  if (!assetId || !src) return <Avatar name={name} size={size} />;
  return (
    <img
      src={src}
      alt={name}
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
    />
  );
}

/** 编辑弹窗里的候选头像；每个候选自己解析媒体地址。 */
function AvatarOption({
  assetId,
  active,
  name,
  onSelect,
}: {
  assetId: string;
  active: boolean;
  name: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? 'btn btn-secondary btn-sm' : 'btn btn-quiet btn-sm'}
      aria-pressed={active}
      onClick={onSelect}
      style={{ padding: 4, borderRadius: '50%' }}
      title={name}
    >
      <AvatarImage assetId={assetId} name={name} size={44} />
    </button>
  );
}

export function ProfilePage() {
  const t = useT();
  const { id = '' } = useParams();
  const { me, site, config, reload: reloadSession } = useAuth();
  const { customization } = useCustomization();
  const { adminEntry } = usePermissions();
  const backend = useBackend();
  const personal = isPersonalSite(config);
  // 纸白主题没有 accent 封面的配色（会变成深底深字），这里退回默认程序化封面；
  // 白昼与夜航继续用主题色封面，与首页卡片一致。
  const accentCovers = customization.layout.variant !== 'classic';
  const toast = useToast();
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  const profile = useAsync(async () => backend.publicUser(id), [backend, id]);

  // 作者筛选走既有的 `author_id` 列表参数（服务端只返回调用者可见的内容），
  // 文章与帖子两个端点各自取 100 条后合并；卡片按发布时间倒序，与归档页同口径。
  const authored = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100, authorId: id }),
      backend.listContent('post', { limit: 100, authorId: id }),
    ]);
    return [...articles.items, ...posts.items]
      .filter((entry) => entry.status === 'published')
      .sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at));
  }, [backend, id]);

  // 刷新后从服务端恢复关注状态：只看本地状态会把已关注显示成未关注，第一次点击
  // 反而会取消关注。未登录时后端返回全 false，不额外发请求。
  useEffect(() => {
    if (!me?.user.id || me.user.id === id) return;
    let alive = true;
    backend
      .stateFor('user', id)
      .then((state) => {
        if (alive) setFollowing(state.following);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [backend, id, me?.user.id]);

  const name = profile.data?.display_name ?? (profile.loading ? '' : t('未知用户'));
  useSeo({
    title: name || t('成员'),
    path: `/u/${id}`,
    type: 'profile',
    description: name
      ? t('{name} 在 {site} 主页与已发布内容。', { name, site: site?.name ?? t('本站') })
      : undefined,
    jsonLd: name
      ? [personJsonLd({ name, url: `${window.location.origin}/u/${id}` })]
      : [],
  });

  const own = me?.user.id === id;
  const profileUser = profile.data;
  const role = profileUser?.role;

  const [editOpen, setEditOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarId, setAvatarId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // 只有打开编辑弹窗时才加载头像素材，避免每次访问主页都多一次列表请求。
  const avatarAssets = useAsync(async () => {
    if (!editOpen) return [];
    const assets = await backend.listAssets();
    return assets.filter((asset) => asset.purpose === 'avatar');
  }, [backend, editOpen]);

  const openEdit = () => {
    setDisplayName(profileUser?.display_name ?? me?.user.display_name ?? '');
    setBio(profileUser?.bio ?? me?.user.bio ?? '');
    setAvatarId(profileUser?.avatar_media_id ?? me?.user.avatar_media_id ?? '');
    setPendingFile(null);
    setEditOpen(true);
  };

  const uploadAvatar = async (file: File) => {
    setUploading(true);
    try {
      const asset = await backend.upload(file, 'avatar');
      setAvatarId(asset.id);
      avatarAssets.reload();
      toast.push('ok', t('头像已上传'));
    } catch (err) {
      toast.push('error', t('上传失败'), errorText(err));
    } finally {
      setUploading(false);
      setPendingFile(null);
    }
  };

  const saveProfile = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      toast.push('error', t('昵称不能为空'));
      return;
    }
    setSaving(true);
    try {
      await backend.updateProfile({
        display_name: trimmed,
        bio,
        avatar_media_id: avatarId,
      });
      setEditOpen(false);
      profile.reload();
      await reloadSession();
      toast.push('ok', t('资料已更新'));
    } catch (err) {
      toast.push('error', t('保存失败'), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const savePassword = async () => {
    if (!currentPassword) {
      toast.push('error', t('请输入当前密码'));
      return;
    }
    const problem = passwordProblem(newPassword);
    if (problem) {
      toast.push('error', passwordProblemText(problem, t));
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.push('error', t('两次输入的新密码不一致'));
      return;
    }
    setSaving(true);
    try {
      await backend.changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setPasswordOpen(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.push('ok', t('密码已更新，其他设备已下线'));
    } catch (err) {
      toast.push('error', t('修改密码失败'), errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const resendVerification = async () => {
    setSendBusy(true);
    try {
      const result = await backend.requestEmailVerification();
      await reloadSession();
      toast.push(
        'ok',
        result.already_verified ? t('邮箱已经验证过了') : t('验证邮件已发送，请查收'),
      );
    } catch (err) {
      toast.push('error', t('发送验证邮件失败'), errorText(err));
    } finally {
      setSendBusy(false);
    }
  };

  const toggleFollow = async () => {
    if (!me) return;
    setBusy(true);
    try {
      const result = await backend.toggleFollow(id);
      setFollowing(result.active);
      toast.push('ok', result.active ? t('已关注') : t('已取消关注'));
    } catch (err) {
      toast.push('error', t('操作失败'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const avatarCandidates = useMemo(
    () => (avatarAssets.data ?? []).filter((asset) => asset.purpose === 'avatar'),
    [avatarAssets.data],
  );

  if (profile.loading) {
    return (
      <div className="shell">
        <div className="mt-32">
          <Skeleton lines={5} />
        </div>
      </div>
    );
  }

  if (!profile.data) {
    return (
      <div className="shell">
        <div style={{ paddingTop: 56 }}>
          <EmptyState
            icon="user"
            title={t('无法打开这个主页')}
            body={t('这位成员不在当前站点里，或主页还没有公开。')}
            action={
              <Link to="/" className="btn btn-secondary btn-sm">
                {t('返回首页')}
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const user = profile.data;

  return (
    <div className="shell">
      <header className="profile-head">
        <AvatarImage assetId={user.avatar_media_id} name={user.display_name} size={76} />
        <div>
          <h1>{user.display_name}</h1>
          <p>
            {role ? `${ROLE_LABEL[role as keyof typeof ROLE_LABEL]} · ` : ''}
            {t('加入于 {date} · {site}', {
              date: formatDate(user.created_at),
              site: site?.name ?? t('本站'),
            })}
          </p>
        </div>
        <div className="profile-actions">
          {own ? (
            <>
              <Button variant="secondary" size="sm" onClick={openEdit}>
                {t('编辑资料')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPasswordOpen(true)}>
                {t('修改密码')}
              </Button>
              <Link to="/notifications" className="btn btn-secondary btn-sm">
                {t('我的通知')}
              </Link>
              <Link to="/me/bookmarks" className="btn btn-secondary btn-sm">
                {t('我的互动')}
              </Link>
              {adminEntry ? (
                <Link to="/admin" className="btn btn-primary btn-sm">
                  {t('管理后台')}
                </Link>
              ) : null}
            </>
          ) : me ? (
            <Button
              variant={following ? 'secondary' : 'primary'}
              size="sm"
              icon={following ? 'check' : 'plus'}
              loading={busy}
              onClick={toggleFollow}
            >
              {following ? t('已关注') : t('关注')}
            </Button>
          ) : personal ? null : (
            <Link to={`/login?next=${encodeURIComponent(`/u/${id}`)}`} className="btn btn-primary btn-sm">
              {t('登录后关注')}
            </Link>
          )}
        </div>
      </header>

      {user.bio ? (
        <p className="mt-16" style={{ maxWidth: 720, lineHeight: 1.8 }}>
          {user.bio}
        </p>
      ) : null}

      {own ? (
        <div className="mt-16 row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="tiny faint">{t('邮箱状态')}</span>
          <span className={me?.user.email_verified ? 'chip' : 'chip'}>
            {me?.user.email_verified ? t('已验证') : t('未验证')}
          </span>
          {me?.user.email ? <span className="tiny faint">{me.user.email}</span> : null}
          {!me?.user.email_verified && me?.user.email ? (
            <Button variant="quiet" size="sm" loading={sendBusy} onClick={resendVerification}>
              {t('发送验证邮件')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {own ? <TwoFactorPanel /> : null}

      <div className="profile-stats">
        <div>
          <b>{authored.data?.length ?? 0}</b>
          <span>{t('已发布内容')}</span>
        </div>
        <div>
          <b className="is-small">{formatDate(user.created_at)}</b>
          <span>{t('加入时间')}</span>
        </div>
        <div>
          <b className="is-small">{own ? t('本人') : following ? t('已关注') : t('未关注')}</b>
          <span>{t('关注状态')}</span>
        </div>
      </div>

      <section className="mt-32">
        <div className="section-head">
          <h2 style={{ fontSize: 24 }}>{own ? t('我的文章与帖子') : t('TA 的文章与帖子')}</h2>
          <span className="tiny faint">
            {t('{count} 篇', { count: authored.data?.length ?? 0 })}
          </span>
        </div>

        {authored.loading ? (
          // 加载骨架沿用全站 Skeleton；放在同一套网格里，加载完不跳版。
          <div className="pp-article-grid profile-article-grid">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} lines={3} />
            ))}
          </div>
        ) : !authored.data?.length ? (
          <EmptyState
            compact
            icon="file"
            title={t('还没有已发布的内容')}
            body={t('草稿与被退回的稿子不会出现在公开主页。')}
          />
        ) : (
          // 紧凑小卡片：复用「文章组件」的 .pp-article-card（封面缩略图 + 标题 +
          // 摘要 + 日期），资料页只通过 .profile-article-grid 控制列数。
          <div className="pp-article-grid profile-article-grid is-list">
            {authored.data.map((entry) => (
              <ArticleCard
                key={entry.id}
                item={entry}
                layout="list"
                showExcerpt
                showMeta
                showTags={false}
                coverAccent={accentCovers}
              />
            ))}
          </div>
        )}
      </section>

      <Modal
        open={editOpen}
        title={t('编辑资料')}
        description={t('昵称、简介与头像会立即显示在你的公开主页上。')}
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={saving} onClick={saveProfile}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <Field label={t('昵称')}>
          <Input value={displayName} maxLength={120} onChange={(event) => setDisplayName(event.target.value)} />
        </Field>
        <Field label={t('简介')} hint={t('最多 2000 个字符。')}>
          <Textarea
            value={bio}
            rows={5}
            maxLength={2000}
            placeholder={t('用一两句话介绍自己。')}
            onChange={(event) => setBio(event.target.value)}
          />
        </Field>
        <Field label={t('头像')} hint={t('只能选择你上传并通过检查的图片。')}>
          <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <AvatarImage assetId={avatarId} name={displayName || user.display_name} size={56} />
            <Button
              variant="quiet"
              size="sm"
              onClick={() => setAvatarId('')}
              disabled={!avatarId}
            >
              {t('移除头像')}
            </Button>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              {uploading ? t('上传中…') : t('上传头像')}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setPendingFile(file);
                  if (file) void uploadAvatar(file);
                }}
              />
            </label>
            {pendingFile ? <span className="tiny faint">{pendingFile.name}</span> : null}
          </div>
          {avatarCandidates.length ? (
            <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
              {avatarCandidates.map((asset) => (
                <AvatarOption
                  key={asset.id}
                  assetId={asset.id}
                  active={avatarId === asset.id}
                  name={asset.file_name ?? t('头像素材')}
                  onSelect={() => setAvatarId(asset.id)}
                />
              ))}
            </div>
          ) : null}
        </Field>
      </Modal>

      <Modal
        open={passwordOpen}
        title={t('修改密码')}
        description={t('需要先验证当前密码。保存后，其他设备上的登录会被注销。')}
        onClose={() => setPasswordOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPasswordOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={saving} onClick={savePassword}>
              {t('更新密码')}
            </Button>
          </>
        }
      >
        <Field label={t('当前密码')}>
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </Field>
        <Field label={t('新密码')} hint={t('至少 8 位，需要包含两类字符。')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </Field>
        <Field label={t('确认新密码')}>
          <Input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </Field>
      </Modal>
    </div>
  );
}
