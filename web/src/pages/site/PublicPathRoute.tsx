import { useLocation } from 'react-router-dom';
import { PageLoading } from '../../components/ui';
import { useBackend } from '../../lib/backend';
import { useAsync } from '../../lib/hooks';
import { matchContentPermalinks } from '../../lib/permalinks';
import { useCustomization } from '../../lib/customize';
import { NotFoundPage } from '../NotFound';
import { ContentDetailPage } from './ContentDetail';
import { CustomPage } from './CustomPage';

export function PublicPathRoute() {
  const location = useLocation();
  const backend = useBackend();
  const { customization } = useCustomization();
  const permalinks = customization.seo.permalinks;
  const matches = matchContentPermalinks(location.pathname, permalinks);
  const previewToken = new URLSearchParams(location.search).get('preview_token') ?? undefined;
  const result = useAsync(async () => {
    for (const match of matches) {
      try {
        const item = await backend.getContent(match.kind, match.key, previewToken);
        return { kind: match.kind, item };
      } catch {
        continue;
      }
    }
    return null;
  }, [backend, location.pathname, location.search, JSON.stringify(matches)]);

  if (matches.length) {
    if (result.loading) return <PageLoading />;
    if (result.data) {
      return (
        <ContentDetailPage
          kind={result.data.kind}
          contentKey={result.data.item.id}
          initialItem={result.data.item}
        />
      );
    }
  }

  const segments = location.pathname.split('/').filter(Boolean);
  if (segments.length === 1) {
    const pageSlug = decodePathSegment(segments[0]);
    if (customization.pages.some((page) => page.slug === pageSlug)) return <CustomPage pageSlug={pageSlug} />;
  }
  return <NotFoundPage />;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
