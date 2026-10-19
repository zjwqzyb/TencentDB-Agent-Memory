import type Database from 'better-sqlite3';
import type { CodeGraphEdge, CodeGraphNode, CodeGraphRequest, CodeGraphResponse } from '../../contracts/code-graph.js';
import type { StructuredContext } from './structured.js';
export interface NodeRow { id: string; kind: string; name: string; qualified_name: string; file_path: string; language: string; start_line: number; end_line: number; signature?: string | null; rowid?: number }
export interface EdgeRow { id: number; source: string; target: string; kind: string; line: number | null; col: number | null; metadata?: string | null }
export interface UnresolvedRow { id: number; from_node_id: string; reference_name: string; reference_kind: string; file_path: string; line: number; col: number | null }
/** Dispatcher owns snapshot/transaction/cursor. Mode implementations own only bounded query state. */
export interface StructuredModeContext {
  db: Database.Database;
  ctx: StructuredContext;
  request: CodeGraphRequest;
  result: CodeGraphResponse;
  root?: NodeRow;
  state?: unknown;
  limits: { nodes: number; edges: number; maxNodes: number; maxEdges: number; depth: number; rows: number };
  remaining(): number;
  consume(rows: number): void;
  lookup(id: string): NodeRow | undefined;
  readNodes(after: number, limit: number): NodeRow[];
  readEdges(after: number, limit: number): EdgeRow[];
  readUnresolved(after: number, limit: number): UnresolvedRow[];
  adjacent(id: string, side: 'source' | 'target', kind: string, after: number): EdgeRow | undefined;
  unresolvedFrom(id: string, after: number, limit: number): UnresolvedRow[];
  hasUnresolved: boolean;
  toNode(row: NodeRow): CodeGraphNode;
  toEdge(row: EdgeRow, source: NodeRow): CodeGraphEdge;
  id(raw: string): string;
  rawId(id: string): string | null;
  setContinuation(state: unknown): void;
}
