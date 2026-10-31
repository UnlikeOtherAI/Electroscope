import { randomUUID } from 'node:crypto';
import type { ActivityEntry, CaptureResult, SharedFrame } from '../shared/types.js';
import type { CaptureStore } from './captures.js';
import type { AppFacade } from './mcp/tools.js';

export interface HubEvents {
  activityAdded(entry: ActivityEntry): void;
  claudeCapturing(tool: string): void;
}

const MAX_ACTIVITY = 60;

/** App-side state the MCP tools rely on: access switch, activity log, frames shared by the human. */
export class AppHub implements AppFacade {
  private activity: ActivityEntry[] = [];
  private shared: SharedFrame[] = [];

  constructor(
    private readonly access: () => boolean,
    private readonly claudeStore: CaptureStore,
    private readonly sharedStore: CaptureStore,
    private readonly events: HubEvents,
  ) {}

  claudeAccess(): boolean {
    return this.access();
  }

  announceCapture(tool: string): void {
    this.events.claudeCapturing(tool);
  }

  async recordCapture(result: CaptureResult, tool: string, source: 'claude' | 'user'): Promise<ActivityEntry> {
    const path = await this.claudeStore.save(result.data, result.mimeType, tool);
    const entry = this.toEntry(result, tool, source, path);
    this.push(entry);
    return entry;
  }

  /** The human pinned a frame for Claude. */
  async addShared(result: CaptureResult, note: string): Promise<SharedFrame> {
    const path = await this.sharedStore.save(result.data, result.mimeType, 'shared');
    const entry: SharedFrame = { ...this.toEntry(result, 'share', 'user', path), note };
    this.shared.push(entry);
    this.push(entry);
    return entry;
  }

  async sharedFrames() {
    return Promise.all(
      this.shared.map(async (entry) => ({
        entry,
        data: await this.sharedStore.read(entry.path),
        mimeType: entry.path.endsWith('.png') ? 'image/png' : 'image/jpeg',
      })),
    );
  }

  async clearShared(): Promise<void> {
    this.shared = [];
  }

  sharedCount(): number {
    return this.shared.length;
  }

  listActivity(): ActivityEntry[] {
    return [...this.activity];
  }

  clearActivity(): void {
    this.activity = [];
  }

  private push(entry: ActivityEntry): void {
    this.activity.push(entry);
    if (this.activity.length > MAX_ACTIVITY) this.activity.shift();
    this.events.activityAdded(entry);
  }

  private toEntry(result: CaptureResult, tool: string, source: 'claude' | 'user', path: string): ActivityEntry {
    return {
      id: randomUUID(),
      at: result.capturedAt,
      source,
      tool,
      cameraLabel: result.camera.label,
      width: result.width,
      height: result.height,
      bytes: result.data.byteLength,
      path,
      thumbnail: result.thumbnail,
      region: result.region,
    };
  }
}
