import type { CaptureResult } from '../shared/types.js';
import type { CaptureStore } from './captures.js';
import type { AppFacade } from './mcp/tools.js';

/** Where the files go when an agent captures a frame or asks the app to save a photo. */
export class AppHub implements AppFacade {
  constructor(
    private readonly captures: CaptureStore,
    private readonly photos: CaptureStore,
  ) {}

  saveCapture(result: CaptureResult, tool: string): Promise<string> {
    return this.captures.save(result.data, result.mimeType, tool);
  }

  savePhoto(result: CaptureResult): Promise<string> {
    return this.photos.save(result.data, result.mimeType, 'photo');
  }
}
