'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GRID_W, GRID_H, RS, VIEW_W, VIEW_H } from '@/sim/constants.ts';

type Props = {
  worker: React.RefObject<Worker | null>;
  onInspect: (cell: number) => void;
  onReturnBuffer: (buf: ArrayBuffer) => void;
};

/**
 * Zoom levels, in *screen pixels per world cell*.
 *
 * The frame buffer carries RS sub-pixels per cell, so a step of 2 is a 1:1
 * blit — the level at which everything the renderer drew is actually on the
 * screen. A step of 1 halves the buffer and is the "see the whole world"
 * end of the scale, which is why `fit` is its own button rather than a step.
 */
const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16];

/** First zoom step larger than `s`, so wheeling in from fit mode actually
 *  magnifies instead of dropping to 1x. */
function nextZoomAbove(s: number): number {
  for (let i = 0; i < ZOOMS.length; i++) if (ZOOMS[i] > s) return i;
  return ZOOMS.length - 1;
}

/** The opening view: legible cells, not a postage stamp. Fitting the whole
 *  world into the stage gave every cell about two pixels, which is what made
 *  the map read as a grid of identical squares. Opening ~2.2x larger than
 *  fit costs some of the edges and buys back the detail. */
function openingZoom(stageW: number, stageH: number): number {
  const fit = Math.min(stageW / GRID_W, stageH / GRID_H);
  const want = Math.floor(fit * 2.2);
  for (let i = 0; i < ZOOMS.length; i++) if (ZOOMS[i] >= want) return i;
  return ZOOMS.length - 1;
}

export function WorkerCanvas({ worker, onInspect, onReturnBuffer }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const offReady = useRef(false);
  const idxRef = useRef<Int32Array | null>(null);
  const agesRef = useRef<Uint16Array | null>(null);
  const aliveRef = useRef<Uint16Array | Uint8Array | null>(null);
  const sexRef = useRef<Uint8Array | null>(null);

  const [zoom, setZoom] = useState(4);
  const [view, setView] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  /** Where the pointer was last, so the zoom buttons can magnify toward it
   *  rather than always about the middle of the stage. */
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  // mirrors of the state, so the wheel/observer handlers never close over a
  // stale value and never need to re-subscribe
  const fitRef = useRef(false);
  const zoomRef = useRef(4);
  const viewRef = useRef({ x: 0, y: 0 });
  fitRef.current = fit;
  zoomRef.current = zoom;
  viewRef.current = view;

  // offscreen buffer at render resolution (RS sub-pixels per world cell)
  useEffect(() => {
    const c = document.createElement('canvas');
    c.width = VIEW_W; c.height = VIEW_H;
    offRef.current = c;
  }, []);

  const draw = useCallback(() => {
    const cv = canvasRef.current, off = offRef.current;
    if (!cv || !off) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    // NOTE: the ImageData wraps a buffer the worker owns, and it is detached
    // the moment we hand the buffer back. Blit from the offscreen canvas,
    // which holds its own copy, and never re-read that ImageData.
    if (!offReady.current) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(off, 0, 0, VIEW_W, VIEW_H, 0, 0, cv.width, cv.height);
    drawAnnotations(ctx);
  }, []);

  const scaleRef = useRef(1);
  /** Buffer pixels per buffer pixel: the blit factor for the current zoom. */
  const scaleOf = useCallback(() => scaleRef.current, []);

  /** Resize the visible canvas to a world scale and repaint. This is the only
   *  place the scale is ever set — zoom went dead for a long time because the
   *  buttons moved a state value that nothing read. */
  const applyScale = useCallback((s: number) => {
    const cv = canvasRef.current;
    if (!cv) return;
    scaleRef.current = s;
    cv.width = Math.max(1, Math.round(VIEW_W * s));
    cv.height = Math.max(1, Math.round(VIEW_H * s));
    cv.style.width = `${cv.width}px`;
    cv.style.height = `${cv.height}px`;
    draw();
  }, [draw]);

  /** Switch to an explicit zoom step and actually apply it. */
  const setZoomLevel = useCallback((i: number, anchor?: { x: number; y: number }) => {
    const idx = Math.max(0, Math.min(ZOOMS.length - 1, i));
    const z0 = ZOOMS[zoomRef.current], z1 = ZOOMS[idx];
    const st = stageRef.current;
    if (st && z0 !== z1) {
      const r = st.getBoundingClientRect();
      const px = (anchor ? anchor.x : r.left + r.width / 2) - r.left;
      const py = (anchor ? anchor.y : r.top + r.height / 2) - r.top;
      // the world cell currently sitting under that point...
      const wx = (px - viewRef.current.x) / z0;
      const wy = (py - viewRef.current.y) / z0;
      // ...and the offset that puts it back under the same pixel
      setView({ x: px - wx * z1, y: py - wy * z1 });
    }
    setFit(false);
    setZoom(idx);
    applyScale(z1 / RS);
  }, [applyScale]);

  const goFit = useCallback(() => {
    setFit(true);
    const st = stageRef.current;
    if (!st) { setView({ x: 0, y: 0 }); applyScale(1 / RS); return; }
    const pad = 16;
    const z = Math.max(0.5, Math.min((st.clientWidth - pad) / GRID_W, (st.clientHeight - pad) / GRID_H));
    setView({ x: 0, y: 0 });
    applyScale(z / RS);
  }, [applyScale]);

  /** Age numerals and sex squares, drawn only when cells are big enough. */
  const drawAnnotations = (ctx: CanvasRenderingContext2D) => {
    const ages = agesRef.current, alive = aliveRef.current, idx = idxRef.current;
    const sex = sexRef.current;
    if (!ages || !alive || !idx || !sex) return;
    const s = scaleOf();
    const size = RS * s;                       // screen px per world cell
    if (size < 5) return;

    const showAge = size >= 9;
    if (showAge) {
      ctx.font = `${Math.floor(size * 0.52)}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
    }

    for (let cell = 0; cell < idx.length; cell++) {
      const slot = idx[cell];
      if (slot < 0 || !alive[slot]) continue;
      const cx = cell % GRID_W, cy = (cell / GRID_W) | 0;
      const px = cx * size, py = cy * size;

      if (showAge) {
        const a = ages[slot];
        const label = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a);
        // dark halo so numerals stay legible on any emotion colour
        ctx.lineWidth = Math.max(1, size * 0.09);
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(label, px + size / 2, py + size / 2);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, px + size / 2, py + size / 2);
      }

      if (size >= 6) {
        // sex square in the top-left corner, as specified
        const m = Math.max(2, Math.floor(size * 0.34));
        ctx.fillStyle = sex[slot] === 0 ? '#3b9dff' : '#ff6fa5';
        ctx.fillRect(px + 1, py + 1, m, m);
      }
    }
  };

  // receive frames
  useEffect(() => {
    const w = worker.current;
    if (!w) return;
    const onMsg = (e: MessageEvent) => {
      const m = e.data;
      if (m.type !== 'frame') return;
      const ab: ArrayBuffer = m.buffer;
      // putImageData copies into the offscreen canvas's own storage, so the
      // buffer can be handed straight back to the worker afterwards
      const img = new ImageData(new Uint8ClampedArray(ab), VIEW_W, VIEW_H);
      offRef.current!.getContext('2d')!.putImageData(img, 0, 0);
      offReady.current = true;
      idxRef.current = m.agentIndex;
      agesRef.current = m.ages;
      aliveRef.current = m.alive;
      sexRef.current = m.sex;
      draw();
      onReturnBuffer(ab);
    };
    w.addEventListener('message', onMsg);
    return () => w.removeEventListener('message', onMsg);
  }, [worker, draw, onReturnBuffer]);

  // size the canvas to the stage and pick the opening view
  useEffect(() => {
    const fitAll = () => {
      const st = stageRef.current, cv = canvasRef.current;
      if (!st || !cv) return;
      if (fitRef.current) { goFit(); return; }
      // re-derive the opening zoom whenever the stage is remeasured
      const idx = openingZoom(st.clientWidth, st.clientHeight);
      const z = ZOOMS[idx];
      setZoom(idx);
      applyScale(z / RS);
      // centre the map in whatever space the stage has
      const r = st.getBoundingClientRect();
      setView({
        x: Math.round((r.width - GRID_W * z) / 2),
        y: Math.round((r.height - GRID_H * z) / 2),
      });
    };
    fitAll();
    const stage = stageRef.current;
    // only re-fit while we are actually in fit mode: resizing the window
    // should not yank someone out of the 8x they are inspecting
    const ro = new ResizeObserver(() => { if (fitRef.current) goFit(); });
    if (stage) ro.observe(stage);
    const onWinResize = () => { if (fitRef.current) goFit(); };
    window.addEventListener('resize', onWinResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onWinResize); };
  }, [applyScale, goFit]);

  // wheel to zoom. Bound to the stage, not the canvas: in fit mode the canvas
  // is smaller than the stage, so wheeling over the empty margin did nothing.
  useEffect(() => {
    const st = stageRef.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // stepping in from fit mode lands on the first zoom above what fits
      const from = fitRef.current ? nextZoomAbove(scaleOf() * RS) : zoomRef.current;
      const dir = e.deltaY < 0 ? 1 : -1;
      setZoomLevel(from + dir, { x: e.clientX, y: e.clientY });
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    return () => st.removeEventListener('wheel', onWheel);
  }, [setZoomLevel, scaleOf]);

  // drag to pan when zoomed
  const onDown = (e: React.PointerEvent) => {
    if (fit) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView({ x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) });
  };
  const onUp = () => { drag.current = null; };

  // click -> grid cell
  const onClick = (e: React.MouseEvent) => {
    const cv = canvasRef.current;
    if (!cv) return;
    const r = cv.getBoundingClientRect();
    const cell = RS * scaleOf();
    const gx = Math.floor((e.clientX - r.left) / cell);
    const gy = Math.floor((e.clientY - r.top) / cell);
    if (gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) return;
    onInspect(gy * GRID_W + gx);
  };

  return (
    <div
      ref={stageRef}
      style={{ position: 'absolute', inset: 0 }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      <canvas
        ref={canvasRef}
        onClick={onClick}
        style={{
          transform: `translate(${view.x}px, ${view.y}px)`,
          cursor: fit ? 'pointer' : drag.current ? 'grabbing' : 'grab',
        }}
      />
      {/* always visible: while these were gated behind !fit there was no
          on-screen way to zoom at all until you found the wheel gesture */}
      <div
        className="zoombar"
        onPointerMove={(e) => { lastPointer.current = { x: e.clientX, y: e.clientY }; }}
      >
        <button onClick={goFit} data-active={fit} title="Show the whole world at once">fit</button>
        {ZOOMS.map((z, i) => (
          <button
            key={z}
            data-active={!fit && zoom === i}
            onClick={() => setZoomLevel(i, lastPointer.current ?? undefined)}
            title={`${z} screen pixel${z === 1 ? '' : 's'} per world cell`}
          >
            {z}&times;
          </button>
        ))}
      </div>
    </div>
  );
}
