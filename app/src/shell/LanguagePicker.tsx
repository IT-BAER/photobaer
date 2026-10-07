// UI language picker in the menu bar: one flag per language, named in its own language for title and screen readers.
import { useRef, type ReactNode } from 'react';
import { i18n, LOCALES, RELEASED, saveLocale, type Locale } from '../i18n/index.ts';

// Five-pointed star centered on (cx, cy), outer radius r, first point at angle `rot` degrees from up.
function star(cx: number, cy: number, r: number, rot = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ((rot + i * 36) * Math.PI) / 180;
    const d = i % 2 ? r * 0.382 : r;
    pts.push(`${(cx + d * Math.sin(a)).toFixed(2)},${(cy - d * Math.cos(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

const bands = (dir: 'h' | 'v', colors: string[]) => colors.map((c, i) => dir === 'h'
  ? <rect key={i} y={(20 / colors.length) * i} width="30" height={20 / colors.length} fill={c} />
  : <rect key={i} x={(30 / colors.length) * i} width={30 / colors.length} height="20" fill={c} />);

// Simplified national flags at 3:2, drawn small (16 px tall); English uses the United Kingdom flag.
const FLAGS: Record<Locale, ReactNode> = {
  en: <>
    <rect width="30" height="20" fill="#012169" />
    <path d="M0 0L30 20M30 0L0 20" stroke="#fff" strokeWidth="4" />
    <path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" strokeWidth="1.6" />
    <path d="M15 0V20M0 10H30" stroke="#fff" strokeWidth="6" />
    <path d="M15 0V20M0 10H30" stroke="#c8102e" strokeWidth="3.4" />
  </>,
  de: bands('h', ['#000', '#dd0000', '#ffce00']),
  fr: bands('v', ['#002654', '#fff', '#ce1126']),
  es: <><rect width="30" height="20" fill="#aa151b" /><rect y="5" width="30" height="10" fill="#f1bf00" /></>,
  'pt-BR': <>
    <rect width="30" height="20" fill="#009c3b" />
    <path d="M15 2.2L27.6 10L15 17.8L2.4 10Z" fill="#ffdf00" />
    <circle cx="15" cy="10" r="4.4" fill="#002776" />
    <path d="M10.8 9.2Q15 8.2 19.2 11" stroke="#fff" strokeWidth="0.8" fill="none" />
  </>,
  ja: <><rect width="30" height="20" fill="#fff" /><circle cx="15" cy="10" r="6" fill="#bc002d" /></>,
  ko: <>
    <rect width="30" height="20" fill="#fff" />
    <circle cx="15" cy="10" r="5" fill="#0047a0" />
    <path d="M10 10A5 5 0 0 1 20 10A2.5 2.5 0 0 1 15 10A2.5 2.5 0 0 0 10 10Z" fill="#cd2e3a" />
    <g stroke="#000" strokeWidth="0.9">
      <path d="M5 3.4L7.4 6.2M4.2 4.1L6.6 6.9M3.4 4.8L5.8 7.6" />
      <path d="M22.6 13.8L25 16.6M23.4 13.1L25.8 15.9M24.2 12.4L26.6 15.2" />
      <path d="M25 3.4L22.6 6.2M25.8 4.1L23.4 6.9M26.6 4.8L24.2 7.6" />
      <path d="M7.4 13.8L5 16.6M6.6 13.1L4.2 15.9M5.8 12.4L3.4 15.2" />
    </g>
  </>,
  'zh-Hans': <>
    <rect width="30" height="20" fill="#ee1c25" />
    <polygon points={star(5, 5, 3)} fill="#ffff00" />
    <polygon points={star(10, 2, 1, 23)} fill="#ffff00" />
    <polygon points={star(12, 4, 1, 45)} fill="#ffff00" />
    <polygon points={star(12, 7, 1, 70)} fill="#ffff00" />
    <polygon points={star(10, 9, 1, 20)} fill="#ffff00" />
  </>,
  ru: bands('h', ['#fff', '#0039a6', '#d52b1e']),
  tr: <>
    <rect width="30" height="20" fill="#e30a17" />
    <circle cx="11" cy="10" r="5" fill="#fff" />
    <circle cx="12.25" cy="10" r="4" fill="#e30a17" />
    <polygon points={star(17.2, 10, 2.2, -90)} fill="#fff" />
  </>,
  pl: bands('h', ['#fff', '#dc143c']),
  it: bands('v', ['#009246', '#fff', '#ce2b37']),
};

export function Flag({ locale }: { locale: Locale }) {
  return (
    <svg className="flag" width="20" height="13" viewBox="0 0 30 20" aria-hidden="true">
      {FLAGS[locale]}
      <rect width="30" height="20" fill="none" stroke="#0003" strokeWidth="1" />
    </svg>
  );
}

const nameOf = (l: Locale) => new Intl.DisplayNames([l], { type: 'language' }).of(l) ?? l;

// Dev shows every language for testing; a build offers only reviewed ones and hides the picker while that is English alone.
export function LanguagePicker() {
  const list = useRef<HTMLDivElement>(null);
  const shown = import.meta.env.DEV ? LOCALES : RELEASED;
  if (shown.length < 2) return null;
  const current = (LOCALES as readonly string[]).includes(i18n.locale) ? (i18n.locale as Locale) : 'en';
  const place = (button: HTMLElement) => {
    const r = button.getBoundingClientRect();
    list.current!.style.top = `${r.bottom + 2}px`;
    list.current!.style.right = `${document.documentElement.clientWidth - r.right}px`;
  };
  return (
    <>
      <button type="button" className="lang-button" title={nameOf(current)} aria-label={nameOf(current)} aria-haspopup="menu"
        popoverTarget="lang-list" onClick={e => place(e.currentTarget)}>
        <Flag locale={current} />
      </button>
      <div ref={list} id="lang-list" className="lang-list" popover="auto" role="menu">
        {shown.map(l => (
          <button key={l} type="button" role="menuitemradio" aria-checked={l === current} title={nameOf(l)} aria-label={nameOf(l)}
            onClick={() => { if (l !== current) { saveLocale(l); location.reload(); } }}>
            <Flag locale={l} />
          </button>
        ))}
      </div>
    </>
  );
}
