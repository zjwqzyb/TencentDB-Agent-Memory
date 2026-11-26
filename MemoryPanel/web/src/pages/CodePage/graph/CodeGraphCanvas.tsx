import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sigma from 'sigma';
import { MultiDirectedGraph } from 'graphology';
import type {
  CodeGraphEdge,
  CodeGraphNode,
  CodeGraphResponse,
} from '@/lib/api/code-graph-contract';
import { nodeLocation, stablePositions, type Position } from './graph-model';

type Data = Pick<CodeGraphResponse, 'nodes' | 'edges'>;
interface CameraSnapshot {
  x: number;
  y: number;
  ratio: number;
  angle: number;
}
interface Props {
  data: Data;
  focusId?: string | null;
  selectedId?: string;
  highlightedEdges?: Set<string>;
  cameraKey?: string;
  focused?: boolean;
  onSelect: (node: CodeGraphNode) => void;
  onSelectEdge?: (edge: CodeGraphEdge) => void;
  onUnavailable: () => void;
}

interface ContainerSize {
  width: number;
  height: number;
}

interface FocusedCard {
  node: CodeGraphNode;
  role: 'caller' | 'callee' | 'focus' | 'both' | 'related';
}

interface FocusedLayout {
  orientation: 'horizontal' | 'vertical';
  cards: FocusedCard[];
  positions: Map<string, Position>;
  cardWidth: number;
  cardHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

function color(token: string, fallback: string, element: Element = document.body) {
  return getComputedStyle(element).getPropertyValue(token).trim() || fallback;
}

function shortLocation(node: CodeGraphNode) {
  return `${node.filePath.split('/').at(-1) ?? node.filePath}:${node.startLine}`;
}

function edgeDescription(data: Data, edge: CodeGraphEdge) {
  const source = data.nodes.find((node) => node.id === edge.source)?.name ?? edge.source;
  const target = data.nodes.find((node) => node.id === edge.target)?.name ?? edge.target;
  const evidence = edge.evidence
    .map((item) => `${item.filePath}:${item.line}${item.column ? `:${item.column}` : ''}`)
    .join('；');
  return [
    `${source} → ${target}`,
    edge.kind,
    edge.count !== undefined ? `×${edge.count}` : undefined,
    edge.resolution,
    edge.complete === false ? 'partial' : undefined,
    evidence,
  ]
    .filter(Boolean)
    .join(' · ');
}

const EDGE_KIND_TOKENS: Record<string, string> = {
  calls: '--tea-color-text-secondary',
  imports: '--tea-color-border-brand-default',
  extends: '--tea-color-text-success-default',
  implements: '--tea-color-text-warning-default',
  references: '--tea-color-text-tertiary',
};

function buildFocusedLayout(
  data: Data,
  focusId: string | null | undefined,
  size: ContainerSize,
): FocusedLayout | null {
  if (!focusId || size.width === 0 || size.height === 0) return null;
  const focusNode = data.nodes.find((node) => node.id === focusId);
  if (!focusNode) return null;

  const callers = new Map<string, CodeGraphNode>();
  const callees = new Map<string, CodeGraphNode>();
  for (const edge of data.edges) {
    if (edge.target === focusId && edge.source !== focusId) {
      const node = data.nodes.find((item) => item.id === edge.source);
      if (node) callers.set(node.id, node);
    } else if (edge.source === focusId && edge.target !== focusId) {
      const node = data.nodes.find((item) => item.id === edge.target);
      if (node) callees.set(node.id, node);
    }
  }
  const isCompactStar =
    data.nodes.length <= 12 &&
    data.edges.length <= 24 &&
    !data.edges.some((edge) => edge.source === edge.target) &&
    [...callers.keys()].every((id) => !callees.has(id)) &&
    callers.size + callees.size + 1 === data.nodes.length &&
    callers.size <= 6 &&
    callees.size <= 6;

  const orientation = size.width < 480 ? 'vertical' : 'horizontal';
  const cardWidth =
    orientation === 'horizontal'
      ? Math.min(Math.max(size.width * 0.3, 148), 192)
      : Math.min(size.width - 16, 148);
  const cardHeight = orientation === 'horizontal' ? 80 : 84;
  const compactSpacing = cardHeight + 12;
  const maxColumnCount = Math.max(callers.size, callees.size, 1);
  const compactHeight = cardHeight + (maxColumnCount - 1) * compactSpacing;
  const compactFits = orientation === 'vertical' || compactHeight <= size.height;

  if (isCompactStar && compactFits) {
    const canvasHeight =
      orientation === 'vertical' ? Math.max(720, data.nodes.length * 104 + 72) : size.height;
    const positions = new Map<string, Position>();
    const cards: FocusedCard[] = [];
    const toGraphY = (screenY: number) => canvasHeight - screenY;
    if (orientation === 'horizontal') {
      const columns =
        callers.size > 0 && callees.size > 0
          ? [
              { x: 0.18, nodes: [...callers.values()], role: 'caller' as const },
              { x: 0.5, nodes: [focusNode], role: 'focus' as const },
              { x: 0.82, nodes: [...callees.values()], role: 'callee' as const },
            ]
          : callers.size > 0
            ? [
                { x: 0.25, nodes: [...callers.values()], role: 'caller' as const },
                { x: 0.75, nodes: [focusNode], role: 'focus' as const },
              ]
            : callees.size > 0
              ? [
                  { x: 0.25, nodes: [focusNode], role: 'focus' as const },
                  { x: 0.75, nodes: [...callees.values()], role: 'callee' as const },
                ]
              : [{ x: 0.5, nodes: [focusNode], role: 'focus' as const }];
      const centerY = canvasHeight / 2;
      for (const column of columns) {
        column.nodes.forEach((node, index) => {
          const count = column.nodes.length;
          const y = count === 1 ? centerY : centerY + (index - (count - 1) / 2) * compactSpacing;
          positions.set(node.id, {
            x: Math.round(column.x * size.width),
            y: Math.round(toGraphY(y)),
          });
          cards.push({ node, role: column.role });
        });
      }
    } else {
      let nextY = 72;
      [...callers.values()].forEach((node) => {
        const y = nextY;
        nextY += 104;
        positions.set(node.id, { x: Math.round(size.width / 2), y: toGraphY(y) });
        cards.push({ node, role: 'caller' });
      });
      const focusY = nextY;
      nextY += 104;
      positions.set(focusNode.id, { x: Math.round(size.width / 2), y: toGraphY(focusY) });
      cards.push({ node: focusNode, role: 'focus' });
      [...callees.values()].forEach((node) => {
        const y = nextY;
        nextY += 104;
        positions.set(node.id, { x: Math.round(size.width / 2), y: toGraphY(y) });
        cards.push({ node, role: 'callee' });
      });
    }
    return {
      orientation,
      cards,
      positions,
      cardWidth,
      cardHeight,
      canvasWidth: size.width,
      canvasHeight,
    };
  }
  const graphPositions = stablePositions(data);
  const columns = new Map<number, { id: string; y: number }[]>();
  for (const node of data.nodes) {
    const position = graphPositions.get(node.id);
    if (!position) continue;
    const rows = columns.get(position.x) ?? [];
    rows.push({ id: node.id, y: position.y });
    columns.set(position.x, rows);
  }
  const rankedColumns = [...columns.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, rows]) => rows.sort((left, right) => right.y - left.y));

  const directCallers = new Set(
    data.edges
      .filter((edge) => edge.target === focusId && edge.source !== focusId)
      .map((edge) => edge.source),
  );
  const directCallees = new Set(
    data.edges
      .filter((edge) => edge.source === focusId && edge.target !== focusId)
      .map((edge) => edge.target),
  );
  const roleOf = (id: string): FocusedCard['role'] => {
    if (id === focusId) return 'focus';
    if (directCallers.has(id)) return directCallees.has(id) ? 'both' : 'caller';
    if (directCallees.has(id)) return 'callee';
    return 'related';
  };

  const screenPositions = new Map<string, { x: number; y: number }>();
  const cards: FocusedCard[] = [];
  let canvasWidth = size.width;
  let canvasHeight = size.height;
  const horizontalStart = cardWidth / 2 + 40;
  const horizontalStep = cardWidth + 72;
  const verticalStart = cardWidth / 2 + 24;
  const horizontalRowStart = cardHeight / 2 + 36;

  rankedColumns.forEach((rows, columnIndex) => {
    rows.forEach((row, rowIndex) => {
      const node = data.nodes.find((item) => item.id === row.id);
      if (!node) return;
      const x =
        orientation === 'horizontal'
          ? horizontalStart + columnIndex * horizontalStep
          : verticalStart + rowIndex * (cardWidth + 24);
      const y =
        orientation === 'horizontal'
          ? horizontalRowStart + rowIndex * (cardHeight + 48)
          : 72 + columnIndex * (cardHeight + 44);
      screenPositions.set(node.id, { x: Math.round(x), y: Math.round(y) });
      cards.push({ node, role: roleOf(node.id) });
      if (orientation === 'horizontal') {
        canvasWidth = Math.max(canvasWidth, x + cardWidth / 2 + 40);
        canvasHeight = Math.max(canvasHeight, y + cardHeight / 2 + 48);
      } else {
        canvasWidth = Math.max(canvasWidth, x + cardWidth / 2 + 24);
        canvasHeight = Math.max(canvasHeight, y + cardHeight / 2 + 72);
      }
    });
  });

  const positions = new Map<string, Position>();
  for (const [id, position] of screenPositions) {
    positions.set(id, {
      x: position.x,
      y: canvasHeight - position.y,
    });
  }

  return { orientation, cards, positions, cardWidth, cardHeight, canvasWidth, canvasHeight };
}

const MAX_CAMERA_CACHE_SIZE = 100;
const cameraCache = new Map<string, CameraSnapshot>();

function rememberCamera(key: string, state: CameraSnapshot) {
  cameraCache.delete(key);
  cameraCache.set(key, { ...state });
  if (cameraCache.size > MAX_CAMERA_CACHE_SIZE) {
    const oldestKey = cameraCache.keys().next().value;
    if (oldestKey !== undefined) cameraCache.delete(oldestKey);
  }
}

/** Camera-aligned canvas layer: curved parallel edges, explicit arrows and recursive loops. */
export function drawRelations(
  sigma: Sigma,
  canvas: HTMLCanvasElement,
  data: Data,
  selectedId?: string,
  highlightedEdges?: Set<string>,
) {
  const { width, height } = sigma.getDimensions(),
    ratio = window.devicePixelRatio || 1;
  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const base = color('--tea-color-text-tertiary', '#777', canvas),
    active = color('--tea-color-text-link-default', '#006eff', canvas);
  const groups = new Map<string, CodeGraphEdge[]>();
  for (const edge of data.edges) {
    const key = [edge.source, edge.target].sort().join('\u0000');
    const list = groups.get(key) ?? [];
    list.push(edge);
    groups.set(key, list);
  }
  const arrow = (x: number, y: number, angle: number) => {
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x - 9 * Math.cos(angle - 0.45), y - 9 * Math.sin(angle - 0.45));
    context.lineTo(x - 9 * Math.cos(angle + 0.45), y - 9 * Math.sin(angle + 0.45));
    context.closePath();
    context.fill();
  };
  for (const group of groups.values())
    group
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((edge, index) => {
        const from = sigma.getNodeDisplayData(edge.source),
          to = sigma.getNodeDisplayData(edge.target);
        if (!from || !to || from.hidden || to.hidden) return;
        const start = sigma.graphToViewport(
          sigma.getGraph().getNodeAttributes(edge.source) as Position,
        );
        const finish = sigma.graphToViewport(
          sigma.getGraph().getNodeAttributes(edge.target) as Position,
        );
        const relevant = highlightedEdges?.size
          ? highlightedEdges.has(edge.id)
          : !selectedId || edge.source === selectedId || edge.target === selectedId;
        context.globalAlpha = relevant ? 1 : 0.22;
        context.strokeStyle = relevant && selectedId ? active : base;
        context.fillStyle = context.strokeStyle;
        context.lineWidth = relevant && selectedId ? 2 : 1.3;
        context.setLineDash(edge.kind === 'implements' ? [6, 4] : []);
        let labelX: number, labelY: number;
        if (edge.source === edge.target) {
          const loop = 25 + index * 13,
            radius = sigma.scaleSize(to.size) + 3;
          const sx = start.x - radius * 0.7,
            sy = start.y - radius * 0.7;
          const tx = start.x + radius * 0.7,
            ty = sy;
          context.beginPath();
          context.moveTo(sx, sy);
          context.bezierCurveTo(
            start.x - loop * 1.4,
            start.y - loop * 2,
            start.x + loop * 1.4,
            start.y - loop * 2,
            tx,
            ty,
          );
          context.stroke();
          context.setLineDash([]);
          arrow(tx, ty, Math.atan2(ty - (start.y - loop * 2), tx - (start.x + loop * 1.4)));
          labelX = start.x;
          labelY = start.y - loop * 1.6;
        } else {
          const dx = finish.x - start.x,
            dy = finish.y - start.y,
            length = Math.hypot(dx, dy) || 1;
          // Canonical normal keeps reverse edges on distinct sides of the same pair.
          const orientation = edge.source < edge.target ? 1 : -1;
          const offset = group.length > 1 ? (index - (group.length - 1) / 2) * 32 * orientation : 0;
          const cx = (start.x + finish.x) / 2 - (dy / length) * offset;
          const cy = (start.y + finish.y) / 2 + (dx / length) * offset;
          const angle = Math.atan2(finish.y - cy, finish.x - cx),
            radius = sigma.scaleSize(to.size) + 3;
          const tx = finish.x - Math.cos(angle) * radius,
            ty = finish.y - Math.sin(angle) * radius;
          context.beginPath();
          context.moveTo(start.x, start.y);
          context.quadraticCurveTo(cx, cy, tx, ty);
          context.stroke();
          context.setLineDash([]);
          arrow(tx, ty, angle);
          labelX = (start.x + 2 * cx + tx) / 4;
          labelY = (start.y + 2 * cy + ty) / 4 - 5;
        }
        if (relevant && (data.edges.length <= 30 || selectedId)) {
          context.font = '11px sans-serif';
          context.textAlign = 'center';
          context.fillText(
            `${edge.kind}${edge.count !== undefined ? ` ×${edge.count}` : ''}`,
            labelX,
            labelY,
          );
        }
      });
  context.globalAlpha = 1;
  context.setLineDash([]);
}

export function CodeGraphCanvas({
  data,
  focusId,
  selectedId,
  highlightedEdges,
  cameraKey,
  focused = false,
  onSelect,
  onSelectEdge,
  onUnavailable,
}: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    renderer = useRef<Sigma>();
  const [containerSize, setContainerSize] = useState<ContainerSize>({
    width: 0,
    height: 0,
  });
  const layoutCache = useRef(new Map<string, Position>());
  const positions = useRef(new Map<string, Position>()),
    dataRef = useRef(data),
    selectedRef = useRef(selectedId),
    highlightedRef = useRef(highlightedEdges);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const edgeRefs = useRef(new Map<string, SVGPathElement>());
  const layoutRef = useRef<FocusedLayout | null>(null);
  const selectRef = useRef(onSelect),
    selectEdgeRef = useRef(onSelectEdge),
    unavailableRef = useRef(onUnavailable);
  const focusedLayout = useMemo(
    () => (focused ? buildFocusedLayout(data, focusId, containerSize) : null),
    [containerSize, data, focusId, focused],
  );
  const effectiveCameraKey = useMemo(
    () => (cameraKey ? `${cameraKey}:${focusedLayout?.orientation ?? 'default'}` : undefined),
    [cameraKey, focusedLayout],
  );
  const cameraKeyRef = useRef(effectiveCameraKey);
  const cameraRestored = useRef(false);
  layoutRef.current = focusedLayout;
  dataRef.current = data;
  selectedRef.current = selectedId;
  highlightedRef.current = highlightedEdges;
  selectRef.current = onSelect;
  selectEdgeRef.current = onSelectEdge;
  unavailableRef.current = onUnavailable;
  cameraKeyRef.current = effectiveCameraKey;
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const element = scrollRef.current;
    const updateSize = () => {
      setContainerSize({
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    cameraRestored.current = false;
  }, [effectiveCameraKey]);

  const updateOverlay = useCallback(() => {
    const sigma = renderer.current,
      layout = layoutRef.current,
      element = container.current;
    if (!sigma || !layout || !element) return;

    const centers = new Map<string, { x: number; y: number }>();
    for (const card of layout.cards) {
      const position = layout.positions.get(card.node.id);
      if (!position) continue;
      const center = sigma.graphToViewport(position);
      centers.set(card.node.id, center);
      const cardElement = cardRefs.current.get(card.node.id);
      if (cardElement) {
        cardElement.style.left = `${center.x}px`;
        cardElement.style.top = `${center.y}px`;
        cardElement.style.transform = 'translate(-50%, -50%)';
      }
    }

    const outgoingBySource = new Map<string, CodeGraphEdge[]>(),
      incomingByTarget = new Map<string, CodeGraphEdge[]>();
    for (const edge of data.edges) {
      const outgoing = outgoingBySource.get(edge.source) ?? [];
      outgoing.push(edge);
      outgoingBySource.set(edge.source, outgoing);
      const incoming = incomingByTarget.get(edge.target) ?? [];
      incoming.push(edge);
      incomingByTarget.set(edge.target, incoming);
    }
    const selfIndexes = new Map<string, number>();
    for (const edges of outgoingBySource.values())
      edges
        .filter((edge) => edge.source === edge.target)
        .forEach((edge, index) => selfIndexes.set(edge.id, index));
    const portAxis = layout.orientation === 'horizontal' ? 'y' : 'x';
    const sourceIndexes = new Map<string, number>(),
      targetIndexes = new Map<string, number>();
    for (const edges of outgoingBySource.values()) {
      edges
        .slice()
        .sort((left, right) => {
          const leftCenter = centers.get(left.target),
            rightCenter = centers.get(right.target);
          if (!leftCenter || !rightCenter) return 0;
          return leftCenter[portAxis] - rightCenter[portAxis];
        })
        .forEach((edge, index) => sourceIndexes.set(edge.id, index));
    }
    for (const edges of incomingByTarget.values()) {
      edges
        .slice()
        .sort((left, right) => {
          const leftCenter = centers.get(left.source),
            rightCenter = centers.get(right.source);
          if (!leftCenter || !rightCenter) return 0;
          return leftCenter[portAxis] - rightCenter[portAxis];
        })
        .forEach((edge, index) => targetIndexes.set(edge.id, index));
    }

    const halfWidth = layout.cardWidth / 2,
      halfHeight = layout.cardHeight / 2,
      maxIncidentCount = Math.max(
        1,
        ...[...outgoingBySource.values(), ...incomingByTarget.values()].map(
          (edges) => edges.length,
        ),
      ),
      portExtent =
        layout.orientation === 'horizontal'
          ? layout.cardHeight - 12
          : layout.cardWidth - 12,
      portSpacing = Math.min(28, portExtent / Math.max(1, maxIncidentCount - 1)),
      activeColor = color(
        '--tea-color-text-link-default',
        '#006eff',
        element,
      ),
      neutralColor = color('--tea-color-text-secondary', '#7f8fa6', element);
    for (const edge of data.edges) {
      const path = edgeRefs.current.get(edge.id),
        source = centers.get(edge.source),
        target = centers.get(edge.target);
      if (!path || !source || !target) continue;

      const sourceCount = outgoingBySource.get(edge.source)?.length ?? 1,
        targetCount = incomingByTarget.get(edge.target)?.length ?? 1,
        sourceIndex = sourceIndexes.get(edge.id) ?? 0,
        targetIndex = targetIndexes.get(edge.id) ?? 0,
        sourceOffset = (sourceIndex - (sourceCount - 1) / 2) * portSpacing,
        targetOffset = (targetIndex - (targetCount - 1) / 2) * portSpacing;
      let startX: number, startY: number, endX: number, endY: number;
      if (edge.source === edge.target) {
        const loopIndex = selfIndexes.get(edge.id) ?? 0;
        const loopSize = 34 + loopIndex * 18;
        startX = source.x + halfWidth;
        startY = source.y + 10;
        endX = source.x + halfWidth * 0.35;
        endY = source.y - halfHeight;
        const pathData = `M ${startX} ${startY} C ${startX + loopSize} ${startY - loopSize}, ${endX + loopSize} ${endY + loopSize}, ${endX} ${endY}`;
        path.setAttribute('d', pathData);
      } else if (layout.orientation === 'horizontal') {
        startX = source.x + halfWidth;
        startY = source.y + sourceOffset;
        endX = target.x - halfWidth;
        endY = target.y + targetOffset;
      } else {
        startX = source.x + sourceOffset;
        startY = source.y + halfHeight;
        endX = target.x + targetOffset;
        endY = target.y - halfHeight;
      }
      if (edge.source !== edge.target) {
        const controlDistance =
          layout.orientation === 'horizontal' ? (endX - startX) * 0.38 : (endY - startY) * 0.38;
        const pathData =
          layout.orientation === 'horizontal'
            ? `M ${startX} ${startY} C ${startX + controlDistance} ${startY}, ${endX - controlDistance} ${endY}, ${endX} ${endY}`
            : `M ${startX} ${startY} C ${startX} ${startY + controlDistance}, ${endX} ${endY - controlDistance}, ${endX} ${endY}`;
        path.setAttribute('d', pathData);
      }

      const explicitlyHighlighted = highlightedEdges?.size
        ? highlightedEdges.has(edge.id)
        : false;
      const selectedNonFocus = !!selectedId && selectedId !== focusId;
      const relevant =
        explicitlyHighlighted ||
        (selectedNonFocus && (edge.source === selectedId || edge.target === selectedId));
      const token = EDGE_KIND_TOKENS[edge.kind] ?? '--tea-color-text-tertiary';
      const strokeColor = relevant
        ? activeColor
        : token === '--tea-color-text-secondary'
          ? neutralColor
          : color(token, '#777', element);
      path.setAttribute('stroke', strokeColor);
      path.setAttribute('stroke-width', `${relevant ? 2 : 1.2}`);
      path.setAttribute('opacity', relevant ? '1' : '0.72');
      path.setAttribute(
        'stroke-dasharray',
        edge.kind === 'implements' ? '6 4' : edge.kind === 'extends' ? '8 3' : '',
      );
    }
  }, [data.edges, highlightedEdges, selectedId]);

  const updateOverlayRef = useRef(updateOverlay);
  updateOverlayRef.current = updateOverlay;

  useEffect(() => {
    if (!container.current) return;
    let sigma: Sigma | undefined;
    let resize: ResizeObserver | undefined, theme: MutationObserver | undefined;
    let resolution: MediaQueryList | undefined;
    let pixelRatioChanged: (() => void) | undefined;
    try {
      const graph = new MultiDirectedGraph({ allowSelfLoops: true });
      sigma = new Sigma(graph, container.current, {
        renderLabels: !layoutRef.current,
        labelRenderedSizeThreshold: 0,
        labelDensity: 0.6,
        labelSize: 12,
        defaultDrawNodeHover: (context, node, settings) => {
          if (!container.current || !node.label) return;
          context.save();
          context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const left = node.x + node.size + 4;
          const width = context.measureText(node.label).width + 8;
          context.fillStyle = color('--tea-color-bg-primary-default', '#fff', container.current);
          context.fillRect(
            left - 4,
            node.y - settings.labelSize / 2 - 4,
            width,
            settings.labelSize + 8,
          );
          context.strokeStyle = color(
            '--tea-color-border-brand-default',
            '#006eff',
            container.current,
          );
          context.beginPath();
          context.arc(node.x, node.y, node.size + 3, 0, Math.PI * 2);
          context.stroke();
          context.fillStyle = color('--tea-color-text-primary', '#222', container.current);
          context.fillText(node.label, left, node.y + settings.labelSize / 3);
          context.restore();
        },
        stagePadding: 65,
        allowInvalidContainer: true,
        minCameraRatio: 0.08,
        maxCameraRatio: 8,
        autoRescale: false,
        autoCenter: false,
      });
      renderer.current = sigma;
      sigma.getCamera().on('updated', state => {
        if (!cameraRestored.current || !cameraKeyRef.current) return;
        rememberCamera(cameraKeyRef.current, state);
      });
      const canvas = sigma.createCanvas('code-relations', {
        beforeLayer: 'nodes',
        style: { pointerEvents: 'none' },
      });
      const render = () =>
        drawRelations(sigma!, canvas, dataRef.current, selectedRef.current, highlightedRef.current);
      // Sigma 3.0.3 skips backing-store resize when only DPR changes. Its next
      // render updates the GL viewport but leaves the old canvas size and 2D
      // transform, separating nodes from labels, relations and pointer picking.
      sigma.on('beforeRender', () => {
        const nodes = sigma!.getCanvases().nodes;
        const { width, height } = sigma!.getDimensions();
        const ratio = window.devicePixelRatio || 1;
        if (
          nodes.width !== Math.floor(width * ratio) ||
          nodes.height !== Math.floor(height * ratio)
        )
          sigma!.resize(true);
      });
      sigma.on('afterRender', () => {
        if (!layoutRef.current) render();
        updateOverlayRef.current();
      });
      const watchPixelRatio = () => {
        if (resolution && pixelRatioChanged)
          resolution.removeEventListener('change', pixelRatioChanged);
        resolution = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        resolution.addEventListener('change', pixelRatioChanged!);
      };
      pixelRatioChanged = () => {
        watchPixelRatio();
        sigma?.scheduleRefresh();
      };
      watchPixelRatio();
      sigma.on('clickNode', ({ node }) => {
        const match = dataRef.current.nodes.find((item) => item.id === node);
        if (match) selectRef.current(match);
      });
      const updateTheme = () => {
        if (!sigma) return;
        const nodeColor = layoutRef.current
          ? 'rgba(0, 0, 0, 0)'
          : color('--tea-color-bg-brand-default', '#006eff', sigma.getContainer());
        sigma
          .getGraph()
          .forEachNode((id) => sigma!.getGraph().setNodeAttribute(id, 'color', nodeColor));
        sigma.setSetting('labelColor', {
          color: color('--tea-color-text-primary', '#222', sigma.getContainer()),
        });
        sigma.refresh();
      };
      theme = new MutationObserver(updateTheme);
      theme.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'theme-mode', 'data-theme', 'data-tea-theme'],
      });
      theme.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'theme-mode', 'data-theme', 'data-tea-theme'],
      });
      resize = new ResizeObserver(() => {
        sigma?.resize();
        sigma?.refresh();
      });
      resize.observe(container.current);
      updateTheme();
      setReady(true);
    } catch {
      sigma?.kill();
      renderer.current = undefined;
      unavailableRef.current();
    }
    return () => {
      resize?.disconnect();
      theme?.disconnect();
      if (resolution && pixelRatioChanged)
        resolution.removeEventListener('change', pixelRatioChanged);
      sigma?.kill();
      renderer.current = undefined;
    };
  }, []);

  useEffect(() => {
    const sigma = renderer.current;
    if (!sigma || !ready) return;
    const graph = sigma.getGraph(),
      initial = graph.order === 0;
    if (focusedLayout) {
      positions.current = focusedLayout.positions;
      sigma.setSetting('renderLabels', false);
    } else {
      positions.current = stablePositions(data, layoutCache.current);
      positions.current.forEach((position, id) => layoutCache.current.set(id, position));
      // Bound remembered scope coordinates while retaining the current visible graph.
      if (layoutCache.current.size > 2000)
        for (const id of layoutCache.current.keys()) {
          if (!positions.current.has(id)) layoutCache.current.delete(id);
          if (layoutCache.current.size <= 2000) break;
        }
      sigma.setSetting('renderLabels', true);
    }
    const ids = new Set(data.nodes.map((node) => node.id));
    graph.nodes().forEach((id) => {
      if (!ids.has(id)) graph.dropNode(id);
    });
    for (const node of data.nodes) {
      const attributes = {
        ...positions.current.get(node.id),
        label: focusedLayout
          ? node.name
          : `${node.name.length > 40 ? `${node.name.slice(0, 37)}…` : node.name}${node.aggregate ? ` · ${t('code.graph.groupCounts', { files: node.aggregate.fileCount, symbols: node.aggregate.symbolCount })}${node.aggregate.boundary ? ' ↔' : ''}` : ''}`,
        size: focusedLayout ? 1 : node.id === selectedId ? 10 : 7,
        color: focusedLayout
          ? 'rgba(0, 0, 0, 0)'
          : color('--tea-color-bg-brand-default', '#006eff', sigma.getContainer()),
        highlighted: !focusedLayout && node.id === selectedId,
      };
      if (graph.hasNode(node.id)) graph.mergeNodeAttributes(node.id, attributes);
      else graph.addNode(node.id, attributes);
    }
    graph.clearEdges();
    // Edges live in Graphology with their full directed identity; the camera-aligned
    // 2D layer renders them because Sigma's built-in straight arrows overlap loops.
    for (const edge of data.edges)
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target))
        graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, { hidden: true });
    if (focusedLayout) {
      sigma.setCustomBBox({
        x: [0, Math.max(1, focusedLayout.canvasWidth)],
        y: [0, Math.max(1, focusedLayout.canvasHeight)],
      });
    } else if (initial) {
      const points = [...positions.current.values()];
      sigma.setCustomBBox({
        x: [Math.min(...points.map((p) => p.x), 0) - 2, Math.max(...points.map((p) => p.x), 0) + 2],
        y: [Math.min(...points.map((p) => p.y), 0) - 2, Math.max(...points.map((p) => p.y), 0) + 2],
      });
    }
    if (!cameraRestored.current && graph.order > 0) {
      const snapshot = effectiveCameraKey ? cameraCache.get(effectiveCameraKey) : undefined;
      if (snapshot) sigma.getCamera().setState(snapshot);
      cameraRestored.current = true;
    }
    sigma.refresh();
  }, [data, selectedId, highlightedEdges, effectiveCameraKey, focusedLayout, ready, t]);

  const fit = () => {
    const sigma = renderer.current;
    if (!sigma) return;
    if (focusedLayout) {
      sigma.setCustomBBox({
        x: [0, Math.max(1, focusedLayout.canvasWidth)],
        y: [0, Math.max(1, focusedLayout.canvasHeight)],
      });
    } else {
      const points = [...positions.current.values()];
      sigma.setCustomBBox({
        x: [Math.min(...points.map((p) => p.x), 0) - 2, Math.max(...points.map((p) => p.x), 0) + 2],
        y: [Math.min(...points.map((p) => p.y), 0) - 2, Math.max(...points.map((p) => p.y), 0) + 2],
      });
    }
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  };
  return (
    <div
      className={`_codegraph-canvas-wrap${
        focusedLayout?.orientation === 'vertical' ? ' is-vertical' : ''
      }`}
      data-testid="code-graph-canvas"
    >
      <div
        className="_codegraph-canvas-scroll"
        ref={scrollRef}
        role="region"
        aria-label={t('code.graph.relations')}
        tabIndex={focusedLayout ? 0 : undefined}
      >
      <div
        className="_codegraph-canvas"
        ref={container}
        aria-hidden="true"
        style={
          focusedLayout
            ? { width: focusedLayout.canvasWidth, height: focusedLayout.canvasHeight }
            : undefined
        }
      />
      {focusedLayout && (
        <div
          className="_codegraph-focus-overlay"
          style={
            {
              width: focusedLayout.canvasWidth,
              height: focusedLayout.canvasHeight,
            }
          }
        >
          <svg
            className="_codegraph-focus-edges"
            role="group"
            aria-label={t('code.graph.relations')}
          >
            <defs>
              <marker
                id="code-graph-focus-arrow"
                viewBox="0 0 6 6"
                refX="5"
                refY="3"
                markerWidth="5"
                markerHeight="5"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 6 3 L 0 6 z" fill="context-stroke" />
              </marker>
            </defs>
            {data.edges.map((edge) => (
              <path
                key={edge.id}
                ref={(element) => {
                  if (element) edgeRefs.current.set(edge.id, element);
                  else edgeRefs.current.delete(edge.id);
                }}
                className="_codegraph-focus-edge"
                fill="none"
                markerEnd="url(#code-graph-focus-arrow)"
                tabIndex={0}
                role="button"
                aria-label={edgeDescription(data, edge)}
                onClick={(event) => {
                  event.stopPropagation();
                  selectEdgeRef.current?.(edge);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  selectEdgeRef.current?.(edge);
                }}
              >
                <title>{edgeDescription(data, edge)}</title>
              </path>
            ))}
          </svg>
          <div className="_codegraph-focus-cards">
            {focusedLayout.cards.map(({ node, role }) => (
              <button
                key={node.id}
                type="button"
                ref={(element) => {
                  if (element) cardRefs.current.set(node.id, element);
                  else cardRefs.current.delete(node.id);
                }}
                className={[
                  '_codegraph-focus-card',
                  `_codegraph-focus-card-${role}`,
                  node.id === selectedId ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                style={{
                  width: focusedLayout.cardWidth,
                  height: focusedLayout.cardHeight,
                }}
                title={`${node.name} · ${node.kind} · ${nodeLocation(node)}`}
                aria-label={`${node.name} · ${node.kind} · ${nodeLocation(node)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  selectRef.current(node);
                }}
              >
                <span className="_codegraph-focus-card-name">{node.name}</span>
                <span className="_codegraph-focus-card-meta">
                  {t(`code.graph.focusRole.${role}`)} · {shortLocation(node)}
                </span>
              </button>
            ))}
          </div>
          <div className="_codegraph-focus-legend">
            <span>
              {t('code.graph.focusRole.caller')} → {t('code.graph.focusRole.callee')} ·{' '}
              {t('code.graph.focusRole.related')}
            </span>
            {[...new Set(data.edges.map((edge) => edge.kind))].map((kind) => (
              <span key={kind} className="_codegraph-focus-legend-kind">
                {kind}
              </span>
            ))}
          </div>
        </div>
      )}
      </div>
      <div className="_codegraph-camera" role="group" aria-label={t('code.graph.camera')}>
        <button
          type="button"
          onClick={() =>
            renderer.current
              ?.getCamera()
              .setState({ ratio: renderer.current.getCamera().ratio / 1.4 })
          }
          aria-label={t('code.graph.zoomIn')}
        >
          +
        </button>
        <button
          type="button"
          onClick={() =>
            renderer.current
              ?.getCamera()
              .setState({ ratio: renderer.current.getCamera().ratio * 1.4 })
          }
          aria-label={t('code.graph.zoomOut')}
        >
          −
        </button>
        <button type="button" onClick={fit}>
          {t('code.graph.fit')}
        </button>
      </div>
    </div>
  );
}
