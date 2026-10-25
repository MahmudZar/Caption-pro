/**
 * TikTok-style background: one rounded shape that hugs each line. Line boxes are stacked (each
 * one's bottom is the next one's top), so their union is a rectilinear polygon. Every corner
 * of that polygon is rounded with arcTo: outer corners curve out, inner corners (where a short
 * line meets a long one) get an inverted fillet, so the boxes flow into each other cleanly.
 * Each radius is capped at half of both neighbouring edges, so tiny width differences give
 * tiny steps instead of overlapping arcs.
 */
import type { Rect } from "./layout";

export interface Point {
  x: number;
  y: number;
}

/** Corner points of the union of vertically stacked rects, clockwise from the top-left corner. */
export function stackedOutline(rects: Rect[]): Point[] {
  if (!rects.length) return [];
  const right: Point[] = [];
  const left: Point[] = [];
  for (const r of rects) {
    right.push({ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h });
    left.push({ x: r.x, y: r.y }, { x: r.x, y: r.y + r.h });
  }
  const points = [{ x: rects[0].x, y: rects[0].y }, ...right, ...left.reverse()];
  return simplify(points);
}

/** Drops repeated points and points in the middle of a straight edge. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) < 1e-6 && Math.abs(out[0].y - out[out.length - 1].y) < 1e-6) out.pop();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i += 1) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const collinear = (Math.abs(a.x - b.x) < 1e-6 && Math.abs(b.x - c.x) < 1e-6) || (Math.abs(a.y - b.y) < 1e-6 && Math.abs(b.y - c.y) < 1e-6);
      if (collinear) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Radius actually used at each corner. */
export function cornerRadii(points: Point[], radius: number): number[] {
  const n = points.length;
  return points.map((p, i) => {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const a = Math.hypot(p.x - prev.x, p.y - prev.y);
    const b = Math.hypot(next.x - p.x, next.y - p.y);
    return Math.max(0, Math.min(radius, a / 2, b / 2));
  });
}

type PathTarget = Pick<CanvasRenderingContext2D, "moveTo" | "arcTo" | "lineTo" | "closePath">;

export function traceRoundedPolygon(ctx: PathTarget, points: Point[], radius: number): void {
  const n = points.length;
  if (n < 3) return;
  const radii = cornerRadii(points, radius);
  const last = points[n - 1];
  const first = points[0];
  ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    const next = points[(i + 1) % n];
    if (radii[i] > 0.01) ctx.arcTo(p.x, p.y, next.x, next.y, radii[i]);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}
