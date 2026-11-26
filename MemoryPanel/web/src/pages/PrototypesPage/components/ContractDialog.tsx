import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Modal } from 'tea-component';
import { prototypeApi, type PrototypeContract } from '@/lib/api/prototypes';
import { getErrorMessage } from '@/lib/error-message';

export function ContractDialog({
  teamId,
  assetId,
  componentType,
  contractVersion,
  onClose,
}: {
  teamId: string;
  assetId: string;
  componentType: string;
  contractVersion: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [contract, setContract] = useState<PrototypeContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setContract(null);
    setError(null);
    prototypeApi
      .getContract(teamId, assetId, componentType, contractVersion, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (
          result.team_id !== teamId ||
          result.asset_id !== assetId ||
          result.component_type !== componentType ||
          result.contract_version !== contractVersion
        ) {
          throw new Error(t('prototypes.error.mismatchedResponse'));
        }
        setContract(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(getErrorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [teamId, assetId, componentType, contractVersion, t]);

  return (
    <Modal
      visible
      caption={`${componentType} · contract V${contractVersion}`}
      size="l"
      onClose={onClose}
    >
      <Modal.Body>
        <div data-testid="prototype-contract-dialog">
          {loading && <Alert type="info">{t('prototypes.contract.loading')}</Alert>}
          {error && <Alert type="error">{error}</Alert>}
          {contract && (
            <pre className="_prototype-code">{JSON.stringify(contract.definition, null, 2)}</pre>
          )}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose}>{t('prototypes.action.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
