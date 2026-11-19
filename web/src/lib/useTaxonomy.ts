import { useCallback, useEffect, useState } from 'react';
import type { TaxonomyKind, TaxonomySettings, TaxonomyTerm, TaxonomyTermInput } from '../types';
import { useAuth } from './session';
import { isDemo, useBackend } from './backend';
import { useCustomization } from './customize';

const TAXONOMY_EVENT = 'pp:taxonomy-changed';

function localTerm(kind: TaxonomyKind, input: TaxonomyTermInput): TaxonomyTerm {
  const now = Date.now().toString(36);
  return {
    id: `${kind === 'category' ? 'cat' : 'tag'}_${now}`,
    name: input.name.trim(),
    slug: input.slug.trim() || `term-${now}`,
    description: input.description?.trim() || undefined,
    ...(kind === 'category' ? { color: input.color || '#2f6b4f' } : {}),
  };
}

/**
 * 统一分类/标签数据源。
 *
 * - 真实后端有 taxonomy 端点时，读取服务端并写回服务端；
 * - 演示模式或旧后端没有端点时，自动回退到 `customization.taxonomy`。
 *
 * 变更通过自定义事件通知同一页面里的其它 hook，避免编辑器、内容列表和
 * 主题工坊各自缓存出一份过期数据。
 */
export function useTaxonomy(): {
  taxonomy: TaxonomySettings;
  loading: boolean;
  source: 'backend' | 'local';
  saveTerm: (kind: TaxonomyKind, input: TaxonomyTermInput, termId?: string) => Promise<TaxonomyTerm>;
  deleteTerm: (kind: TaxonomyKind, termId: string) => Promise<void>;
  reload: () => Promise<void>;
} {
  const { me, site, config } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const { customization, update } = useCustomization();
  const siteId = site?.id ?? config.site_id;
  const [remote, setRemote] = useState<TaxonomySettings | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (demo || !siteId) {
      setRemote(null);
      return;
    }
    try {
      const data = await backend.taxonomy(siteId);
      setRemote(data);
    } catch {
      setRemote(null);
    }
  }, [backend, demo, siteId]);

  useEffect(() => {
    setLoading(true);
    void reload().finally(() => setLoading(false));
    const handler = () => {
      void reload();
    };
    window.addEventListener(TAXONOMY_EVENT, handler);
    return () => window.removeEventListener(TAXONOMY_EVENT, handler);
  }, [reload]);

  const emit = () => window.dispatchEvent(new CustomEvent(TAXONOMY_EVENT));

  const saveTerm = async (
    kind: TaxonomyKind,
    input: TaxonomyTermInput,
    termId?: string,
  ): Promise<TaxonomyTerm> => {
    if (demo || !remote) {
      const bucket = kind === 'category' ? 'categories' : 'tags';
      const list = customization.taxonomy[bucket];
      const saved = termId
        ? { ...localTerm(kind, input), id: termId }
        : localTerm(kind, input);
      update({
        taxonomy: {
          ...customization.taxonomy,
          [bucket]: termId
            ? list.map((term) => (term.id === termId ? saved : term))
            : [...list, saved],
        },
      });
      emit();
      return saved;
    }

    const saved = termId
      ? await backend.updateTaxonomyTerm(me!.site_id, termId, input)
      : await backend.createTaxonomyTerm(me!.site_id, input);
    await reload();
    emit();
    return saved;
  };

  const deleteTerm = async (kind: TaxonomyKind, termId: string): Promise<void> => {
    if (demo || !remote) {
      const bucket = kind === 'category' ? 'categories' : 'tags';
      update({
        taxonomy: {
          ...customization.taxonomy,
          [bucket]: customization.taxonomy[bucket].filter((term) => term.id !== termId),
        },
      });
      emit();
      return;
    }
    await backend.deleteTaxonomyTerm(me!.site_id, termId);
    await reload();
    emit();
  };

  return {
    taxonomy: remote ?? customization.taxonomy,
    loading,
    source: remote ? 'backend' : 'local',
    saveTerm,
    deleteTerm,
    reload,
  };
}
