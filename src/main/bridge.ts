import { randomUUID } from 'node:crypto';
import type { RendererCommandName, RendererCommands } from '../shared/types.js';
import type { CameraBackend } from './mcp/tools.js';

export interface CommandEnvelope {
  id: string;
  name: RendererCommandName;
  args: unknown;
}

export interface CommandResult {
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * Request/response over a one-way `send` channel. The renderer owns the camera;
 * the main process (MCP) asks it to do things and awaits the reply.
 */
export class RendererBridge implements CameraBackend {
  private readonly pending = new Map<string, Pending>();
  private ready: Promise<void>;
  private markReady!: () => void;

  constructor(
    private readonly send: (envelope: CommandEnvelope) => boolean,
    private readonly timeoutMs = 20_000,
  ) {
    this.ready = new Promise((r) => (this.markReady = r));
  }

  rendererReady(): void {
    this.markReady();
  }

  handleResult(msg: CommandResult): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? 'Renderer command failed'));
  }

  async call<K extends RendererCommandName>(
    name: K,
    args: Parameters<RendererCommands[K]>[0],
  ): Promise<ReturnType<RendererCommands[K]>> {
    await Promise.race([
      this.ready,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Electroscope window is not ready yet')), this.timeoutMs),
      ),
    ]);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Camera did not respond to "${name}" in ${this.timeoutMs / 1000}s`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (!this.send({ id, name, args })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('Electroscope window is closed'));
      }
    });
  }
}
