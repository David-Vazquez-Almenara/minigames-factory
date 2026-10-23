import { AfterViewInit, Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';

type PaintTool = 'brush' | 'eraser' | 'shape' | 'floodfill';
type PaintShape = 'circle' | 'square' | 'triangle';
type Point = { x: number; y: number };

/**
 * Lienzo con las herramientas de dibujo de la app (pincel, cubo, goma y formas). Lo comparten
 * "A Pintar" y "Pinturillo"; `changed` avisa de cada modificacion para quien necesite sincronizarla.
 */
@Component({
  selector: 'app-drawing-board',
  imports: [FormsModule],
  templateUrl: './drawing-board.component.html',
  styleUrl: './drawing-board.component.scss',
})
export class DrawingBoardComponent implements AfterViewInit {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('paintCanvas');
  private readonly previewCanvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private context?: CanvasRenderingContext2D;
  private previewContext?: CanvasRenderingContext2D;
  private drawing = false;
  private lastPoint: Point | null = null;
  private startPoint: Point | null = null;
  private canvasBackup: ImageData | null = null;

  /** Bloquea el lienzo y oculta las herramientas (dibujo entregado o fase terminada). */
  readonly disabled = input(false);
  readonly changed = output<void>();

  readonly tool = signal<PaintTool>('brush');
  readonly shape = signal<PaintShape>('circle');
  readonly color = signal('#111111');
  readonly brushSize = signal(10);
  readonly eraserSize = signal(44);

  readonly canvasCursorStyle = computed(() => {
    const tool = this.tool();
    const color = this.color();

    if (tool === 'brush') {
      const radius = Math.max(2, this.brushSize() / 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${radius}" fill="none" stroke="#000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${Math.max(1, radius - 0.5)}" fill="${color}" fill-opacity="0.4"/></svg>`;
      return this.toCursorUrl(svg, 64, 64, 'crosshair');
    }

    if (tool === 'eraser') {
      const radius = Math.max(3, this.eraserSize() / 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${radius}" fill="none" stroke="#000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${Math.max(1, radius - 0.5)}" fill="#ffffff" fill-opacity="0.6"/></svg>`;
      return this.toCursorUrl(svg, 64, 64, 'cell');
    }

    if (tool === 'floodfill') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 2-4 4 2.5 2.5L3 18v3h3l9.5-9.5L14 2z"/><path d="m8.5 11.5 4 4"/><path d="M17 18c0-1 1-2 1-2s1 1 1 2a1 1 0 0 1-2 0Z" fill="${color}" stroke="#000000"/></svg>`;
      return this.toCursorUrl(svg, 3, 20, 'pointer');
    }

    return 'default';
  });

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.context = canvas.getContext('2d', { willReadFrequently: true }) || undefined;
    this.previewContext = this.previewCanvasRef().nativeElement.getContext('2d') || undefined;
    this.fillWhite();
  }

  toDataUrl(type = 'image/png', quality?: number): string {
    return this.canvasRef().nativeElement.toDataURL(type, quality);
  }

  clearCanvas(): void {
    if (this.disabled()) {
      return;
    }

    this.fillWhite();
    this.clearPreviewCanvas();
    this.changed.emit();
  }

  setTool(tool: PaintTool): void {
    this.tool.set(tool);
  }

  setBrushSize(value: string | number): void {
    this.brushSize.set(Number(value));
  }

  setEraserSize(value: string | number): void {
    this.eraserSize.set(Number(value));
  }

  startDrawing(event: PointerEvent): void {
    if (this.disabled()) {
      return;
    }

    const point = this.getCanvasPoint(event);

    if (this.tool() === 'floodfill') {
      this.floodFill(point.x, point.y, this.color());
      this.changed.emit();
      return;
    }

    this.drawing = true;
    this.lastPoint = point;

    if (this.tool() === 'shape') {
      const canvas = this.canvasRef().nativeElement;
      this.startPoint = point;
      this.canvasBackup = this.context?.getImageData(0, 0, canvas.width, canvas.height) || null;
    } else {
      this.paint(event);
    }
  }

  stopDrawing(): void {
    const wasDrawing = this.drawing;
    this.drawing = false;
    this.lastPoint = null;
    this.startPoint = null;
    this.canvasBackup = null;
    this.clearPreviewCanvas();

    if (wasDrawing) {
      this.changed.emit();
    }
  }

  paint(event: PointerEvent): void {
    if (!this.context) {
      return;
    }

    const point = this.getCanvasPoint(event);
    this.drawPreviewCircle(point);

    if (!this.drawing || this.disabled() || this.tool() === 'floodfill') {
      return;
    }

    if (this.tool() === 'shape') {
      if (this.startPoint && this.canvasBackup) {
        this.context.putImageData(this.canvasBackup, 0, 0);
        this.context.fillStyle = this.color();
        this.drawShapeFromPoints(this.startPoint, point);
        this.changed.emit();
      }
      return;
    }

    const erasing = this.tool() === 'eraser';
    this.context.strokeStyle = erasing ? '#ffffff' : this.color();
    this.context.lineWidth = erasing ? this.eraserSize() : this.brushSize();
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';
    this.context.beginPath();
    this.context.moveTo((this.lastPoint || point).x, (this.lastPoint || point).y);
    this.context.lineTo(point.x, point.y);
    this.context.stroke();
    this.lastPoint = point;
    this.changed.emit();
  }

  private fillWhite(): void {
    const canvas = this.canvasRef().nativeElement;

    if (this.context) {
      this.context.fillStyle = '#ffffff';
      this.context.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  private drawShapeFromPoints(startPoint: Point, endPoint: Point): void {
    if (!this.context) {
      return;
    }

    const shapeType = this.shape();

    if (shapeType === 'square') {
      this.context.fillRect(startPoint.x, startPoint.y, endPoint.x - startPoint.x, endPoint.y - startPoint.y);
      return;
    }

    if (shapeType === 'triangle') {
      this.context.beginPath();
      this.context.moveTo((startPoint.x + endPoint.x) / 2, startPoint.y);
      this.context.lineTo(startPoint.x, endPoint.y);
      this.context.lineTo(endPoint.x, endPoint.y);
      this.context.closePath();
      this.context.fill();
      return;
    }

    const radius = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);
    this.context.beginPath();
    this.context.arc(startPoint.x, startPoint.y, radius, 0, Math.PI * 2);
    this.context.fill();
  }

  private floodFill(startX: number, startY: number, fillColorHex: string): void {
    const canvas = this.canvasRef().nativeElement;
    const fillRGB = this.hexToRgb(fillColorHex);

    if (!this.context || !fillRGB) {
      return;
    }

    const width = canvas.width;
    const height = canvas.height;
    const sX = Math.floor(startX);
    const sY = Math.floor(startY);

    if (sX < 0 || sX >= width || sY < 0 || sY >= height) {
      return;
    }

    const imageData = this.context.getImageData(0, 0, width, height);
    const data = imageData.data;
    const pixelPos = (sY * width + sX) * 4;
    const [targetR, targetG, targetB, targetA] = [data[pixelPos], data[pixelPos + 1], data[pixelPos + 2], data[pixelPos + 3]];

    if (targetR === fillRGB.r && targetG === fillRGB.g && targetB === fillRGB.b && targetA === 255) {
      return;
    }

    const queue = new Int32Array(width * height);
    const visited = new Uint8Array(width * height);
    let head = 0;
    let tail = 0;
    const startIdx = sY * width + sX;
    queue[tail++] = startIdx;
    visited[startIdx] = 1;
    const matchThreshold = 25;

    const enqueue = (index: number) => {
      if (!visited[index]) {
        visited[index] = 1;
        queue[tail++] = index;
      }
    };

    while (head < tail) {
      const currIdx = queue[head++];
      const currX = currIdx % width;
      const currY = Math.floor(currIdx / width);
      const pos = currIdx * 4;
      const colorDistance =
        Math.abs(data[pos] - targetR) +
        Math.abs(data[pos + 1] - targetG) +
        Math.abs(data[pos + 2] - targetB) +
        Math.abs(data[pos + 3] - targetA);

      if (colorDistance > matchThreshold) {
        continue;
      }

      data[pos] = fillRGB.r;
      data[pos + 1] = fillRGB.g;
      data[pos + 2] = fillRGB.b;
      data[pos + 3] = 255;

      if (currX > 0) enqueue(currIdx - 1);
      if (currX < width - 1) enqueue(currIdx + 1);
      if (currY > 0) enqueue(currIdx - width);
      if (currY < height - 1) enqueue(currIdx + width);
    }

    this.context.putImageData(imageData, 0, 0);
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) } : null;
  }

  private getCanvasPoint(event: PointerEvent): Point {
    const canvas = this.canvasRef().nativeElement;
    const rect = canvas.getBoundingClientRect();

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  private drawPreviewCircle(point: Point): void {
    const ctx = this.previewContext;
    const tool = this.tool();
    this.clearPreviewCanvas();

    if (!ctx || (tool !== 'brush' && tool !== 'eraser')) {
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, (tool === 'brush' ? this.brushSize() : this.eraserSize()) / 2, 0, Math.PI * 2);
    ctx.strokeStyle = tool === 'brush' ? this.color() : '#000';
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  private clearPreviewCanvas(): void {
    const previewCanvas = this.previewCanvasRef().nativeElement;
    this.previewContext?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  }

  private toCursorUrl(svg: string, x: number, y: number, fallback: string): string {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
  }
}
