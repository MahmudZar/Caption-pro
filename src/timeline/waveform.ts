/**
 * Waveform lookups at any zoom. The server sends 100 peaks per second once (cached on disk);
 * here they become a max-pyramid (each level halves the previous), so drawing one pixel column
 * reads at most a couple of values whatever the zoom: drawing cost depends on the lane width,
 * never on the clip length.
 */
export const PEAK_RATE = 100;

export class PeakPyramid {
  readonly levels: Float32Array[];

  constructor(peaks: Float32Array) {
    this.levels = [peaks];
    let current = peaks;
    while (current.length > 1) {
      const next = new Float32Array(Math.ceil(current.length / 2));
      for (let i = 0; i < next.length; i += 1) {
        const a = current[i * 2];
        const b = i * 2 + 1 < current.length ? current[i * 2 + 1] : 0;
        next[i] = a > b ? a : b;
      }
      this.levels.push(next);
      current = next;
    }
  }

  get duration(): number {
    return this.levels[0].length / PEAK_RATE;
  }

  /** Max peak in [from, to) seconds of the source. */
  maxBetween(from: number, to: number): number {
    if (to <= from) return 0;
    const span = (to - from) * PEAK_RATE;
    // Level where one value covers about half the span: 2-3 reads per column.
    const level = Math.max(0, Math.min(this.levels.length - 1, Math.floor(Math.log2(Math.max(1, span / 2)))));
    const data = this.levels[level];
    const size = 2 ** level;
    const start = Math.max(0, Math.floor((from * PEAK_RATE) / size));
    const end = Math.min(data.length, Math.ceil((to * PEAK_RATE) / size));
    let max = 0;
    for (let i = start; i < end; i += 1) if (data[i] > max) max = data[i];
    return max;
  }
}

const pyramids = new WeakMap<Float32Array, PeakPyramid>();

export function pyramidFor(peaks: Float32Array): PeakPyramid {
  let pyramid = pyramids.get(peaks);
  if (!pyramid) {
    pyramid = new PeakPyramid(peaks);
    pyramids.set(peaks, pyramid);
  }
  return pyramid;
}
