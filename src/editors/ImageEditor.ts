export function computeResize(w: number, h: number, maxDim: number): { w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

export function computeRotatedSize(w: number, h: number, deg: 90|180|270): { w: number; h: number } {
  return deg === 180 ? { w, h } : { w: h, h: w };
}

export class ImageEditor {
  private ctx: CanvasRenderingContext2D;
  private filter = 'none';

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  load(bitmap: ImageBitmap) {
    this.canvas.width = bitmap.width;
    this.canvas.height = bitmap.height;
    this.ctx.drawImage(bitmap, 0, 0);
  }

  rotate(deg: 90|180|270) {
    const { width: w, height: h } = this.canvas;
    const size = computeRotatedSize(w, h, deg);
    const tmp = document.createElement('canvas');
    tmp.width = size.w;
    tmp.height = size.h;
    const tctx = tmp.getContext('2d')!;
    tctx.translate(size.w / 2, size.h / 2);
    tctx.rotate((deg * Math.PI) / 180);
    tctx.drawImage(this.canvas, -w / 2, -h / 2);
    this.canvas.width = size.w;
    this.canvas.height = size.h;
    this.ctx.drawImage(tmp, 0, 0);
  }

  resize(maxDim: number) {
    const { width: w, height: h } = this.canvas;
    const s = computeResize(w, h, maxDim);
    const tmp = document.createElement('canvas');
    tmp.width = s.w;
    tmp.height = s.h;
    tmp.getContext('2d')!.drawImage(this.canvas, 0, 0, s.w, s.h);
    this.canvas.width = s.w;
    this.canvas.height = s.h;
    this.ctx.drawImage(tmp, 0, 0);
  }

  applyFilter(css: string) {
    this.filter = css;
    this.ctx.filter = css;
  }

  toBlob(type: string, quality?: number): Promise<Blob> {
    return new Promise((res, rej) =>
      this.canvas.toBlob(
        (b) => (b ? res(b) : rej(new Error('toBlob failed'))),
        type,
        quality
      )
    );
  }
}
