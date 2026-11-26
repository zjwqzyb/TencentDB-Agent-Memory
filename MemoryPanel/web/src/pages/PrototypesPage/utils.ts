import type { PrototypePageSummary } from '@/lib/api/prototypes';

export const DEFAULT_PAGE_KEY = 'claim-list';

const DEFAULT_PAGES: Array<Pick<PrototypePageSummary, 'page_key' | 'views'>> = [
  { page_key: 'claim-list', views: ['list'] },
  { page_key: 'claim-form', views: ['create', 'edit', 'view'] },
];

export function mergePrototypePages(items: PrototypePageSummary[]): PrototypePageSummary[] {
  const byKey = new Map(items.map((item) => [item.page_key, item]));
  const defaults = DEFAULT_PAGES.map(
    (page): PrototypePageSummary =>
      byKey.get(page.page_key) ?? {
        asset_id: '',
        page_key: page.page_key,
        version: null,
        restore_version: null,
        views: page.views,
        created_at: null,
      },
  );
  const defaultKeys = new Set(DEFAULT_PAGES.map((page) => page.page_key));
  const additional = items
    .filter((item) => !defaultKeys.has(item.page_key))
    .sort((left, right) => left.page_key.localeCompare(right.page_key));
  return [...defaults, ...additional];
}

export function defaultPrototypeView(page: PrototypePageSummary): string {
  if (page.page_key === 'claim-form') return 'create';
  return page.views[0] ?? (page.page_key === 'claim-list' ? 'list' : 'view');
}

export function buildPrototypeEditorUrl(input: {
  teamId: string;
  assetId: string;
  pageKey: string;
  view: string;
  version?: number;
}): string {
  const url = new URL('/prototype-editor/', window.location.origin);
  url.search = new URLSearchParams({
    team_id: input.teamId,
    asset_id: input.assetId,
    page_key: input.pageKey,
    view: input.view,
    ...(input.version === undefined ? {} : { version: String(input.version) }),
  }).toString();
  url.hash = '/claims';
  return url.toString();
}

export function newPrototypeRequestId(): string {
  return `panel-restore-${crypto.randomUUID().replace(/-/g, '')}`;
}

export function formatPrototypeTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
