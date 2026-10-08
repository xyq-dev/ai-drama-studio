import styles from "./creator-entry.module.css";

/** A typographic placeholder: project data has no cover asset, so this never presents generated media. */
export function CreatorCover({ title }: { title: string }) {
  const tone = Array.from(title).reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 3;
  return (
    <div className={styles.cover} data-tone={tone} aria-hidden="true">
      <span className={styles.coverLabel}>文字封面</span>
      <span className={styles.coverArch} />
      <span className={styles.coverOrb} />
      <span className={styles.coverTitle}>{title || "我的故事"}</span>
      <span className={styles.coverCaption}>把故事，做成短剧</span>
    </div>
  );
}
