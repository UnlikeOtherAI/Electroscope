const base = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icons = {
  camera: base('<path d="M4 8h3l1.6-2.2h6.8L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.4"/>'),
  refresh: base('<path d="M20 5v5h-5"/><path d="M4 19v-5h5"/><path d="M19 10a7.5 7.5 0 0 0-13.2-2.3M5 14a7.5 7.5 0 0 0 13.2 2.3"/>'),
  zoomIn: base('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M11 8v6M8 11h6"/>'),
  zoomOut: base('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2M8 11h6"/>'),
  fit: base('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  grid: base('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>'),
  crosshair: base('<circle cx="12" cy="12" r="7"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>'),
  freeze: base('<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/><path d="m9.5 4.5 2.5 2 2.5-2M9.5 19.5l2.5-2 2.5 2"/>'),
  save: base('<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/>'),
  share: base('<path d="M4 12 20 4l-5 16-3.2-6.3z"/><path d="m11.8 13.7 3.4-4.2"/>'),
  folder: base('<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.2H19A1.5 1.5 0 0 1 20.5 9.2V17.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  settings: base('<circle cx="12" cy="12" r="3"/><path d="M19.4 14a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  copy: base('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
  rotateCw: base('<path d="M20 5v5h-5"/><path d="M19.4 10A8 8 0 1 0 20 13"/>'),
  rotateCcw: base('<path d="M4 5v5h5"/><path d="M4.6 10A8 8 0 1 1 4 13"/>'),
  flip: base('<path d="M12 3v18" stroke-dasharray="2 3"/><path d="M9 7 3.5 17H9zM15 7l5.5 10H15z"/>'),
  eye: base('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  close: base('<path d="m6 6 12 12M18 6 6 18"/>'),
  check: base('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  trash: base('<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l.8 12.5h9.4L17.5 7"/>'),
  circle: base('<circle cx="12" cy="12" r="7.5"/>'),
  rect: base('<rect x="4.5" y="6.5" width="15" height="11" rx="1.5"/>'),
  arrow: base('<path d="M5 19 19 5M10 5h9v9"/>'),
  text: base('<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>'),
  plus: base('<path d="M12 4v16M4 12h16"/>'),
  // A small version of build/icon.svg, for the title bar.
  logo: `<svg viewBox="0 0 32 32" width="24" height="24" aria-hidden="true"><defs><linearGradient id="lgb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16263d"/><stop offset="1" stop-color="#08111f"/></linearGradient><linearGradient id="lgr" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#b8efff"/><stop offset="0.5" stop-color="#4aa8ff"/><stop offset="1" stop-color="#2358d8"/></linearGradient></defs><rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="url(#lgb)"/><circle cx="16" cy="16" r="10.3" fill="none" stroke="url(#lgr)" stroke-width="2.2"/><path d="M8 16h6M18 16h2.5l2.5-2.5h2" stroke="#7fe0ff" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="2.3" fill="#ff8a65"/></svg>`,
};
