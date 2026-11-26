import { ApiError, metaPost, type RequestOptions } from './base';
import type { Asset } from './types';

export interface PrototypeComponent {
  id: string;
  type: string;
  contract_version: number;
  parent_id: string | null;
  slot: string | null;
  order: number;
  props: Record<string, unknown>;
  bindings: Record<string, string>;
}

export interface PrototypeSnapshot {
  format_version: 1;
  views: string[];
  components: PrototypeComponent[];
}

export interface PrototypePageSummary {
  asset_id: string;
  page_key: string;
  version: number | null;
  current_version?: number | null;
  base_version?: number | null;
  author_id?: string;
  author_user_id?: string;
  request_id?: string;
  operation?: 'save' | 'restore';
  restore_version: number | null;
  views: string[];
  created_at: string | null;
  updated_at?: string;
  commit_id?: string;
}

export interface PrototypePageHistoryItem extends Omit<PrototypePageSummary, 'version' | 'created_at'> {
  version: number;
  created_at: string;
}

export interface PrototypePageVersion extends PrototypePageHistoryItem {
  team_id: string;
  snapshot: PrototypeSnapshot;
}

export interface PrototypeProjectAccess {
  asset: Asset;
  user_id: string;
  can_write: boolean;
}

export interface PrototypeContract {
  asset_id: string;
  team_id: string;
  component_type: string;
  contract_version: number;
  definition: Record<string, unknown>;
  definition_fingerprint: string;
  author_id: string;
  created_at: string;
}

export interface PrototypeRestoreInput {
  team_id: string;
  asset_id: string;
  page_key: string;
  request_id: string;
  base_version: number;
  restore_version: number;
}

export const prototypeApi = {
  listProjects: (teamId: string, options?: RequestOptions) =>
    metaPost<{ items: Asset[] }>('prototype/project/list', { team_id: teamId }, options),

  getProject: (teamId: string, assetId: string, options?: RequestOptions) =>
    metaPost<PrototypeProjectAccess>(
      'prototype/project/get',
      { team_id: teamId, asset_id: assetId },
      options,
    ),

  createProject: (
    teamId: string,
    input: { name: string; visibility?: 'team' | 'private' | 'restricted' },
  ) => metaPost<Asset>('prototype/project/create', { team_id: teamId, ...input }),

  listPages: (teamId: string, assetId: string, options?: RequestOptions) =>
    metaPost<{ items: PrototypePageSummary[] }>(
      'prototype/page/list',
      { team_id: teamId, asset_id: assetId },
      options,
    ),

  history: (teamId: string, assetId: string, pageKey: string, options?: RequestOptions) =>
    metaPost<{ items: PrototypePageHistoryItem[] }>(
      'prototype/page/history',
      { team_id: teamId, asset_id: assetId, page_key: pageKey },
      options,
    ),

  getPage: (
    teamId: string,
    assetId: string,
    pageKey: string,
    version?: number,
    options?: RequestOptions,
  ) =>
    metaPost<PrototypePageVersion>(
      'prototype/page/get',
      {
        team_id: teamId,
        asset_id: assetId,
        page_key: pageKey,
        ...(version === undefined ? {} : { version }),
      },
      options,
    ),

  restore: (input: PrototypeRestoreInput) =>
    metaPost<PrototypePageVersion>('prototype/page/restore', { ...input }),

  getContract: (
    teamId: string,
    assetId: string,
    componentType: string,
    contractVersion: number,
    options?: RequestOptions,
  ) =>
    metaPost<PrototypeContract>(
      'prototype/contract/get',
      {
        team_id: teamId,
        asset_id: assetId,
        component_type: componentType,
        contract_version: contractVersion,
      },
      options,
    ),
};

export function isPrototypeConflict(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === 409 || error.code === '409' || error.code === 'prototype_conflict')
  );
}
