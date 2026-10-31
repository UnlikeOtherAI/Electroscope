import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Saves frames to a folder and keeps only the newest `maxFiles`. */
export class CaptureStore {
  private counter = 0;

  constructor(
    readonly dir: string,
    private readonly maxFiles = 200,
  ) {}

  async save(data: Uint8Array, mimeType: string, label: string): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safe = label.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'frame';
    const file = join(this.dir, `${stamp}-${String(this.counter++ % 1000).padStart(3, '0')}-${safe}.${ext}`);
    await writeFile(file, data);
    void this.prune().catch(() => undefined);
    return file;
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  }

  private async prune(): Promise<void> {
    const names = await readdir(this.dir);
    if (names.length <= this.maxFiles) return;
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(this.dir, n))).mtimeMs })),
    );
    withTimes.sort((a, b) => a.t - b.t);
    for (const { n } of withTimes.slice(0, names.length - this.maxFiles)) {
      await unlink(join(this.dir, n)).catch(() => undefined);
    }
  }
}
