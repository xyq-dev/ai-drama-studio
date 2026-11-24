import type { EpisodeQualityReport } from "@ai-drama/contracts";
import { useRef } from "react";

const labels = {
  BLACK: "黑屏",
  SILENCE: "静音",
  NO_AUDIO: "缺少音轨",
  NO_VIDEO: "缺少视频轨",
} satisfies Record<EpisodeQualityReport["findings"][number]["code"], string>;

function timecode(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hundredths = String(Math.floor((ms % 1000) / 10)).padStart(2, "0");
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.${hundredths}`;
}

export function EpisodeQualityPlayer({ assetId, report, enabled, containsMockSources }: {
  assetId: string;
  report?: EpisodeQualityReport | null;
  enabled?: boolean | null;
  containsMockSources?: boolean | null;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const cancelled = enabled === false;
  const summary = cancelled ? "本次合成未启用质检"
    : !report ? (enabled ? "未取得质检结果" : "这份成片没有质检记录")
    : report.status === "PASS" ? "画面和音轨检查通过"
    : report.status === "FAIL" ? "发现画面或声音问题"
    : "质检未完成";

  function seek(ms: number) {
    const video = player.current;
    if (!video) return;
    const seconds = ms / 1000;
    video.focus();
    if (video.readyState === 0) {
      pendingSeek.current = seconds;
      video.load();
    } else {
      video.currentTime = seconds;
    }
  }

  return (
    <>
      <video ref={player} className="creator-composite-player" controls playsInline controlsList="nodownload"
        src={`/api/v1/assets/${assetId}/content`} aria-label="成片预览" onLoadedMetadata={() => {
          if (pendingSeek.current !== null && player.current) player.current.currentTime = pendingSeek.current;
          pendingSeek.current = null;
        }} />
      <section className="mt-2 text-sm" aria-label="成片质检">
        <p><strong>成片质检</strong> · {summary}</p>
        {containsMockSources ? <p>此成片含演示素材。</p> : null}
        {!cancelled && report?.status === "UNKNOWN" ? <p>{report.reason === "CHECK_UNAVAILABLE" ? "检测工具不可用，请播放成片核对。" : "部分检查未取得有效结果，请播放成片核对。"}</p> : null}
        {!cancelled && report && report.findings.length > 0 ? (
          <ul className="mt-1 space-y-1">
            {report.findings.map((item, index) => {
              const { startMs, endMs } = item;
              const label = labels[item.code];
              return <li key={index}>{startMs === undefined ? label : (
                <button type="button" className="min-h-11 rounded border px-2 text-left" onClick={() => seek(startMs)}
                  aria-label={`定位${label}，${timecode(startMs)}`}>
                  {label} · {timecode(startMs)}{endMs === undefined ? "" : ` – ${timecode(endMs)}`}
                </button>
              )}</li>;
            })}
          </ul>
        ) : null}
      </section>
    </>
  );
}
