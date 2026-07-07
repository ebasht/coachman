import { useEffect, useState } from 'react';
import { api, type InviteGraph } from '../lib/api';
import { notify } from '../lib/notify';
import { Notice } from './Notice';

interface Props {
  onClose: () => void;
}

interface LayoutNode {
  id: string;
  username: string;
  isAdmin: boolean;
  x: number;
  y: number;
}

function layoutGraph(graph: InviteGraph): LayoutNode[] {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const edge of graph.edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
    hasParent.add(edge.to);
  }

  const roots = graph.nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  const rootId = roots[0] ?? graph.nodes[0]?.id;
  if (!rootId) return [];

  const levels: string[][] = [];
  const visited = new Set<string>();
  let frontier = [rootId];

  while (frontier.length) {
    levels.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      visited.add(id);
      for (const child of children.get(id) ?? []) {
        if (!visited.has(child)) next.push(child);
      }
    }
    frontier = next;
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const placed: LayoutNode[] = [];
  const levelHeight = 90;
  const nodeWidth = 120;

  levels.forEach((level, depth) => {
    const totalWidth = level.length * nodeWidth;
    level.forEach((id, index) => {
      const n = nodeMap.get(id);
      if (!n) return;
      placed.push({
        id: n.id,
        username: n.username,
        isAdmin: n.isAdmin,
        x: index * nodeWidth - totalWidth / 2 + nodeWidth / 2,
        y: depth * levelHeight,
      });
    });
  });

  return placed;
}

export function InviteGraphModal({ onClose }: Props) {
  const [graph, setGraph] = useState<InviteGraph | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getInviteGraph()
      .then(setGraph)
      .catch((e) => {
        const message = e instanceof Error ? e.message : 'Нет доступа';
        setError(message);
        notify.error(message);
      });
  }, []);

  const nodes = graph ? layoutGraph(graph) : [];
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const width = Math.max(400, ...nodes.map((n) => Math.abs(n.x) * 2 + 140));
  const height = Math.max(200, (Math.max(0, ...nodes.map((n) => n.y)) + 1) * 90 + 40);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal graph-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Граф приглашений</h2>
        <p className="modal-subtitle">Кто кого пригласил в круг</p>

        {error && <Notice variant="error">{error}</Notice>}

        {graph && (
          <div className="graph-scroll">
            <svg width={width} height={height} className="invite-graph">
              {graph.edges.map((e) => {
                const from = pos.get(e.from);
                const to = pos.get(e.to);
                if (!from || !to) return null;
                return (
                  <line
                    key={`${e.from}-${e.to}`}
                    x1={width / 2 + from.x}
                    y1={from.y + 30}
                    x2={width / 2 + to.x}
                    y2={to.y + 10}
                    className="graph-edge"
                  />
                );
              })}
              {nodes.map((n) => (
                <g key={n.id} transform={`translate(${width / 2 + n.x}, ${n.y})`}>
                  <rect x={-50} y={0} width={100} height={36} rx={8} className={n.isAdmin ? 'graph-node admin' : 'graph-node'} />
                  <text x={0} y={22} textAnchor="middle" className="graph-label">
                    @{n.username}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}
