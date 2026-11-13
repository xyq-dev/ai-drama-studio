"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styles from "./hover-media-preview.module.css";

const OPEN_PREVIEW_EVENT = "hongguo:media-preview-open";

interface PreviewProps {
  kind: "image" | "video";
  src: string;
  label: string;
  poster?: string;
}

interface Position { left: number; top: number; width: number; height: number }

function previewPosition(anchor: DOMRect): Position {
  const inset = 12;
  const width = Math.min(520, window.innerWidth - inset * 2);
  const height = Math.min(Math.round(width * 0.67) + 44, window.innerHeight - inset * 2);
  const right = anchor.right + 8;
  const left = right + width <= window.innerWidth - inset ? right : Math.max(inset, anchor.left - width - 8);
  return { left, top: Math.max(inset, Math.min(anchor.top, window.innerHeight - height - inset)), width, height };
}

/** Hover is temporary. Click or keyboard activation holds the same preview open for touch or closer inspection. */
export function HoverMediaPreview(props: PreviewProps) {
  return <PreviewTile key={props.src} {...props} />;
}

function PreviewTile({ kind, src, label, poster }: PreviewProps) {
  const [position, setPosition] = useState<Position | null>(null);
  const [held, setHeld] = useState(false);
  const [failed, setFailed] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const openDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const shown = position !== null;
  const thumbnail = kind === "image" ? src : poster;

  function clearTimers() {
    if (openDelay.current !== null) clearTimeout(openDelay.current);
    if (closeDelay.current !== null) clearTimeout(closeDelay.current);
    openDelay.current = closeDelay.current = null;
  }

  function show() {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    document.dispatchEvent(new CustomEvent(OPEN_PREVIEW_EVENT, { detail: id }));
    setFailed(false);
    setPosition(previewPosition(rect));
  }

  function leave() {
    clearTimers();
    if (!held) closeDelay.current = setTimeout(() => setPosition(null), 160);
  }

  useEffect(() => clearTimers, []);
  useEffect(() => {
    if (held) closeButton.current?.focus();
  }, [held]);
  useEffect(() => {
    if (!shown) return;
    function close(restoreFocus = false) {
      clearTimers();
      setPosition(null);
      setHeld(false);
      if (restoreFocus) anchor.current?.focus();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(held);
    }
    function pointer(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && (anchor.current?.contains(target) || popup.current?.contains(target))) return;
      close();
    }
    function reposition(event: Event) {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      if (!held) { close(); return; }
      const rect = anchor.current?.getBoundingClientRect();
      if (rect) setPosition(previewPosition(rect));
    }
    function replace(event: Event) {
      if (event instanceof CustomEvent && event.detail !== id) close();
    }
    document.addEventListener(OPEN_PREVIEW_EVENT, replace);
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", pointer);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener(OPEN_PREVIEW_EVENT, replace);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", pointer);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [held, id, shown]);

  return <>
    <button ref={anchor} type="button" className={styles.tile} aria-label={label} aria-expanded={shown}
      aria-haspopup="dialog" aria-controls={shown ? id : undefined}
      onPointerEnter={event => {
        if (event.pointerType !== "mouse") return;
        clearTimers();
        if (!shown) openDelay.current = setTimeout(show, 170);
      }} onPointerLeave={leave} onClick={() => {
        clearTimers();
        if (held) { setHeld(false); setPosition(null); return; }
        if (!shown) show();
        setHeld(true);
      }}>
      {thumbnail && !thumbnailFailed ? <img alt="" loading="lazy" src={thumbnail} onError={() => setThumbnailFailed(true)} />
        : <span className={styles.placeholder} aria-hidden="true">{kind === "video" ? "视频" : "图片"}</span>}
      {kind === "video" ? <span className={styles.play} aria-hidden="true">▶</span> : null}
    </button>
    {position && createPortal(<div ref={popup} role="dialog" aria-label={label} id={id} className={styles.popup}
      style={position} onPointerEnter={clearTimers} onPointerLeave={leave}>
      <header className={styles.bar}>
        <span>{kind === "video" ? "视频预览" : "图片预览"}</span>
        <button ref={closeButton} type="button" onClick={() => {
          clearTimers(); setHeld(false); setPosition(null); anchor.current?.focus();
        }} aria-label="关闭预览">×</button>
      </header>
      {failed ? <p className={styles.failure} role="alert">素材暂时无法预览</p>
        : kind === "image" ? <img alt={label} src={src} onError={() => setFailed(true)} />
          : <video aria-label={label} src={src} poster={poster} muted autoPlay playsInline controls onError={() => setFailed(true)} />}
    </div>, document.body)}
  </>;
}
