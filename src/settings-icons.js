"use strict";
// Settings sidebar icons — inline SVG strings keyed by tab id.
//
// All icons use a 24x24 viewBox, `stroke="currentColor"`, fill="none",
// stroke-width 1.5, so they inherit the sidebar text color (works in
// both light and dark mode) and visually match each other.
//
// Why inline SVG and not <img src="...">?
//  - The settings renderer innerHTMLs the icon string in place; inline
//    SVG side-steps any path resolution (asar / file://) that bites
//    packaged builds.
//  - Each icon is small (~200-500 bytes); the whole file weighs <5 KB.
//
// Keys must match the sidebar tab ids in settings-renderer.js. Unknown
// ids fall back to `placeholder`.

const ICONS = {
  // gear
  general:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>' +
    '</svg>',

  // bolt
  agents:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z"/>' +
    '</svg>',

  // palette
  theme:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M12 22a10 10 0 1 1 10-10c0 2.5-2 4-4 4h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 22Z"/>' +
    '<circle cx="7.5" cy="10.5" r="1" fill="currentColor"/>' +
    '<circle cx="12" cy="7.5" r="1" fill="currentColor"/>' +
    '<circle cx="16.5" cy="10.5" r="1" fill="currentColor"/>' +
    '</svg>',

  // film strip
  animOverrides:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="M7 4v16M17 4v16"/>' +
    '<path d="M3 9h4M17 9h4M3 15h4M17 15h4"/>' +
    '</svg>',

  // keyboard
  shortcuts:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="2" y="6" width="20" height="12" rx="2"/>' +
    '<path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>' +
    '</svg>',

  // paper plane (send)
  "telegram-approval":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M22 2 11 13"/>' +
    '<path d="M22 2 15 22l-4-9-9-4 20-7Z"/>' +
    '</svg>',

  // plug
  "remote-ssh":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="M9 2v6M15 2v6"/>' +
    '<path d="M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8Z"/>' +
    '<path d="M12 16v6"/>' +
    '</svg>',

  // smartphone
  mobile:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<rect x="5" y="2" width="14" height="20" rx="2"/>' +
    '<path d="M12 18h.01"/>' +
    '</svg>',

  // info circle
  about:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<circle cx="12" cy="12" r="9"/>' +
    '<path d="M12 11v6M12 7.5v.01"/>' +
    '</svg>',

  // wrench (placeholder when a tab is missing one)
  placeholder:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">' +
    '<path d="m14.5 5.5 4 4-9 9-4 .5.5-4 8.5-9.5Z"/>' +
    '<path d="m18.5 5.5-3 3"/>' +
    '</svg>',
};

function getIcon(id) {
  return ICONS[id] || ICONS.placeholder;
}

globalThis.ClawdSettingsIcons = { getIcon, ICONS };
