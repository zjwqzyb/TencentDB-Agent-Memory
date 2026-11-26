import { useTranslation } from 'react-i18next';
import { Alert, Button, StatusTip } from 'tea-component';
import { GuideStepFeedback } from '../components/CodeGuideEditor';
import type { CodeGraphGuide, CodeGraphGuideRelation } from '@/lib/api/knowledge-api';

export function CodeGraphGuidePanel({
  guides,
  activeGuide,
  activeStepIndex,
  activeAnchorIndex,
  loading,
  error,
  indexVersion,
  commit,
  assetId,
  onSelectGuide,
  onSelectStep,
  onSelectAnchor,
  onReturn,
}: {
  guides: CodeGraphGuide[];
  activeGuide: CodeGraphGuide | null;
  activeStepIndex: number;
  activeAnchorIndex: number;
  loading: boolean;
  error: string;
  indexVersion: string | null;
  commit: string | null;
  assetId: string;
  onSelectGuide: (guide: CodeGraphGuide) => void;
  onSelectStep: (index: number) => void;
  onSelectAnchor: (guide: CodeGraphGuide, stepIndex: number, anchorIndex: number) => void;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  const activeStep = activeGuide?.steps[activeStepIndex];
  const activeRelations = activeGuide?.relations?.filter(
    (relation) => relation.from === activeStep?.id || relation.to === activeStep?.id,
  );
  const versionMatches =
    !!activeGuide &&
    (!indexVersion || activeGuide.indexVersion === indexVersion) &&
    (!commit || activeGuide.commit === commit);
  const guideErrorMessage =
    error === 'asset_mismatch'
      ? t('code.graph.guideAssetMismatch')
      : error === 'version_mismatch'
        ? t('code.graph.guideVersionMismatch')
        : error === 'not_found'
          ? t('code.graph.guideNotFound')
          : t('code.graph.guideError');

  return (
    <section
      className="_codegraph-guide-panel"
      data-testid="code-graph-guide-panel"
      aria-label={t('code.graph.guidedReader')}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const target = event.target as HTMLElement;
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
        if (event.key === 'ArrowRight' && activeGuide && activeStepIndex < activeGuide.steps.length - 1) {
          event.preventDefault();
          onSelectStep(activeStepIndex + 1);
        }
        if (event.key === 'ArrowLeft' && activeStepIndex > 0) {
          event.preventDefault();
          onSelectStep(activeStepIndex - 1);
        }
      }}
    >
      <h3>{t('code.graph.guidedReader')}</h3>
      {loading && <StatusTip status="loading" />}
      {error && <Alert type="error">{guideErrorMessage}</Alert>}
      {!loading && !error && !guides.length && <p>{t('code.graph.noGuides')}</p>}
      {!!guides.length && (
        <ul className="_codegraph-guide-list" aria-label={t('code.graph.guideTopics')}>
          {guides.map((guide) => (
            <li key={guide.id}>
              <button
                type="button"
                aria-pressed={guide.id === activeGuide?.id}
                onClick={() => onSelectGuide(guide)}
              >
                <span>{guide.topic}</span>
                <strong>{guide.title}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
      {activeGuide && activeStep && (
        <div className="_codegraph-active-guide">
          <p className="_codegraph-note">
            {t('code.graph.guideMetadata', {
              revision: activeGuide.revision,
              commit: activeGuide.commit.slice(0, 10),
              index: activeGuide.indexVersion,
            })}
          </p>
          {!versionMatches && <Alert type="warning">{t('code.graph.guideVersionMismatch')}</Alert>}
          <ol className="_codegraph-guide-steps">
            {activeGuide.steps.map((step, index) => (
              <li key={step.id} className={index === activeStepIndex ? 'is-current' : undefined}>
                <button
                  type="button"
                  id={`code-guide-step-${index}`}
                  aria-current={index === activeStepIndex ? 'step' : undefined}
                  disabled={!versionMatches}
                  onClick={() => onSelectStep(index)}
                >
                  <span>{t(`code.graph.guide.kind.${step.kind}`)}</span>
                  <strong>{step.title}</strong>
                </button>
                {index === activeStepIndex && (
                  <div className="_codegraph-guide-step-detail">
                    <p>{step.description}</p>
                    <ul>
                      {step.anchors.map((anchor, anchorIndex) => (
                        <li key={`${anchor.nodeId}:${anchor.line}:${anchorIndex}`}>
                          <button
                            type="button"
                            disabled={!versionMatches}
                            aria-current={anchorIndex === activeAnchorIndex ? 'true' : undefined}
                            onClick={() => onSelectAnchor(activeGuide, index, anchorIndex)}
                          >
                            <strong>{anchor.label}</strong>
                            <span>
                              {anchor.filePath}:{anchor.line}
                              {anchor.contentHash ? ` · ${anchor.contentHash.slice(0, 8)}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {activeGuide && (
                      <GuideStepFeedback
                        assetId={assetId}
                        guideId={activeGuide.id}
                        revision={activeGuide.revision}
                        stepId={activeStep.id}
                      />
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
          <div className="_codegraph-actions">
            <Button onClick={onReturn}>{t('code.graph.guideReturn')}</Button>
            <Button disabled={!versionMatches || activeStepIndex === 0} onClick={() => onSelectStep(activeStepIndex - 1)}>
              {t('code.graph.guidePrevious')}
            </Button>
            <Button
              disabled={!versionMatches || activeStepIndex >= activeGuide.steps.length - 1}
              onClick={() => onSelectStep(activeStepIndex + 1)}
            >
              {t('code.graph.guideNext')}
            </Button>
          </div>
          {!!activeRelations?.length && (
            <div className="_codegraph-guide-relations">
              <h4>{t('code.graph.guideRelations')}</h4>
              <ul>
                {activeRelations.map((relation) => (
                  <GuideRelationItem
                    key={`${relation.from}:${relation.to}:${relation.fromAnchor}:${relation.toAnchor}`}
                    relation={relation}
                    guide={activeGuide}
                    onSelect={onSelectAnchor}
                  />
                ))}
              </ul>
            </div>
          )}
          {activeGuide.observation ? (
            <details className="_codegraph-guide-observation">
              <summary>{t('code.graph.guideObservation')}</summary>
              <p>
                {t('code.graph.guideObservationScope', {
                  commit: activeGuide.observation.commit.slice(0, 10),
                  scope: activeGuide.observation.scope,
                })}
              </p>
              <p className="_codegraph-note">
                {t('code.graph.guideObservationSource', {
                  source: activeGuide.observation.source,
                })}
              </p>
              <ul>
                {activeGuide.observation.events.map((event) => (
                  <li key={event}>{event}</li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="_codegraph-note">{t('code.graph.guideStaticEvidenceOnly')}</p>
          )}
        </div>
      )}
    </section>
  );
}

function GuideRelationItem({
  relation,
  guide,
  onSelect,
}: {
  relation: CodeGraphGuideRelation;
  guide: CodeGraphGuide;
  onSelect: (guide: CodeGraphGuide, stepIndex: number, anchorIndex: number) => void;
}) {
  const { t } = useTranslation();
  const fromIndex = guide.steps.findIndex((step) => step.id === relation.from);
  const toIndex = guide.steps.findIndex((step) => step.id === relation.to);
  const from = guide.steps[fromIndex];
  const to = guide.steps[toIndex];
  const separator = relation.kind === 'sequence' ? '→' : '—';
  return (
    <li>
      <div className="_codegraph-guide-relation-endpoints">
        <button
          type="button"
          disabled={!from || relation.fromAnchor >= from.anchors.length}
          onClick={() => onSelect(guide, fromIndex, relation.fromAnchor)}
        >
          <strong>{from?.title ?? relation.from}</strong>
          <span>
            {from?.anchors[relation.fromAnchor]?.label ?? relation.fromAnchor}
          </span>
        </button>
        <span aria-hidden="true">{separator}</span>
        <button
          type="button"
          disabled={!to || relation.toAnchor >= to.anchors.length}
          onClick={() => onSelect(guide, toIndex, relation.toAnchor)}
        >
          <strong>{to?.title ?? relation.to}</strong>
          <span>
            {to?.anchors[relation.toAnchor]?.label ?? relation.toAnchor}
          </span>
        </button>
      </div>
      <small>
        {t(`code.graph.guide.relation.${relation.kind}`)} · {relation.label}
      </small>
    </li>
  );
}
