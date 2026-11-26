import { javaEdgeValidator } from './structured-java.js';
import { typescriptEdgeValidator } from './structured-typescript.js';
import type { EdgeRow, NodeRow } from './structured-mode-context.js';

interface Options {
  db: Parameters<typeof javaEdgeValidator>[0]['db'];
  projectRoot: string;
  sourceBytes: number;
  takeRow(): boolean;
  warn(warning: string): void;
  expire(): void;
  addUnresolved(edge: EdgeRow, source: NodeRow, expression: string): void;
}
type Budget = 'source_byte_budget' | 'scan_budget';
type Validator = ((edge: EdgeRow, source: NodeRow, target: NodeRow) => boolean) & { deferred(): Budget | null };

export function edgeValidator(options: Options): Validator {
  const java = javaEdgeValidator(options);
  const typescript = typescriptEdgeValidator(options);
  const accept = (edge: EdgeRow, source: NodeRow, target: NodeRow): boolean => {
    if (source.language === 'java') return java(edge, source, target);
    if (source.language === 'typescript' || source.language === 'javascript') return typescript(edge, source, target);
    return true;
  };
  return Object.assign(accept, { deferred: () => java.deferred() ?? typescript.deferred() });
}
