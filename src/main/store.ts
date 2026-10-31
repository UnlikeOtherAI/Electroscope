import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types.js';

/** Small JSON settings file with atomic writes. */
export class SettingsStore {
  private current: Settings = { ...DEFAULT_SETTINGS };
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  static at(dir: string): SettingsStore {
    return new SettingsStore(join(dir, 'settings.json'));
  }

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      // Keep only keys this version knows, so settings from older versions do not leak through.
      const known = Object.fromEntries(Object.entries(raw).filter(([k]) => k in DEFAULT_SETTINGS));
      this.current = { ...DEFAULT_SETTINGS, ...known };
    } catch {
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.get();
  }

  get(): Settings {
    return structuredClone(this.current);
  }

  async patch(patch: Partial<Settings>): Promise<Settings> {
    this.current = { ...this.current, ...patch };
    const snapshot = JSON.stringify(this.current, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.file);
    });
    await this.writing;
    return this.get();
  }
}
