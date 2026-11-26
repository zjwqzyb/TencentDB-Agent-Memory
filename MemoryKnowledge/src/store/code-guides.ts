import type Database from 'better-sqlite3';
import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const label = z.string().trim().min(1).max(240);
// The live fetcher records a 12-character Git prefix. The index version and
// content hash bind each citation to the exact indexed bytes.
const commitId = z.string().regex(/^(?:[0-9a-f]{7,40}|[0-9a-f]{64})$/);
export const guideInput = z
  .object({
    id: identifier,
    title: label,
    topic: label,
    commit: commitId,
    indexVersion: identifier,
    steps: z
      .array(
        z
          .object({
            id: identifier,
            title: label,
            description: z.string().trim().min(1).max(4000),
            kind: z.enum(['source', 'branch', 'async', 'parallel', 'unknown', 'reading']),
            anchors: z
              .array(
                z
                  .object({
                    edgeId: z.string().min(1).max(1024).optional(),
                    nodeId: z.string().min(1).max(1024),
                    filePath: z.string().min(1).max(1024),
                    line: z.number().int().positive(),
                    label,
                    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
                    assetId: identifier.optional(),
                    indexVersion: identifier.optional(),
                    commit: commitId.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(16),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    relations: z
      .array(
        z
          .object({
            from: identifier,
            to: identifier,
            kind: z.enum(['sequence', 'branch', 'async', 'parallel', 'unknown']),
            label,
            fromAnchor: z.number().int().nonnegative(),
            toAnchor: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(160)
      .optional(),
  })
  .strict()
  .refine(
    (doc) => new Set(doc.steps.map((s) => s.id)).size === doc.steps.length,
    'duplicate step IDs',
  )
  .refine(
    (doc) =>
      (doc.relations ?? []).every(
        (edge) =>
          doc.steps.find((s) => s.id === edge.from)?.anchors[edge.fromAnchor] &&
          doc.steps.find((s) => s.id === edge.to)?.anchors[edge.toAnchor],
      ),
    'missing relationship evidence',
  );

export type GuideDocument = z.infer<typeof guideInput>;
export type GuideEdition = GuideDocument & {
  revision: number;
  status: 'candidate' | 'published' | 'withdrawn';
  sourceAssets: string[];
  actor: string;
  updatedAt: string;
  origin?: 'curated_template' | 'indexed_symbol_search' | 'editor';
  operation?: 'generate' | 'save' | 'publish' | 'withdraw';
};

export class GuideConflict extends Error {}
export class CodeGuideStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS knowledge_code_guide_revision (
      service TEXT NOT NULL, asset TEXT NOT NULL REFERENCES knowledge_code_graph(code_graph_id) ON DELETE CASCADE,
      guide TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL,
      PRIMARY KEY(service, asset, guide, revision));
      CREATE TABLE IF NOT EXISTS knowledge_code_guide_feedback (
      service TEXT NOT NULL, asset TEXT NOT NULL, guide TEXT NOT NULL, revision INTEGER NOT NULL,
      step TEXT NOT NULL, actor TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(service,asset,guide,revision) REFERENCES knowledge_code_guide_revision(service,asset,guide,revision) ON DELETE CASCADE)`);
  }

  sourceAssets(service: string, asset: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT ref.value AS asset
      FROM knowledge_code_guide_revision AS g, json_each(g.document, '$.sourceAssets') AS ref
      WHERE service=? AND asset=? AND revision=(SELECT MAX(revision) FROM knowledge_code_guide_revision
      WHERE service=g.service AND asset=g.asset AND guide=g.guide)`,
      )
      .all(service, asset) as { asset: string }[];
    return [...new Set([asset, ...rows.map((r) => r.asset)])];
  }
  feedbackHistory(service: string, asset: string, guide: string) {
    return this.db
      .prepare(
        `SELECT revision, step AS stepId, actor, message, created_at AS createdAt
      FROM knowledge_code_guide_feedback WHERE service=? AND asset=? AND guide=? ORDER BY rowid DESC`,
      )
      .all(service, asset, guide);
  }
  list(service: string, asset: string, editorial = false): GuideEdition[] {
    const rows = this.db
      .prepare(
        `SELECT document FROM knowledge_code_guide_revision AS g
      WHERE service=? AND asset=? AND revision=(SELECT MAX(revision) FROM knowledge_code_guide_revision
      WHERE service=g.service AND asset=g.asset AND guide=g.guide AND (? OR status IN ('published','withdrawn')))
      AND (? OR status='published') ORDER BY guide`,
      )
      .all(service, asset, +editorial, +editorial) as { document: string }[];
    return rows.map((r) => JSON.parse(r.document));
  }
  history(service: string, asset: string, guide: string): GuideEdition[] {
    const rows = this.db
      .prepare(
        'SELECT document FROM knowledge_code_guide_revision WHERE service=? AND asset=? AND guide=? ORDER BY revision DESC',
      )
      .all(service, asset, guide) as { document: string }[];
    return rows.map((r) => JSON.parse(r.document));
  }
  save(
    service: string,
    asset: string,
    doc: GuideDocument,
    expected: number,
    status: GuideEdition['status'],
    actor: string,
    operation: NonNullable<GuideEdition['operation']>,
  ): GuideEdition {
    return this.db
      .transaction(() => {
        const prior = this.db
          .prepare(
            'SELECT document FROM knowledge_code_guide_revision WHERE service=? AND asset=? AND guide=? ORDER BY revision DESC LIMIT 1',
          )
          .get(service, asset, doc.id) as { document: string } | undefined;
        const current: GuideEdition | undefined = prior && JSON.parse(prior.document);
        if ((current?.revision ?? 0) !== expected) throw new GuideConflict();
        const sourceAssets = new Set(current?.sourceAssets ?? [asset]);
        for (const step of doc.steps)
          for (const ref of step.anchors) sourceAssets.add(ref.assetId ?? asset);
        const curated = doc.id === 'memhub-l1-search' || doc.id === 'memhub-build-queue';
        const origin =
          operation === 'generate'
            ? curated
              ? 'curated_template'
              : 'indexed_symbol_search'
            : (current?.origin ?? 'editor');
        const edition: GuideEdition = {
          ...doc,
          revision: expected + 1,
          status,
          actor,
          sourceAssets: [...sourceAssets],
          origin,
          operation,
          updatedAt: new Date().toISOString(),
        };
        this.db
          .prepare('INSERT INTO knowledge_code_guide_revision VALUES(?,?,?,?,?,?)')
          .run(service, asset, doc.id, edition.revision, status, JSON.stringify(edition));
        return edition;
      })
      .immediate();
  }
  feedback(
    service: string,
    asset: string,
    edition: GuideEdition,
    step: string,
    actor: string,
    message: string,
  ) {
    this.db
      .prepare('INSERT INTO knowledge_code_guide_feedback VALUES(?,?,?,?,?,?,?,?)')
      .run(
        service,
        asset,
        edition.id,
        edition.revision,
        step,
        actor,
        message,
        new Date().toISOString(),
      );
  }
}
