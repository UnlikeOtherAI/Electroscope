import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

/** Adapters that only exist inside this computer (VMs, containers, WSL) and so are no use to a remote agent. */
const VIRTUAL = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|docker|veth|bridge|loopback|bluetooth|utun|awdl|llw|anpi/i;

function rank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const second = Number(ip.split('.')[1]);
  if (ip.startsWith('172.') && second >= 16 && second <= 31) return 2;
  if (ip.startsWith('100.')) return 3; // Tailscale / CGNAT
  return 4;
}

/** The computer's usable IPv4 addresses, home/office LAN first. */
export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const found: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue; // link-local
      found.push(i.address);
    }
  }
  return [...new Set(found)].sort((a, b) => rank(a) - rank(b));
}
