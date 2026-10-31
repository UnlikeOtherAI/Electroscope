import type { ServerInfo } from './types.js';

/**
 * The text behind "Copy prompt for agent": everything an AI agent needs to connect to this
 * microscope and use it, with the address this computer is reachable on.
 */
export function buildAgentPrompt(info: Pick<ServerInfo, 'port' | 'addresses' | 'hostname' | 'network'>): string {
  const host = info.network ? (info.addresses[0] ?? '127.0.0.1') : '127.0.0.1';
  const url = `http://${host}:${info.port}/mcp`;
  const alternatives: string[] = [];
  if (info.network) {
    for (const a of info.addresses.slice(1)) alternatives.push(`http://${a}:${info.port}/mcp`);
    if (info.hostname) alternatives.push(`http://${info.hostname}.local:${info.port}/mcp`);
  }

  const lines = [
    'You have access to a live electronics microscope camera through an MCP server called Electroscope.',
    '',
    `MCP endpoint (Streamable HTTP, no authentication): ${url}`,
    ...(alternatives.length ? [`Other addresses for the same server: ${alternatives.join(' , ')}`] : []),
    `Health check: GET http://${host}:${info.port}/health`,
    '',
    'Connect:',
    `- Claude Code: claude mcp add --transport http electroscope ${url}`,
    '- Any client that supports remote HTTP MCP servers: add a server named "electroscope" with that URL.',
    `- Clients that only start local stdio servers: use  npx -y mcp-remote ${url}`,
    '',
    'How it works: the app owns the camera and a human is watching the same live view in its window, so never ask them to stop or switch streams. You get still frames on demand and can drive every control the app has.',
    '',
    'Tools:',
    '- get_status: active camera, resolution, fps, orientation, view, live focus score, adjustable camera controls with ranges. Call this first.',
    '- list_cameras / select_camera: see every camera and switch the live view to one, optionally at a resolution.',
    '- capture_snapshot: one still image plus metrics (focus_score, brightness, exposure) and hints. Use region {x,y,width,height} (0..1) for a full-resolution close-up of part of the frame, or follow_user_view to capture exactly what the human has zoomed to.',
    '- capture_sequence: 2-6 frames at an interval, to watch something change (LED, heating part, smoke).',
    '- set_camera_controls: focus, zoom, exposure, brightness and so on, where the camera supports them. Controls marked responsive:false in get_status do nothing on this camera.',
    '- set_orientation: rotate 0/90/180/270 and mirror. Affects the human\'s view and your captures.',
    '- set_view: zoom, pan, grid, crosshair (with colours), freeze the on-screen view.',
    '- annotate / clear_annotations: draw circles, crosshairs, rectangles, arrows and text on the live view, each in any colour. Positions use the same 0..1 coordinates as capture regions, so you can look at a frame and then point at exactly what you saw. Pass include_annotations to a capture to burn the marks into the image.',
    '- save_photo: save a full-resolution photo on the computer running Electroscope and return its path.',
    '',
    'Tips: check focus_score and the hints before trusting fine detail; compare focus scores only within the same scene. For text on chips and solder joints, capture a small region at full resolution instead of a large downscaled frame.',
  ];
  return lines.join('\n');
}
