import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PaintTargetPayload } from '../../../../core/services/socket.service';
import { MinigameService } from '../shared/minigame.service';

type PaintTool = 'brush' | 'eraser' | 'shape' | 'floodfill';
type PaintShape = 'circle' | 'square' | 'triangle';

@Component({
  selector: 'app-paint',
  imports: [FormsModule],
  templateUrl: './paint.component.html',
  styleUrl: './paint.component.scss',
})
export class PaintComponent implements AfterViewInit, OnDestroy {
  private readonly minigameService = inject(MinigameService);
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('paintCanvas');
  private readonly previewCanvasRef = viewChild<ElementRef<HTMLCanvasElement>>('previewCanvas');
  private context?: CanvasRenderingContext2D;
  private previewContext?: CanvasRenderingContext2D;
  private initializedCanvas?: HTMLCanvasElement;
  private drawing = false;
  private lastPoint: { x: number; y: number } | null = null;
  private startPoint: { x: number; y: number } | null = null;
  private canvasBackup: ImageData | null = null;
  private submittedRoundKey = '';
  private timer?: ReturnType<typeof setInterval>;

  readonly match = this.minigameService.match;
  readonly currentPlayerId = this.minigameService.currentPlayerId;
  readonly gameInfo = computed(() => this.minigameService.receiveGameData());
  readonly specialRound = computed(() => this.match()?.specialRound || null);
  readonly target = computed(() => (this.gameInfo()?.payload as PaintTargetPayload | null | undefined) || null);
  readonly submissions = computed(() => this.specialRound()?.paintSubmissions || []);
  readonly phase = computed(() => this.specialRound()?.paintPhase || 'preparing');
  readonly remainingSeconds = signal(60);
  readonly tool = signal<PaintTool>('brush');
  readonly shape = signal<PaintShape>('circle');
  readonly color = signal('#111111');
  readonly brushSize = signal(10);
  readonly eraserSize = signal(44);
  readonly submitted = signal(false);
  readonly votedTargetId = signal('');
  readonly loading = signal(false);
  readonly errorMessage = signal('');
  readonly mousePos = signal<{ x: number; y: number } | null>(null);

  readonly canvasCursorStyle = computed(() => {
    const t = this.tool();
    const c = this.color();
    const bSize = this.brushSize();
    const eSize = this.eraserSize();

    if (t === 'brush') {
      const radius = Math.max(2, bSize / 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${radius}" fill="none" stroke="#000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${Math.max(1, radius - 0.5)}" fill="${c}" fill-opacity="0.4"/></svg>`;
      return this.toCursorUrl(svg, 64, 64, 'crosshair');
    }

    if (t === 'eraser') {
      const radius = Math.max(3, eSize / 2);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><circle cx="64" cy="64" r="${radius}" fill="none" stroke="#000000" stroke-width="1.5"/><circle cx="64" cy="64" r="${Math.max(1, radius - 0.5)}" fill="#ffffff" fill-opacity="0.6"/></svg>`;
      return this.toCursorUrl(svg, 64, 64, 'cell');
    }

    if (t === 'floodfill') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m14 2-4 4 2.5 2.5L3 18v3h3l9.5-9.5L14 2z"/><path d="m8.5 11.5 4 4"/><path d="M17 18c0-1 1-2 1-2s1 1 1 2a1 1 0 0 1-2 0Z" fill="${c}" stroke="#000000"/></svg>`;
      return this.toCursorUrl(svg, 3, 20, 'pointer');
    }

    return 'default';
  });

  readonly submittedCount = computed(() => this.submissions().length);
  readonly totalPlayers = computed(() => this.match()?.totalPlayers || 0);
  readonly votableSubmissions = computed(() =>
    this.submissions().filter((submission) => submission.playerId !== this.currentPlayerId),
  );
  readonly canSubmit = computed(() => this.phase() === 'drawing' && !this.submitted() && !this.loading());

  constructor() {
    effect(() => {
      const phase = this.phase();
      const deadline = phase === 'drawing' ? this.specialRound()?.paintEndsAt : this.specialRound()?.paintVoteEndsAt;

      this.syncTimer(deadline || null);
    });

    effect(() => {
      const canvasEl = this.canvasRef();
      if (canvasEl) {
        this.setupCanvas();
      }
    });

    effect(() => {
      const previewCanvasEl = this.previewCanvasRef();
      if (previewCanvasEl) {
        this.setupPreviewCanvas();
      }
    });
  }

  ngAfterViewInit(): void {
    this.setupCanvas();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  clearCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (canvas && this.context && !this.submitted()) {
      this.context.clearRect(0, 0, canvas.width, canvas.height);
      this.context.fillStyle = '#ffffff';
      this.context.fillRect(0, 0, canvas.width, canvas.height);
      this.clearPreviewCanvas();
    }
  }

  openImageSearch(): void {
    const label = this.target()?.label;

    if (!label) {
      return;
    }

    window.open(`https://www.google.com/search?tbm=isch&q=${encodeURIComponent(label)}`, '_blank', 'noopener');
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

  hasVoted(): boolean {
    return Boolean(this.votedTargetId());
  }

  startDrawing(event: PointerEvent): void {
    if (this.phase() !== 'drawing' || this.submitted()) {
      return;
    }

    const point = this.getCanvasPoint(event);

    if (this.tool() === 'floodfill') {
      this.floodFill(point.x, point.y, this.color());
      return;
    }

    this.drawing = true;
    this.lastPoint = point;

    if (this.tool() === 'shape') {
      this.startPoint = point;
      const canvas = this.canvasRef()?.nativeElement;
      if (canvas && this.context) {
        this.canvasBackup = this.context.getImageData(0, 0, canvas.width, canvas.height);
      }
    } else {
      this.paint(event);
    }
  }

  stopDrawing(): void {
    this.drawing = false;
    this.lastPoint = null;
    this.startPoint = null;
    this.canvasBackup = null;
    this.clearPreviewCanvas();
  }

  paint(event: PointerEvent): void {
    if (!this.context) {
      return;
    }

    const point = this.getCanvasPoint(event);
    this.mousePos.set(point);
    this.drawPreviewCircle(point);

    if (!this.drawing || this.phase() !== 'drawing') {
      return;
    }

    if (this.tool() === 'eraser') {
      this.context.strokeStyle = '#ffffff';
      this.context.lineWidth = this.eraserSize();
      this.context.lineCap = 'round';
      this.context.lineJoin = 'round';

      this.context.beginPath();
      if (this.lastPoint) {
        this.context.moveTo(this.lastPoint.x, this.lastPoint.y);
      } else {
        this.context.moveTo(point.x, point.y);
      }
      this.context.lineTo(point.x, point.y);
      this.context.stroke();

      this.lastPoint = point;
      return;
    }

    if (this.tool() === 'shape') {
      if (this.startPoint && this.canvasBackup) {
        this.context.putImageData(this.canvasBackup, 0, 0);
        this.context.fillStyle = this.color();
        this.drawShapeFromPoints(this.startPoint, point);
      }
      return;
    }

    if (this.tool() === 'floodfill') {
      return;
    }

    this.context.strokeStyle = this.color();
    this.context.lineWidth = this.brushSize();
    this.context.lineCap = 'round';
    this.context.lineJoin = 'round';

    this.context.beginPath();
    if (this.lastPoint) {
      this.context.moveTo(this.lastPoint.x, this.lastPoint.y);
    } else {
      this.context.moveTo(point.x, point.y);
    }
    this.context.lineTo(point.x, point.y);
    this.context.stroke();

    this.lastPoint = point;
  }

  async submitDrawing(): Promise<void> {
    const lobbyId = this.match()?.lobbyId;
    const round = this.specialRound();
    const canvas = this.canvasRef()?.nativeElement;

    if (!lobbyId || !round || !canvas || !this.canSubmit()) {
      return;
    }

    const submitKey = `${lobbyId}:${round.roundNumber}:${this.currentPlayerId}`;

    if (submitKey === this.submittedRoundKey) {
      return;
    }

    this.submittedRoundKey = submitKey;
    this.loading.set(true);
    const response = await this.minigameService.submitPaintDrawing(lobbyId, canvas.toDataURL('image/png'));
    this.loading.set(false);

    if (!response.ok) {
      this.submittedRoundKey = '';
      this.errorMessage.set(response.reason || 'No se pudo enviar el dibujo.');
      return;
    }

    this.submitted.set(true);
  }

  async vote(targetPlayerId: string): Promise<void> {
    const lobbyId = this.match()?.lobbyId;

    if (!lobbyId || this.phase() !== 'voting' || this.votedTargetId() || targetPlayerId === this.currentPlayerId) {
      return;
    }

    this.loading.set(true);
    const response = await this.minigameService.submitPaintVote(lobbyId, targetPlayerId);
    this.loading.set(false);

    if (!response.ok) {
      this.errorMessage.set(response.reason || 'No se pudo votar el dibujo.');
      return;
    }

    this.votedTargetId.set(targetPlayerId);
  }

  private setupCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;

    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');

    if (!context) {
      return;
    }

    if (this.initializedCanvas === canvas && this.context === context) {
      return;
    }

    this.initializedCanvas = canvas;
    this.context = context;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.setupPreviewCanvas();
  }

  private setupPreviewCanvas(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const previewCanvas = this.previewCanvasRef()?.nativeElement;

    if (!canvas || !previewCanvas) {
      return;
    }

    previewCanvas.width = canvas.width;
    previewCanvas.height = canvas.height;
    this.previewContext = previewCanvas.getContext('2d') || undefined;
    this.clearPreviewCanvas();
  }

  private drawShapeFromPoints(startPoint: { x: number; y: number }, endPoint: { x: number; y: number }): void {
    if (!this.context) {
      return;
    }

    const shapeType = this.shape();

    if (shapeType === 'square') {
      const width = endPoint.x - startPoint.x;
      const height = endPoint.y - startPoint.y;
      this.context.fillRect(startPoint.x, startPoint.y, width, height);
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

    // circle
    const radius = Math.sqrt(Math.pow(endPoint.x - startPoint.x, 2) + Math.pow(endPoint.y - startPoint.y, 2));
    this.context.beginPath();
    this.context.arc(startPoint.x, startPoint.y, radius, 0, Math.PI * 2);
    this.context.fill();
  }

  private floodFill(startX: number, startY: number, fillColorHex: string): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas || !this.context) {
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

    const fillRGB = this.hexToRgb(fillColorHex);
    if (!fillRGB) {
      return;
    }

    const pixelPos = (sY * width + sX) * 4;
    const targetR = data[pixelPos];
    const targetG = data[pixelPos + 1];
    const targetB = data[pixelPos + 2];
    const targetA = data[pixelPos + 3];

    // If already the target fill color, return
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

    while (head < tail) {
      const currIdx = queue[head++];
      const currX = currIdx % width;
      const currY = Math.floor(currIdx / width);

      const currentPixelPos = currIdx * 4;
      const r = data[currentPixelPos];
      const g = data[currentPixelPos + 1];
      const b = data[currentPixelPos + 2];
      const a = data[currentPixelPos + 3];

      const colorDistance =
        Math.abs(r - targetR) + Math.abs(g - targetG) + Math.abs(b - targetB) + Math.abs(a - targetA);

      if (colorDistance <= matchThreshold) {
        data[currentPixelPos] = fillRGB.r;
        data[currentPixelPos + 1] = fillRGB.g;
        data[currentPixelPos + 2] = fillRGB.b;
        data[currentPixelPos + 3] = 255;

        // 4-connected check
        if (currX > 0) {
          const nextIdx = currIdx - 1;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currX < width - 1) {
          const nextIdx = currIdx + 1;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currY > 0) {
          const nextIdx = currIdx - width;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
        if (currY < height - 1) {
          const nextIdx = currIdx + width;
          if (!visited[nextIdx]) {
            visited[nextIdx] = 1;
            queue[tail++] = nextIdx;
          }
        }
      }
    }

    this.context.putImageData(imageData, 0, 0);
  }

  private hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  private getCanvasPoint(event: PointerEvent): { x: number; y: number } {
    const canvas = this.canvasRef()?.nativeElement;
    const rect = canvas?.getBoundingClientRect();

    if (!canvas || !rect) {
      return { x: 0, y: 0 };
    }

    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  private syncTimer(deadline: number | null): void {
    this.clearTimer();

    if (!deadline) {
      return;
    }

    const update = () => {
      const nextSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      this.remainingSeconds.set(nextSeconds);

      if (nextSeconds <= 0) {
        this.clearTimer();

        if (this.phase() === 'drawing' && !this.submitted()) {
          void this.submitDrawing();
        }
      }
    };

    update();
    this.timer = setInterval(update, 1000);
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  private drawPreviewCircle(point: { x: number; y: number }): void {
    if (!this.previewContext) {
      return;
    }

    const tool = this.tool();
    const ctx = this.previewContext;
    this.clearPreviewCanvas();

    if (tool !== 'brush' && tool !== 'eraser') {
      return;
    }

    ctx.save();
    ctx.beginPath();
    if (tool === 'brush') {
      ctx.arc(point.x, point.y, this.brushSize() / 2, 0, Math.PI * 2);
      ctx.strokeStyle = this.color();
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (tool === 'eraser') {
      ctx.arc(point.x, point.y, this.eraserSize() / 2, 0, Math.PI * 2);
      ctx.strokeStyle = '#000';
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  private clearPreviewCanvas(): void {
    const previewCanvas = this.previewCanvasRef()?.nativeElement;

    if (previewCanvas && this.previewContext) {
      this.previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
  }

  private toCursorUrl(svg: string, x: number, y: number, fallback: string): string {
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
  }
}
