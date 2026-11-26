import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Modal } from 'tea-component';
import {
  isPrototypeConflict,
  prototypeApi,
  type PrototypePageVersion,
} from '@/lib/api/prototypes';
import { getErrorMessage } from '@/lib/error-message';
import { newPrototypeRequestId } from '../utils';

type RestorePhase = 'confirm' | 'refresh' | 'reconfirm';

export function RestoreVersionDialog({
  teamId,
  assetId,
  projectName,
  pageKey,
  restoreVersion,
  initialBaseVersion,
  onRefresh,
  onRestored,
  onClose,
}: {
  teamId: string;
  assetId: string;
  projectName: string;
  pageKey: string;
  restoreVersion: number;
  initialBaseVersion: number;
  onRefresh: () => Promise<number>;
  onRestored: (version: PrototypePageVersion) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<RestorePhase>('confirm');
  const [baseVersion, setBaseVersion] = useState(initialBaseVersion);
  const [requestId, setRequestId] = useState(newPrototypeRequestId);
  const [busy, setBusy] = useState<'restore' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refreshLatest() {
    setBusy('refresh');
    setError(null);
    try {
      const latest = await onRefresh();
      setBaseVersion(latest);
      setPhase('reconfirm');
    } catch (cause) {
      setPhase('refresh');
      setError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    setError(null);
    const activeRequestId = phase === 'reconfirm' ? newPrototypeRequestId() : requestId;
    if (phase === 'reconfirm') setRequestId(activeRequestId);
    try {
      const restored = await prototypeApi.restore({
        team_id: teamId,
        asset_id: assetId,
        page_key: pageKey,
        request_id: activeRequestId,
        base_version: baseVersion,
        restore_version: restoreVersion,
      });
      if (
        restored.team_id !== teamId ||
        restored.asset_id !== assetId ||
        restored.page_key !== pageKey ||
        restored.restore_version !== restoreVersion
      ) {
        throw new Error(t('prototypes.error.mismatchedResponse'));
      }
      onRestored(restored);
      onClose();
    } catch (cause) {
      if (isPrototypeConflict(cause)) {
        setPhase('refresh');
        setBusy(null);
        await refreshLatest();
        return;
      }
      setError(getErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const refreshing = busy === 'refresh';
  const restoring = busy === 'restore';
  const primaryAction = phase === 'refresh' ? refreshLatest : restore;
  const primaryText = refreshing
    ? t('prototypes.restore.refreshing')
    : restoring
      ? t('prototypes.restore.submitting')
      : phase === 'refresh'
        ? t('prototypes.restore.refresh')
        : phase === 'reconfirm'
          ? t('prototypes.restore.reconfirm')
          : error
            ? t('prototypes.restore.retry')
            : t('prototypes.restore.submit');

  return (
    <Modal
      visible
      caption={t('prototypes.restore.caption')}
      size="s"
      onClose={onClose}
      disableEscape={busy !== null}
      disableCloseIcon={busy !== null}
    >
      <Modal.Body>
        <Form>
          <Form.Item label={t('prototypes.restore.project')}>
            <Form.Text>{projectName}</Form.Text>
          </Form.Item>
          <Form.Item label={t('prototypes.restore.page')}>
            <Form.Text>{pageKey}</Form.Text>
          </Form.Item>
          <Form.Item label={t('prototypes.restore.target')}>
            <Form.Text>V{restoreVersion}</Form.Text>
          </Form.Item>
          <Form.Item label={t('prototypes.restore.base')}>
            <Form.Text>V{baseVersion}</Form.Text>
          </Form.Item>
        </Form>
        <Alert type="info">{t('prototypes.restore.description')}</Alert>
        {phase === 'reconfirm' && (
          <Alert type="warning">
            {t('prototypes.restore.conflict', { version: baseVersion })}
          </Alert>
        )}
        {phase === 'refresh' && !error && (
          <Alert type="warning">{t('prototypes.restore.conflictRefresh')}</Alert>
        )}
        {error && (
          <Alert type="error">
            {error}
            <div className="_prototype-retry-hint">{t('prototypes.restore.retryHint')}</div>
          </Alert>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          loading={busy !== null}
          disabled={busy !== null}
          onClick={() => void primaryAction()}
          data-testid="prototype-restore"
        >
          {primaryText}
        </Button>
        <Button onClick={onClose} disabled={busy !== null}>
          {t('prototypes.action.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
