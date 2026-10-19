import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Sigma from 'sigma';
import { MultiDirectedGraph } from 'graphology';
import type {
  CodeGraphEdge,
  CodeGraphNode,
  CodeGraphResponse,
} from '@/lib/api/code-graph-contract';
import { stablePositions, type Position } from './graph-model';

type Data = Pick<CodeGraphResponse, 'nodes' | 'edges'>;
interface Props {
  data: Data;
  selectedId?: string;
  highlightedEdges?: Set<string>;
  onSelect: (node: CodeGraphNode) => void;
  onUnavailable: () => void;
}

function color(token: string, fallback: string, element: Element = document.body) {
  return getComputedStyle(element).getPropertyValue(token).trim() || fallback;
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
  selectedId,
  highlightedEdges,
  onSelect,
  onUnavailable,
}: Props) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null),
    renderer = useRef<Sigma>();
  const layoutCache = useRef(new Map<string, Position>());
  const positions = useRef(new Map<string, Position>()),
    dataRef = useRef(data),
    selectedRef = useRef(selectedId),
    highlightedRef = useRef(highlightedEdges);
  const selectRef = useRef(onSelect),
    unavailableRef = useRef(onUnavailable);
  dataRef.current = data;
  selectedRef.current = selectedId;
  highlightedRef.current = highlightedEdges;
  selectRef.current = onSelect;
  unavailableRef.current = onUnavailable;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    let sigma: Sigma | undefined;
    let resize: ResizeObserver | undefined, theme: MutationObserver | undefined;
    try {
      const graph = new MultiDirectedGraph({ allowSelfLoops: true });
      sigma = new Sigma(graph, container.current, {
        renderLabels: true,
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
      const canvas = sigma.createCanvas('code-relations', {
        beforeLayer: 'nodes',
        style: { pointerEvents: 'none' },
      });
      const render = () =>
        drawRelations(sigma!, canvas, dataRef.current, selectedRef.current, highlightedRef.current);
      sigma.on('afterRender', render);
      sigma.on('clickNode', ({ node }) => {
        const match = dataRef.current.nodes.find((item) => item.id === node);
        if (match) selectRef.current(match);
      });
      const updateTheme = () => {
        if (!sigma) return;
        const nodeColor = color('--tea-color-bg-brand-default', '#006eff', sigma.getContainer());
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
      sigma?.kill();
      renderer.current = undefined;
    };
  }, []);

  useEffect(() => {
    const sigma = renderer.current;
    if (!sigma || !ready) return;
    const graph = sigma.getGraph(),
      initial = graph.order === 0;
    positions.current = stablePositions(data, layoutCache.current);
    positions.current.forEach((position, id) => layoutCache.current.set(id, position));
    // Bound remembered scope coordinates while retaining the current visible graph.
    if (layoutCache.current.size > 2000)
      for (const id of layoutCache.current.keys()) {
        if (!positions.current.has(id)) layoutCache.current.delete(id);
        if (layoutCache.current.size <= 2000) break;
      }
    const ids = new Set(data.nodes.map((node) => node.id));
    graph.nodes().forEach((id) => {
      if (!ids.has(id)) graph.dropNode(id);
    });
    for (const node of data.nodes) {
      const attributes = {
        ...positions.current.get(node.id),
        label: `${node.name.length > 40 ? `${node.name.slice(0, 37)}…` : node.name}${node.aggregate ? ` · ${t('code.graph.groupCounts', { files: node.aggregate.fileCount, symbols: node.aggregate.symbolCount })}${node.aggregate.boundary ? ' ↔' : ''}` : ''}`,
        size: node.id === selectedId ? 10 : 7,
        color: color('--tea-color-bg-brand-default', '#006eff', sigma.getContainer()),
        highlighted: node.id === selectedId,
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
    if (initial) {
      const points = [...positions.current.values()];
      sigma.setCustomBBox({
        x: [Math.min(...points.map((p) => p.x), 0) - 2, Math.max(...points.map((p) => p.x), 0) + 2],
        y: [Math.min(...points.map((p) => p.y), 0) - 2, Math.max(...points.map((p) => p.y), 0) + 2],
      });
    }
    sigma.refresh();
  }, [data, selectedId, highlightedEdges, ready, t]);

  const fit = () => {
    const sigma = renderer.current;
    if (!sigma) return;
    const points = [...positions.current.values()];
    sigma.setCustomBBox({
      x: [Math.min(...points.map((p) => p.x), 0) - 2, Math.max(...points.map((p) => p.x), 0) + 2],
      y: [Math.min(...points.map((p) => p.y), 0) - 2, Math.max(...points.map((p) => p.y), 0) + 2],
    });
    sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
  };
  return (
    <div className="_codegraph-canvas-wrap" data-testid="code-graph-canvas">
      <div className="_codegraph-canvas" ref={container} aria-hidden="true" />
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
