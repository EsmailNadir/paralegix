"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import { Lock, Pencil, Trash2, Plus, GitBranch, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import Tooltip from "@/components/ui/Tooltip";
import ListEmptyState from "@/components/ui/ListEmptyState";
import { buildForest, layoutForest } from "@/lib/matterStages/stageTree";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.2;
// Empty margin around the tree so there is always room to pan in every direction,
// even when the content is smaller than the viewport.
const CANVAS_PAD = 400;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * 100) / 100));

export interface EditorNode {
  id: string;
  name: string;
  color?: string | null;
  isClosed?: boolean;
  parentId: string | null;
  sortOrder?: number;
}

interface Props {
  nodes: EditorNode[];
  readOnly?: boolean;
  height?: number;
  onAddRoot?: () => void;
  onAddChild?: (parentId: string) => void; // "+ step after"
  onAddSibling?: (nodeId: string) => void; // "+ branch" (adds another child to this node's parent)
  onEdit?: (nodeId: string) => void;
  onToggleClosed?: (nodeId: string) => void;
  onDelete?: (nodeId: string) => void;
}

const COL_W = 176; // px per column slot
const ROW_H = 104; // px per depth level
const CARD_W = 148;
const CARD_H = 56;

export default function StagePipelineEditor({
  nodes,
  readOnly = false,
  height = 460,
  onAddRoot,
  onAddChild,
  onAddSibling,
  onEdit,
  onToggleClosed,
  onDelete,
}: Props) {
  const layout = useMemo(() => {
    const roots = buildForest(
      nodes.map((n) => ({ id: n.id, parentId: n.parentId, sortOrder: n.sortOrder })),
    );
    const laid = layoutForest(roots);
    const pos = new Map(laid.map((l) => [l.id, l]));
    const maxCol = laid.reduce((m, l) => Math.max(m, l.col), 0);
    const maxDepth = laid.reduce((m, l) => Math.max(m, l.depth), 0);
    return { pos, width: (maxCol + 1) * COL_W, height: (maxDepth + 1) * ROW_H };
  }, [nodes]);

  const xOf = (col: number) => col * COL_W + (COL_W - CARD_W) / 2 + CARD_W / 2;
  const yOf = (depth: number) => depth * ROW_H + 8;

  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const didInitScroll = useRef(false);

  // Start the viewport on the content, not on the surrounding empty pad.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || didInitScroll.current || nodes.length === 0) return;
    el.scrollLeft = CANVAS_PAD - 24;
    el.scrollTop = CANVAS_PAD - 24;
    didInitScroll.current = true;
  }, [nodes.length]);

  // Drag the empty canvas to pan (grab-and-move). Dragging that starts on a node
  // card or its buttons is ignored so those stay clickable.
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-stage-node]")) return;
    const el = scrollRef.current;
    if (!el) return;
    panStart.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true);
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    const start = panStart.current;
    if (!el || !start) return;
    el.scrollLeft = start.left - (e.clientX - start.x);
    el.scrollTop = start.top - (e.clientY - start.y);
  };
  const endPan = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (el && panStart.current) {
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    }
    panStart.current = null;
    setPanning(false);
  };

  // Ctrl/Cmd + wheel zooms the canvas (a non-passive listener so we can preventDefault
  // the browser's page zoom). Plain scroll still pans.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z - Math.sign(e.deltaY) * ZOOM_STEP));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (nodes.length === 0) {
    return (
      <ListEmptyState
        compact
        title="No stages yet"
        action={
          !readOnly && onAddRoot && (
            <button
              type="button"
              onClick={onAddRoot}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-accent-solid text-accent-foreground hover:bg-accent-solid-hover transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              <Plus size={13} strokeWidth={2.4} /> Add first stage
            </button>
          )
        }
      />
    );
  }

  return (
    <div className="relative rounded-xl border border-outline bg-surface-alt">
      {/* Zoom controls. */}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-0.5 rounded-lg border border-outline bg-surface/90 px-1 py-0.5 shadow-sm backdrop-blur">
        <Tooltip title="Zoom out" enterDelay={300}>
          <span>
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
              disabled={zoom <= MIN_ZOOM}
              className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              aria-label="Zoom out"
            >
              <ZoomOut size={14} />
            </button>
          </span>
        </Tooltip>
        <span className="w-9 text-center text-[11px] font-medium tabular-nums text-on-surface-secondary">
          {Math.round(zoom * 100)}%
        </span>
        <Tooltip title="Zoom in" enterDelay={300}>
          <span>
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
              disabled={zoom >= MAX_ZOOM}
              className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              aria-label="Zoom in"
            >
              <ZoomIn size={14} />
            </button>
          </span>
        </Tooltip>
        <Tooltip title="Reset zoom" enterDelay={300}>
          <span>
            <button
              type="button"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
              aria-label="Reset zoom"
            >
              <Maximize2 size={14} />
            </button>
          </span>
        </Tooltip>
      </div>

      <div
        ref={scrollRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        className={`overflow-auto styled-scrollbar p-4 ${panning ? "cursor-grabbing select-none" : "cursor-grab"}`}
        style={{ height }}
      >
        <div
          style={{
            position: "relative",
            width: layout.width * zoom + CANVAS_PAD * 2,
            height: (layout.height + 8) * zoom + CANVAS_PAD * 2,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: CANVAS_PAD,
              top: CANVAS_PAD,
              width: layout.width,
              height: layout.height + 8,
              transform: `scale(${zoom})`,
              transformOrigin: "top left",
            }}
          >
            {/* Connectors behind the cards. */}
            <svg
          className="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height + 8}
        >
          {nodes.map((n) => {
            if (!n.parentId) return null;
            const child = layout.pos.get(n.id);
            const parent = layout.pos.get(n.parentId);
            if (!child || !parent) return null;
            const x1 = xOf(parent.col);
            const y1 = yOf(parent.depth) + CARD_H;
            const x2 = xOf(child.col);
            const y2 = yOf(child.depth);
            const midY = (y1 + y2) / 2;
            return (
              <path
                key={n.id}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--outline)"
                strokeWidth={2}
              />
            );
          })}
        </svg>

        {/* Node cards. */}
        {nodes.map((n) => {
          const p = layout.pos.get(n.id);
          if (!p) return null;
          const hasChildren = nodes.some((c) => c.parentId === n.id);
          const left = xOf(p.col) - CARD_W / 2;
          const top = yOf(p.depth);
          return (
            <div
              key={n.id}
              data-stage-node
              className="absolute rounded-lg border border-outline bg-surface shadow-sm dark:shadow-none"
              style={{ left, top, width: CARD_W, height: CARD_H }}
            >
              <div className="flex h-full flex-col justify-between px-2.5 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-black/5"
                    style={{ backgroundColor: n.color || "var(--outline)" }}
                  />
                  <span className="truncate text-xs font-medium text-on-surface">{n.name}</span>
                  {n.isClosed && (
                    <Lock size={11} className="shrink-0 text-accent-emphasis" />
                  )}
                </div>
                {!readOnly && (
                  <div className="flex items-center gap-0.5">
                    <Tooltip title="Edit" enterDelay={300}>
                      <button aria-label="Edit"
                        type="button"
                        onClick={() => onEdit?.(n.id)}
                        className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                      >
                        <Pencil size={12} />
                      </button>
                    </Tooltip>
                    {!hasChildren && (
                      <Tooltip title={n.isClosed ? "Unmark ending" : "Mark as ending"} enterDelay={300}>
                        <button
                          type="button"
                          aria-label={n.isClosed ? "Unmark ending" : "Mark as ending"}
                          onClick={() => onToggleClosed?.(n.id)}
                          className={`rounded p-1 hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 ${
                            n.isClosed
                              ? "text-accent-emphasis"
                              : "text-on-surface-muted hover:text-on-surface"
                          }`}
                        >
                          <Lock size={12} />
                        </button>
                      </Tooltip>
                    )}
                    {!n.isClosed && (
                      <Tooltip title="Add step after" enterDelay={300}>
                        <button aria-label="Add step after"
                          type="button"
                          onClick={() => onAddChild?.(n.id)}
                          className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          <Plus size={12} />
                        </button>
                      </Tooltip>
                    )}
                    {n.parentId && (
                      <Tooltip title="Add parallel outcome (branch)" enterDelay={300}>
                        <button aria-label="Add parallel outcome (branch)"
                          type="button"
                          onClick={() => onAddSibling?.(n.id)}
                          className="rounded p-1 text-on-surface-muted hover:text-on-surface hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                          <GitBranch size={12} />
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip title="Delete" enterDelay={300}>
                      <button aria-label="Delete"
                        type="button"
                        onClick={() => onDelete?.(n.id)}
                        className="rounded p-1 text-on-surface-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-surface-hover cursor-pointer transition-[background-color,border-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            </div>
          );
        })}
          </div>
        </div>
      </div>
    </div>
  );
}
