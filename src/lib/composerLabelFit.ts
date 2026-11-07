import type { ComposerModelDraw } from "./compose.ts";

export function composerLabelDraw(draw: ComposerModelDraw, measured: { modelClipped: boolean; modelWidth: number; modelFloor: number }): ComposerModelDraw {
  if (draw !== "no-effort") return draw;
  // clientWidth is an integer; CSS min-width can be a fractional number of pixels.
  return measured.modelClipped && measured.modelWidth <= Math.ceil(measured.modelFloor) ? "out" : draw;
}
