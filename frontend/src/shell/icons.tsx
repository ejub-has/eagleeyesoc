/** Single-path line icons on a 24px grid, drawn in the current text colour. */
const PATHS = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z',
  cases: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  triage: 'M4 5h16l-6 7v6l-4 2v-8z',
  workflows: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a3 3 0 0 0 3 3h4M17 14V7a3 3 0 0 0-3-3h-4',
  search: 'M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12zM16 16l4 4',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  light:
    'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
  system: 'M3 4h18v12H3zM8 20h8M12 16v4',
  expand: 'M9 6l6 6-6 6',
  collapse: 'M15 6l-6 6 6 6',
  back: 'M19 12H5M11 18l-6-6 6-6',
  close: 'M18 6L6 18M6 6l12 12',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM4 21a8 8 0 0 1 16 0',
  device: 'M5 5h14v10H5zM2 19h20',
  note: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5',
  webhook: 'M10 4a4 4 0 0 1 4 6.5L17 16M7 19a4 4 0 0 1-2.5-7.2L8 6M20 18a4 4 0 0 1-7 1H7',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  gate: 'M12 2.5l9.5 9.5-9.5 9.5L2.5 12zM8.5 12l2.5 2.5 4.5-5',
  flag: 'M5 21V4h12l-2 4 2 4H5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  play: 'M7 4l13 8-13 8z',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Eagle head inside a scanning ring; the same mark as public/favicon.svg. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#18212a" />
      <circle
        cx="20.5"
        cy="20"
        r="17"
        fill="none"
        stroke="#2fbf71"
        strokeWidth="1.6"
        strokeDasharray="19 7.7"
      />
      <path
        d="M9 35C8.5 24 12 14.5 20 11.2c4-1.6 8-1.3 11 .4l-4.5 6.9C22 20 18.5 24.5 16.5 35Z"
        fill="#eef2f6"
      />
      <path d="M16.5 35c2-8.5 5.5-13.5 11-15.4l3 3.4c-5 2.5-8 6.5-9 12Z" fill="#5a4330" />
      <path
        d="M29.6 11c3.8-.4 7.2 1.4 8 5 .3 1.6-.3 3.4-1.6 4.4-.1-1.6-1-2.5-2.4-2.5l-6.4.5Z"
        fill="#f0b429"
      />
      <path d="M20.6 12.4 29.2 14" stroke="#18212a" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="25.3" cy="15.4" r="1.35" fill="#f0b429" />
      <circle cx="25.5" cy="15.4" r=".65" fill="#0b0f14" />
    </svg>
  )
}
