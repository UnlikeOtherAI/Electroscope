import { beforeAll, describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { lanAddresses } from '../src/main/net.js';
import { buildAgentPrompt } from '../src/shared/prompt.js';

const nic = (address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo =>
  ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null, ...extra }) as NetworkInterfaceInfo;

describe('lanAddresses', () => {
  it('skips loopback, link-local, IPv6 and virtual adapters, and puts the home LAN first', () => {
    const found = lanAddresses({
      'vEthernet (WSL)': [nic('172.30.44.1')],
      'Loopback Pseudo-Interface 1': [nic('127.0.0.1', { internal: true })],
      Tailscale: [nic('100.70.1.2')],
      Ethernet: [nic('10.0.0.8'), nic('fe80::1', { family: 'IPv6' } as never), nic('169.254.3.4')],
      'Wi-Fi': [nic('192.168.1.165')],
    });
    expect(found).toEqual(['192.168.1.165', '10.0.0.8', '100.70.1.2']);
  });

  it('returns nothing when there is no network', () => {
    expect(lanAddresses({ lo: [nic('127.0.0.1', { internal: true })] })).toEqual([]);
  });
});

describe('buildAgentPrompt', () => {
  const info = { port: 7821, addresses: ['192.168.1.165', '10.0.0.8'], hostname: 'Minis', network: true };

  it('puts the IP and port in the connection instructions', () => {
    const p = buildAgentPrompt(info);
    expect(p).toContain('http://192.168.1.165:7821/mcp');
    expect(p).toContain('claude mcp add --transport http electroscope http://192.168.1.165:7821/mcp');
    expect(p).toContain('http://192.168.1.165:7821/health');
    expect(p).toContain('http://10.0.0.8:7821/mcp');
    expect(p).toContain('http://Minis.local:7821/mcp');
  });

  it('names every tool the server really has', async () => {
    const p = buildAgentPrompt(info);
    for (const t of ['get_status', 'list_cameras', 'select_camera', 'capture_snapshot', 'capture_sequence', 'set_camera_controls', 'set_orientation', 'set_view', 'annotate', 'clear_annotations', 'save_photo']) {
      expect(p, t).toContain(t);
    }
  });

  it('uses loopback only when network access is off', () => {
    const p = buildAgentPrompt({ ...info, network: false });
    expect(p).toContain('http://127.0.0.1:7821/mcp');
    expect(p).not.toContain('192.168.1.165');
    expect(p).not.toContain('.local');
  });

  it('falls back to loopback when no network address is known', () => {
    expect(buildAgentPrompt({ ...info, addresses: [] })).toContain('http://127.0.0.1:7821/mcp');
  });
});

describe('annotation validation', () => {
  beforeAll(() => {
    // The renderer relies on the browser's CSS parser to validate colours.
    (globalThis as { CSS?: unknown }).CSS = {
      supports: (_p: string, v: string) => /^(#[0-9a-f]{3,8}|[a-z]+|rgba?\(.*\)|hsla?\(.*\))$/i.test(v) && v !== 'notacolor',
    };
  });

  it('fills defaults and requires the fields each type needs', async () => {
    const { normalise } = await import('../src/renderer/annotations.js');
    expect(normalise({ type: 'circle', x: 0.5, y: 0.5 }, 'a')).toMatchObject({ radius: 0.04, color: '#ff3b30', thickness: 3 });
    expect(normalise({ type: 'crosshair', x: 0.5, y: 0.5 }, 'a').size).toBe(0.03);
    expect(() => normalise({ type: 'rect', x: 0.1, y: 0.1 }, 'a')).toThrow(/width and height/);
    expect(() => normalise({ type: 'arrow', x: 0.1, y: 0.1 }, 'a')).toThrow(/to_x and to_y/);
    expect(() => normalise({ type: 'text', x: 0.1, y: 0.1 }, 'a')).toThrow(/need text/);
    expect(() => normalise({ type: 'circle', x: 2, y: 0.1 }, 'a')).toThrow(/0 to 1/);
  });

  it('refuses a colour the browser cannot parse, with advice', async () => {
    const { normalise } = await import('../src/renderer/annotations.js');
    expect(() => normalise({ type: 'circle', x: 0.5, y: 0.5, color: 'notacolor' }, 'a')).toThrow(/not a CSS colour/);
  });
});
