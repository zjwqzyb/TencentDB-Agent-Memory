import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Form, Input, Modal, Select } from 'tea-component';
import { prototypeApi } from '@/lib/api/prototypes';
import type { Asset } from '@/lib/api/types';
import { getErrorMessage } from '@/lib/error-message';

type Visibility = 'team' | 'private' | 'restricted';

export function CreateProjectDialog({
  teamId,
  teamName,
  onClose,
  onCreated,
}: {
  teamId: string;
  teamName: string;
  onClose: () => void;
  onCreated: (asset: Asset) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    setError(null);
    try {
      const asset = await prototypeApi.createProject(teamId, {
        name: trimmedName,
        visibility,
      });
      if (asset.team_id !== teamId || asset.asset_type !== 'prototype') {
        throw new Error(t('prototypes.error.mismatchedResponse'));
      }
      onCreated(asset);
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible
      caption={t('prototypes.create.caption')}
      size="s"
      onClose={onClose}
      disableEscape={busy}
      disableCloseIcon={busy}
    >
      <Modal.Body>
        <Form>
          <Form.Item label={t('prototypes.create.team')}>
            <Form.Text>{teamName} · {teamId}</Form.Text>
          </Form.Item>
          <Form.Item label={t('prototypes.create.name')} required>
            <Input
              autoFocus
              size="full"
              value={name}
              maxLength={250}
              onChange={setName}
              placeholder={t('prototypes.create.name.placeholder')}
              data-testid="prototype-project-name"
            />
          </Form.Item>
          <Form.Item
            label={t('prototypes.create.visibility')}
            extra={t('prototypes.create.visibility.hint')}
          >
            <Select
              size="full"
              value={visibility}
              onChange={(value) => setVisibility(value as Visibility)}
              options={[
                { value: 'team', text: t('prototypes.visibility.team') },
                { value: 'private', text: t('prototypes.visibility.private') },
                { value: 'restricted', text: t('prototypes.visibility.restricted') },
              ]}
            />
          </Form.Item>
          {error && (
            <Form.Item>
              <Alert type="error">{error}</Alert>
            </Form.Item>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          loading={busy}
          disabled={!name.trim() || busy}
          onClick={() => void submit()}
          data-testid="prototype-create-submit"
        >
          {t('prototypes.create.submit')}
        </Button>
        <Button onClick={onClose} disabled={busy}>
          {t('prototypes.action.cancel')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
