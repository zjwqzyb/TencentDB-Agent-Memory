/**
 * ApiKeyPanel — User_Key 管理（组织与权限分组）。
 *
 * 精简版：列表只展示 4 个核心字段——key_id / user_id / key_prefix / 创建时间，
 * 不再展示「名称」「过期时间」两列（对应地，新建弹窗也不再要求填写名称）。
 * Tea 组件：列表用 Table + autotip，头部用 Justify + H3，
 * 破坏性操作统一走 Modal.confirm 二次确认，新建弹窗复用全站统一的 Modal 外壳。
 *
 * 后端链路：新面板（stateless）走 meta action `user-key/list|create|revoke`，
 * 由 Control 透明代理到内核 /v3/meta。前端不直接调内核，也不走旧 REST 路径。
 * owner 由登录 user_key 推断，前端不用也不能传别人的 user_id —— 天然满足
 * 「用户只能看到 / 管理自己的 key」。
 *
 * 安全设计（内核既有行为，不是本组件的取舍）：
 *   - key 明文只在 `create` 响应里出现这一次，之后 list/get 都不会再回传；
 *   - `key_prefix` 是内核给的可展示前缀（如 `sk-mem-ab12****`），用于免密识别
 *     具体是哪把 key，不等同于明文；
 *   - 因此列表里已存在的 key 无法「展开显示完整 key」，只能吊销。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, type UserKey } from '@/lib/teamApi';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;
const INSTALL_COMMAND =
  'python3 agents/codex/mcp-hooks/install.py --project-dir "/absolute/path/to/workspace"';

function CopyableCode({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <div className="_memory-apikey-guide-code-row">
      <pre className="_memory-apikey-guide-code">
        <code>{value}</code>
      </pre>
      <Copy text={value}>
        <Button>{copyLabel}</Button>
      </Copy>
    </div>
  );
}

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  const panelOrigin = window.location.origin;
  const credentialConfig = JSON.stringify(
    {
      name: 'REPLACE_WITH_PROJECT_NAME',
      team_name: 'REPLACE_WITH_TEAM_NAME',
      base_url: panelOrigin,
      service_id: auth?.instance_id || 'REPLACE_WITH_SERVICE_ID',
      user_id: auth?.user_id || 'REPLACE_WITH_USER_ID',
      user_key: 'REPLACE_WITH_USER_KEY',
      team_id: 'REPLACE_WITH_TEAM_ID',
      agent_id: 'REPLACE_WITH_AGENT_ID',
    },
    null,
    2,
  );
  const projectsConfig = JSON.stringify(
    {
      projects: [
        {
          key: 'example-project',
          name: 'example-project',
          path: '/absolute/path/to/workspace',
          enabled: true,
          team: 'REPLACE_WITH_TEAM_NAME',
          agent: 'REPLACE_WITH_AGENT_NAME',
          capture_conversations: false,
          transport: 'http',
          config_file: '/absolute/path/to/.codex/tencent-memory/config/example-project.json',
        },
      ],
    },
    null,
    2,
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      // 按创建时间倒序（内核未必保证顺序）
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      // 已吊销的 key 不再展示
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 新建弹窗 ----
  // 不再收集「名称」——列表本身也不展示名称列，创建时无需再让用户填写。
  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  // 刚创建出来的 key（含完整明文，仅展示一次）
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({ keyId: key.key_id, secret: key.key_value });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t('apiKey.confirm.revoke.desc'),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="_memory-apikey-body">
      {/* ===== 刚创建的 Key 提示（仅展示一次） ===== */}
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  // 复制成功后自动关闭完整 Key 显示，避免明文长时间停留在屏幕上
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      {/* ===== 页面头部（Justify 左右布局） ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button
              type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
              data-guide="create-key"
            >
              <AddIcon size={14} />
              {t('apiKey.create')}
            </Button>
          ) : null
        }
      />

      {/* ===== Key 列表：key_id / key_prefix / 创建时间 + 操作 ===== */}
      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  style={{
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              render: (key) => (
                <Text parent="code" style={{ fontSize: 12 }}>
                  {key.key_prefix || '—'}
                </Text>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: 100,
              align: 'right',
              render: (key) => (
                <Button
                  type="text"
                  disabled={!!key.revoked_at}
                  onClick={() => void handleDelete(key)}
                >
                  {t('apiKey.revoke')}
                </Button>
              ),
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                  <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      {/* ===== Codex MCP + Hooks 接入 ===== */}
      <Card>
        <Card.Body title={t('apiKey.endpoint.title')}>
          <Text theme="text" parent="div" className="_memory-apikey-guide-intro">
            {t('apiKey.endpoint.intro')}
          </Text>

          <div className="_memory-apikey-guide-connections">
            <div>
              <Text theme="label" parent="div" className="_memory-apikey-guide-label">
                {t('apiKey.endpoint.panelRoot')}
              </Text>
              <CopyableCode value={panelOrigin} copyLabel={t('apiKey.endpoint.copyAddress')} />
              <Text theme="weak" parent="div" className="_memory-apikey-guide-hint">
                {t('apiKey.endpoint.panelRootHint')}
              </Text>
            </div>
            {auth?.instance_id && (
              <div>
                <Text theme="label" parent="div" className="_memory-apikey-guide-label">
                  {t('apiKey.endpoint.current')}
                </Text>
                <CopyableCode
                  value={auth.instance_id}
                  copyLabel={t('apiKey.endpoint.copyServiceId')}
                />
              </div>
            )}
          </div>

          <ol className="_memory-apikey-guide-steps">
            <li className="_memory-apikey-guide-step">
              <Text theme="label" parent="div" className="_memory-apikey-guide-step-title">
                {t('apiKey.endpoint.step.install.title')}
              </Text>
              <Text theme="text" parent="div" className="_memory-apikey-guide-step-desc">
                {t('apiKey.endpoint.step.install.desc')}
              </Text>
              <CopyableCode value={INSTALL_COMMAND} copyLabel={t('apiKey.endpoint.copyCommand')} />
            </li>
            <li className="_memory-apikey-guide-step">
              <Text theme="label" parent="div" className="_memory-apikey-guide-step-title">
                {t('apiKey.endpoint.step.credentials.title')}
              </Text>
              <Text theme="text" parent="div" className="_memory-apikey-guide-step-desc">
                {t('apiKey.endpoint.step.credentials.desc')}
              </Text>
              <CopyableCode value={credentialConfig} copyLabel={t('apiKey.endpoint.copyConfig')} />
            </li>
            <li className="_memory-apikey-guide-step">
              <Text theme="label" parent="div" className="_memory-apikey-guide-step-title">
                {t('apiKey.endpoint.step.projects.title')}
              </Text>
              <Text theme="text" parent="div" className="_memory-apikey-guide-step-desc">
                {t('apiKey.endpoint.step.projects.desc')}
              </Text>
              <CopyableCode value={projectsConfig} copyLabel={t('apiKey.endpoint.copyConfig')} />
            </li>
            <li className="_memory-apikey-guide-step">
              <Text theme="label" parent="div" className="_memory-apikey-guide-step-title">
                {t('apiKey.endpoint.step.restart.title')}
              </Text>
              <Text theme="text" parent="div" className="_memory-apikey-guide-step-desc">
                {t('apiKey.endpoint.step.restart.desc')}
              </Text>
            </li>
          </ol>
        </Card.Body>
      </Card>
      {/* ===== 新建弹窗：只需设置「过期时间」（可留空＝永不过期），不再需要名称 ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
