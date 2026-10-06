"use client";

import { useId } from "react";

const defaultPalette = { light: "#FFB9CB", main: "#F56B91", dark: "#CF4778", mist: "#FFF1F6" };

const palettes: Record<string, { light: string; main: string; dark: string; mist: string }> = {
  ROMANCE: defaultPalette,
  RISE_GROWTH: { light: "#FFD899", main: "#F5A340", dark: "#D57722", mist: "#FFF6E9" },
  FAMILY: { light: "#FFD79E", main: "#ECAD68", dark: "#B7794F", mist: "#FFF6E9" },
  URBAN_REALITY: { light: "#A7D8F9", main: "#69AADA", dark: "#4275A2", mist: "#F0F8FF" },
  SUSPENSE_CRIME: { light: "#9FACDA", main: "#5F719C", dark: "#313D67", mist: "#F0F2FC" },
  COMEDY: { light: "#FFE99D", main: "#F5C051", dark: "#CB8D30", mist: "#FFF9E6" },
  XUANHUAN: { light: "#D0BCFF", main: "#A98BE0", dark: "#7756AF", mist: "#F6F0FF" },
  FANTASY: { light: "#E6C1FF", main: "#C096E7", dark: "#9267C4", mist: "#FAF0FE" },
  SCI_FI: { light: "#B5E0FF", main: "#7AADF1", dark: "#527DD4", mist: "#EFF7FF" },
  ACTION_ADVENTURE: { light: "#FFB9A8", main: "#EA866F", dark: "#B65450", mist: "#FFF1EC" },
  HISTORICAL_INTRIGUE: { light: "#F7DB9E", main: "#D6AD60", dark: "#AD8042", mist: "#FBF6E9" },
  YOUTH_CAMPUS: { light: "#B0E1D3", main: "#72B9A5", dark: "#438E82", mist: "#EEFAF5" },
};

export function CategoryArtwork({ id }: { id: string }) {
  const uid = useId().replace(/:/g, "");
  const palette = palettes[id] ?? defaultPalette;
  const body = `url(#${uid}-body)`;
  const soft = `url(#${uid}-soft)`;
  const edge = `url(#${uid}-edge)`;
  const white = "#FFFEFD";

  const artwork = (() => {
    switch (id) {
      case "RISE_GROWTH":
        return (
          <>
            <path d="M20 83 43 72 97 81 76 99Z" fill={palette.dark} opacity=".09" />
            <path d="M25 68 40 61 55 67 40 75Z" fill={palette.light} />
            <path d="M25 68V88L40 95V75Z" fill={body} />
            <path d="M40 75 55 67V87L40 95Z" fill={palette.dark} opacity=".75" />
            <path d="M46 51 61 44 76 50 61 58Z" fill={palette.light} />
            <path d="M46 51V81L61 88V58Z" fill={body} />
            <path d="M61 58 76 50V80L61 88Z" fill={palette.dark} opacity=".7" />
            <path d="M67 34 82 27 97 33 82 41Z" fill={palette.light} />
            <path d="M67 34V74L82 81V41Z" fill={body} />
            <path d="M82 41 97 33V73L82 81Z" fill={palette.dark} opacity=".75" />
            <path d="m23 52 24-20 13 5 19-18" fill="none" stroke={white} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m69 19 12-3-1 12" fill="none" stroke={white} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="98" cy="55" r="3" fill={palette.light} />
          </>
        );
      case "FAMILY":
        return (
          <>
            <ellipse cx="60" cy="94" rx="39" ry="7" fill={palette.dark} opacity=".1" />
            <path d="M28 52 60 29 92 52V88a5 5 0 0 1-5 5H33a5 5 0 0 1-5-5Z" fill={soft} />
            <path d="M60 29 92 52V88a5 5 0 0 1-5 5H77V50Z" fill={palette.main} opacity=".55" />
            <path d="M80 26H89V47H80Z" fill={palette.dark} />
            <path d="m20 53 36-29a7 7 0 0 1 8 0l36 29-6 8-34-26-34 26Z" fill={body} />
            <path d="M52 68a8 8 0 0 1 16 0v25H52Z" fill={palette.dark} opacity=".75" />
            <rect x="35" y="62" width="10" height="12" rx="2" fill={white} />
            <path d="M40 62V74M35 68H45" stroke={palette.main} strokeWidth="1.5" />
            <circle cx="64" cy="81" r="1.4" fill={palette.light} />
            <path d="M60 55c-12-7-7-16 0-10 7-6 12 3 0 10Z" fill="#E8897E" />
            <circle cx="23" cy="79" r="10" fill="#BDD1A3" />
            <path d="M23 79V94" stroke="#9BB58C" strokeWidth="3" strokeLinecap="round" />
          </>
        );
      case "URBAN_REALITY":
        return (
          <>
            <ellipse cx="61" cy="94" rx="43" ry="7" fill={palette.dark} opacity=".1" />
            <rect x="25" y="45" width="25" height="46" rx="3" fill={soft} />
            <path d="M46 32 70 25 86 32V93H46Z" fill={body} />
            <path d="m70 25 16 7V93H70Z" fill={palette.dark} opacity=".45" />
            <path d="M70 25V17" stroke={palette.main} strokeWidth="2.5" strokeLinecap="round" />
            <path d="M50 32 70 27 81 32Z" fill={palette.light} />
            <rect x="77" y="57" width="22" height="37" rx="3" fill={soft} />
            <path d="M33 55H39M33 65H39M33 75H39M54 44H62M54 54H62M54 64H62M54 74H62M84 67H91M84 77H91" stroke={white} strokeWidth="3.5" strokeLinecap="round" opacity=".9" />
            <path d="M59 84H66V94H59Z" fill={palette.dark} />
            <circle cx="25" cy="33" r="7" fill="#F8DDA1" />
            <path d="M93 38h8" stroke={palette.light} strokeWidth="3" strokeLinecap="round" />
          </>
        );
      case "SUSPENSE_CRIME":
        return (
          <>
            <ellipse cx="60" cy="95" rx="39" ry="6" fill={palette.dark} opacity=".12" />
            <path d="M27 94V52a33 33 0 0 1 66 0v42Z" fill={body} />
            <path d="M39 94V53a21 21 0 0 1 42 0v41Z" fill={palette.dark} />
            <path d="M42 94V53a18 18 0 0 1 18-18v59Z" fill="#E8CBA3" opacity=".9" />
            <path d="m60 35 15 7v52H60Z" fill="#1E2A4D" />
            <path d="M42 94h33l13 10H29Z" fill={palette.light} opacity=".4" />
            <circle cx="58" cy="63" r="5.5" fill="#39435E" />
            <path d="m53 69-4 14h5v11h4l2-15 2 15h4V83h5l-7-14Z" fill="#39435E" />
            <path d="M28 48h7M85 48h7M28 66h7M85 66h7" stroke={palette.light} strokeWidth="2" opacity=".6" />
            <circle cx="71" cy="67" r="1.5" fill={palette.light} />
            <path d="m96 27 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill={palette.light} />
          </>
        );
      case "COMEDY":
        return (
          <>
            <ellipse cx="61" cy="95" rx="35" ry="7" fill={palette.dark} opacity=".1" />
            <path d="M62 29 99 38l-5 29c-3 15-14 21-25 23-10-7-17-17-14-32Z" fill={soft} />
            <path d="m68 50 5-2 4 4m9 1 5-1 3 4" fill="none" stroke={palette.dark} strokeWidth="2.8" strokeLinecap="round" />
            <path d="M69 69c6 7 13 9 21 4" fill="none" stroke={palette.dark} strokeWidth="3" strokeLinecap="round" />
            <path d="M24 35 62 25l11 36c4 16-6 29-20 37-15-3-28-12-30-27Z" fill={body} />
            <path d="m29 38 31-8 2 8-31 8Z" fill={palette.light} opacity=".55" />
            <path d="M33 57q4-7 9-2M53 51q4-7 9-2" fill="none" stroke={palette.dark} strokeWidth="3.5" strokeLinecap="round" />
            <path d="M34 70q16 3 28-9c4 13-2 21-10 23-8 2-15-4-18-14Z" fill={white} />
            <path d="M36 73q13 2 24-7" fill="none" stroke={palette.dark} strokeWidth="1.5" opacity=".2" />
            <path d="m17 23 2 5 5 1-5 2-1 5-2-5-5-1 5-2Z" fill={palette.light} />
          </>
        );
      case "XUANHUAN":
        return (
          <>
            <circle cx="77" cy="30" r="16" fill={soft} />
            <path d="m12 88 24-49 15 22 13-31 31 58Z" fill={soft} />
            <path d="m47 91 22-40 15 19 13-16 15 37Z" fill={body} opacity=".7" />
            <path d="m21 95 17-35 17 35Z" fill={palette.main} opacity=".4" />
            <path d="M49 88V60H69V88Z" fill={palette.dark} />
            <path d="M45 63h28L59 51ZM43 76h32L59 65ZM45 88h28L59 79Z" fill={body} />
            <path d="M45 63h28M43 76h32M45 88h28" stroke={palette.dark} strokeWidth="2.5" strokeLinecap="round" />
            <path d="M59 51V43" stroke={palette.dark} strokeWidth="2" strokeLinecap="round" />
            <path d="M56 68h6M56 81h6" stroke={palette.light} strokeWidth="2.5" />
            <path d="M19 96c21-9 38 6 54-1 12-6 20-3 28-1M14 83h20M85 76h22" fill="none" stroke={white} strokeWidth="4" strokeLinecap="round" opacity=".8" />
          </>
        );
      case "FANTASY":
        return (
          <>
            <ellipse cx="61" cy="94" rx="34" ry="6" fill={palette.dark} opacity=".08" />
            <path d="M76 24a35 35 0 1 0 20 49 31 31 0 0 1-20-49Z" fill={body} />
            <path d="M48 35a31 31 0 0 0 1 48" fill="none" stroke={palette.light} strokeWidth="5" strokeLinecap="round" opacity=".8" />
            <circle cx="79" cy="66" r="15" fill={soft} />
            <ellipse cx="79" cy="67" rx="25" ry="7" transform="rotate(-25 79 67)" fill="none" stroke="#EBAFD4" strokeWidth="4" />
            <path d="m91 20 2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5Z" fill={palette.light} />
            <path d="m24 23 2 4 4 2-4 2-2 4-2-4-4-2 4-2Z" fill="#EDBCDD" />
            <circle cx="103" cy="47" r="2" fill={palette.main} />
            <circle cx="37" cy="90" r="2" fill={palette.main} />
          </>
        );
      case "SCI_FI":
        return (
          <>
            <ellipse cx="59" cy="96" rx="31" ry="5" fill={palette.dark} opacity=".08" />
            <ellipse cx="60" cy="63" rx="49" ry="15" transform="rotate(-29 60 63)" fill="none" stroke={palette.light} strokeWidth="4" />
            <circle cx="60" cy="59" r="28" fill={body} />
            <path d="M41 48c8-10 19-13 31-8" fill="none" stroke={palette.light} strokeWidth="5" strokeLinecap="round" opacity=".9" />
            <path d="M38 76c12 12 34 12 44-5" fill="none" stroke={palette.dark} strokeWidth="5" strokeLinecap="round" opacity=".23" />
            <path d="M17 84c4 8 26 4 50-9 23-13 40-30 37-37" fill="none" stroke="#A0C3EF" strokeWidth="5" strokeLinecap="round" />
            <circle cx="98" cy="42" r="6" fill={soft} />
            <circle cx="25" cy="28" r="4" fill={palette.main} />
            <path d="m82 20 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill={palette.light} />
            <circle cx="100" cy="84" r="2.5" fill={palette.light} />
          </>
        );
      case "ACTION_ADVENTURE":
        return (
          <>
            <circle cx="82" cy="32" r="15" fill={soft} />
            <path d="m9 93 36-61 26 45 12-24 28 40Z" fill={soft} />
            <path d="m45 32 26 45 12-24 28 40H63Z" fill={body} />
            <path d="m34 51 11-19 11 19-10-5Z" fill={white} opacity=".9" />
            <path d="m78 63 5-10 8 13-7-3Z" fill={white} opacity=".7" />
            <path d="m20 96 42-26 31 26Z" fill={palette.dark} opacity=".8" />
            <circle cx="60" cy="47" r="5" fill="#8D4948" />
            <path d="m56 53-8 12 9 3 6-11 8 6 9-2" fill="none" stroke="#8D4948" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m58 65 4 11-8 11m8-11 10 8 9-1" fill="none" stroke="#8D4948" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="m49 56-7 4m-3 5-7 4" stroke={palette.main} strokeWidth="2.5" strokeLinecap="round" />
          </>
        );
      case "HISTORICAL_INTRIGUE":
        return (
          <>
            <ellipse cx="60" cy="96" rx="42" ry="6" fill={palette.dark} opacity=".1" />
            <path d="M25 66H95V92H25Z" fill={soft} />
            <path d="M40 44H80V92H40Z" fill={body} />
            <path d="M19 69c10-3 18-8 23-16 3 8 11 13 20 16ZM60 69c10-3 18-8 23-16 3 8 11 13 20 16Z" fill={palette.main} />
            <path d="M33 47c13-3 23-12 27-24 4 12 14 21 27 24Z" fill={palette.dark} />
            <path d="M31 48h58M18 70h35M70 70h33" stroke={palette.light} strokeWidth="3" strokeLinecap="round" />
            <path d="M60 23V17" stroke={palette.dark} strokeWidth="2" strokeLinecap="round" />
            <path d="M49 61h22M49 67h22" stroke={palette.light} strokeWidth="3" />
            <path d="M52 92V81a8 8 0 0 1 16 0v11Z" fill={palette.dark} />
            <path d="M33 76V86M87 76V86" stroke={white} strokeWidth="4" strokeLinecap="round" opacity=".8" />
            <path d="M20 94h80" stroke={palette.main} strokeWidth="4" strokeLinecap="round" />
          </>
        );
      case "YOUTH_CAMPUS":
        return (
          <>
            <ellipse cx="60" cy="96" rx="42" ry="6" fill={palette.dark} opacity=".09" />
            <rect x="24" y="56" width="72" height="37" rx="3" fill={soft} />
            <path d="M43 45 60 33 77 45V93H43Z" fill={body} />
            <path d="m38 47 22-17 22 17" fill="none" stroke={palette.dark} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M60 30V17l15 4-15 4" fill="#ECB77D" stroke={palette.dark} strokeWidth="1.5" strokeLinejoin="round" />
            <circle cx="60" cy="53" r="8" fill={white} />
            <path d="M60 48v5l3 2" fill="none" stroke={palette.dark} strokeWidth="1.8" strokeLinecap="round" />
            <path d="M31 66h5M31 77h5M84 66h5M84 77h5" stroke={white} strokeWidth="4" strokeLinecap="round" />
            <path d="M54 93V79a6 6 0 0 1 12 0v14Z" fill={palette.dark} />
            <path d="M44 95h33" stroke={palette.main} strokeWidth="3" strokeLinecap="round" />
            <circle cx="20" cy="75" r="9" fill="#A8D7B5" />
            <path d="M20 76v18" stroke={palette.dark} strokeWidth="2.5" strokeLinecap="round" />
          </>
        );
      case "ROMANCE":
      default:
        return (
          <>
            <ellipse cx="61" cy="96" rx="34" ry="6" fill={palette.dark} opacity=".09" />
            <path d="M60 94C50 87 24 69 23 50c-1-25 27-32 37-12 12-20 40-13 38 12-2 20-27 38-38 44Z" fill={edge} />
            <path d="M57 89C45 80 22 66 22 47c0-23 26-29 35-10 12-19 38-12 36 10-1 19-25 36-36 42Z" fill={body} />
            <path d="M31 48c0-9 6-15 13-12" fill="none" stroke="#FFE3EC" strokeWidth="5" strokeLinecap="round" />
            <path d="M81 44c5 19-18 35-26 40" fill="none" stroke={palette.dark} strokeWidth="3" strokeLinecap="round" opacity=".12" />
            <path d="M93 31c-8-5-5-12 0-8 5-4 8 3 0 8Z" fill={palette.light} />
            <path d="m20 73 2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill={palette.light} />
            <circle cx="97" cy="76" r="3" fill={palette.light} />
          </>
        );
    }
  })();

  return (
    <svg viewBox="0 0 120 120" width="100%" height="100%" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}-body`} x1="27" y1="22" x2="88" y2="95" gradientUnits="userSpaceOnUse">
          <stop stopColor={palette.light} />
          <stop offset=".48" stopColor={palette.main} />
          <stop offset="1" stopColor={palette.dark} />
        </linearGradient>
        <linearGradient id={`${uid}-soft`} x1="37" y1="31" x2="91" y2="97" gradientUnits="userSpaceOnUse">
          <stop stopColor={white} />
          <stop offset=".3" stopColor={palette.light} />
          <stop offset="1" stopColor={palette.main} />
        </linearGradient>
        <linearGradient id={`${uid}-edge`} x1="32" y1="43" x2="73" y2="97" gradientUnits="userSpaceOnUse">
          <stop stopColor={palette.main} />
          <stop offset="1" stopColor={palette.dark} />
        </linearGradient>
      </defs>
      <path d="M21 34C37 14 82 13 99 35c19 23 10 54-10 64-24 12-58 10-72-11C6 71 9 49 21 34Z" fill={palette.mist} />
      {artwork}
    </svg>
  );
}

export function CategoryHeroArtwork() {
  const uid = useId().replace(/:/g, "");

  return (
    <svg viewBox="0 0 720 410" width="100%" height="100%" fill="none" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id={`${uid}-sun`} x1="527" y1="67" x2="527" y2="279" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFD3A1" />
          <stop offset="1" stopColor="#FFEBD6" />
        </linearGradient>
        <linearGradient id={`${uid}-mountain-back`} x1="467" y1="193" x2="501" y2="371" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F4B0A0" />
          <stop offset="1" stopColor="#FAD5C0" />
        </linearGradient>
        <linearGradient id={`${uid}-mountain-front`} x1="459" y1="247" x2="535" y2="406" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EA907F" />
          <stop offset="1" stopColor="#F5BCA6" />
        </linearGradient>
        <linearGradient id={`${uid}-film`} x1="339" y1="101" x2="573" y2="332" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFEDE1" />
          <stop offset=".52" stopColor="#FFD5BC" />
          <stop offset="1" stopColor="#F0A38A" />
        </linearGradient>
        <linearGradient id={`${uid}-screen`} x1="370" y1="171" x2="541" y2="305" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFAF3" />
          <stop offset="1" stopColor="#FFE4CE" />
        </linearGradient>
        <linearGradient id={`${uid}-play`} x1="440" y1="200" x2="504" y2="262" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F3A28D" />
          <stop offset="1" stopColor="#DE745F" />
        </linearGradient>
      </defs>
      <circle cx="531" cy="164" r="102" fill={`url(#${uid}-sun)`} />
      <circle cx="531" cy="164" r="126" stroke="#F5C1A6" strokeWidth="1" strokeDasharray="3 9" opacity=".5" />
      <path d="M203 342c62-61 88-117 122-120 31-4 39 52 75 53 44 1 67-125 107-124 37 1 60 93 87 88 31-7 52-68 78-65 27 3 34 77 68 100v136H203Z" fill={`url(#${uid}-mountain-back)`} opacity=".65" />
      <path d="M285 371c36-23 61-99 94-93 30 6 48 65 76 56 49-14 70-96 108-97 44-2 72 114 109 103 15-4 34-26 48-25v95H285Z" fill={`url(#${uid}-mountain-front)`} opacity=".7" />
      <ellipse cx="459" cy="356" rx="167" ry="21" fill="#D78068" opacity=".1" />
      <g transform="rotate(-9 451 220)">
        <rect x="337" y="135" width="232" height="183" rx="20" fill="#D88672" />
        <rect x="331" y="129" width="232" height="183" rx="20" fill={`url(#${uid}-film)`} />
        <rect x="350" y="168" width="194" height="122" rx="12" fill={`url(#${uid}-screen)`} />
        <path d="M359 270 395 229c4-4 8-4 12 0l30 29 37-42c4-4 8-4 12 0l50 54v12H359Z" fill="#F4C4AB" opacity=".6" />
        <circle cx="510" cy="197" r="10" fill="#F6C7A5" />
        <circle cx="447" cy="230" r="35" fill="#FFF6EC" opacity=".9" />
        <path d="M438 212a5 5 0 0 1 8-4l25 17a6 6 0 0 1 0 10l-25 17a5 5 0 0 1-8-4Z" fill={`url(#${uid}-play)`} />
        <g fill="#FFF3E7">
          <rect x="351" y="143" width="21" height="10" rx="3" />
          <rect x="385" y="143" width="21" height="10" rx="3" />
          <rect x="419" y="143" width="21" height="10" rx="3" />
          <rect x="453" y="143" width="21" height="10" rx="3" />
          <rect x="487" y="143" width="21" height="10" rx="3" />
          <rect x="521" y="143" width="21" height="10" rx="3" />
        </g>
      </g>
      <g transform="rotate(13 321 140)">
        <rect x="282" y="101" width="82" height="74" rx="16" fill="#E9A087" />
        <rect x="278" y="97" width="82" height="74" rx="16" fill="#FFDDC3" />
        <circle cx="319" cy="134" r="23" fill="#F0B496" />
        <circle cx="319" cy="134" r="6" fill="#FFEDDB" />
        <circle cx="319" cy="119" r="5" fill="#FFEDDB" />
        <circle cx="319" cy="149" r="5" fill="#FFEDDB" />
        <circle cx="304" cy="134" r="5" fill="#FFEDDB" />
        <circle cx="334" cy="134" r="5" fill="#FFEDDB" />
      </g>
      <path d="M603 119c-10 2-13 6-15 16-2-10-6-14-16-16 10-2 14-6 16-16 2 10 5 14 15 16Z" fill="#E6A086" />
      <path d="M276 247c-7 1-10 4-11 11-1-7-4-10-11-11 7-1 10-4 11-11 1 7 4 10 11 11Z" fill="#EDB49B" />
      <circle cx="617" cy="286" r="5" fill="#F7D1B8" />
      <circle cx="383" cy="77" r="4" fill="#ECAF92" />
      <path d="M591 334h33M607 348h51" stroke="#FFEDE0" strokeWidth="5" strokeLinecap="round" opacity=".65" />
      <path d="M477 70c9-6 17-6 25 0M500 72c7-5 13-5 20 0" stroke="#E9AF90" strokeWidth="2.5" strokeLinecap="round" opacity=".75" />
    </svg>
  );
}
