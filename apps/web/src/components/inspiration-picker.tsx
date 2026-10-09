"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORIES, TAGS, type Category, type DirectionDraft } from "../lib/creative-taxonomy";
import { CategoryArtwork } from "./category-artwork";
import styles from "./inspiration-picker.module.css";

/** Cards shown before "查看更多方向". */
const FIRST_CARDS = 4;

/** applied: this page added the block; present: the idea already had it as the user's own text. */
export type DirectionState = "applied" | "present" | "pending" | "edited";

interface Props {
  selected: DirectionDraft | null;
  state: DirectionState | null;
  /** True while a create is in flight: viewing stays possible, nothing may change the draft. */
  frozen: boolean;
  note: string | null;
  /** Offered when the applied text was edited: append the new direction and leave the old text as it is. */
  keepAndAppend: DirectionDraft | null;
  onUse: (direction: DirectionDraft, keepOld?: boolean) => void;
  onRemove: () => void;
}

function categoryName(id: string | null): string {
  return CATEGORIES.find((item) => item.id === id)?.name ?? "未选择";
}

function tagNames(ids: readonly string[]): string[] {
  return TAGS.filter((tag) => ids.includes(tag.id)).map((tag) => tag.name);
}

const STATE_TEXT: Record<DirectionState, string> = {
  applied: "已加在「故事想法」末尾",
  present: "想法里已有这段方向文字（你写的，移除时不会删除）",
  pending: "还没有加入想法，点「用这个方向」才会加入",
  edited: "方向文字已被你修改，页面不会再自动改动它",
};

/**
 * "还没想法？选一个故事方向": the inspiration centre's categories, tags and descriptions inside /create. Looking,
 * expanding and opening a card change nothing; only "用这个方向" hands a direction to the page, which owns the draft.
 * Nothing here calls the API or a model.
 */
export function InspirationPicker({ selected, state, frozen, note, keepAndAppend, onUse, onRemove }: Props) {
  const [expanded, setExpanded] = useState(() => CATEGORIES.findIndex((item) => item.id === selected?.categoryId) >= FIRST_CARDS);
  const [open, setOpen] = useState<Category | null>(null);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const firstCard = useRef<HTMLButtonElement>(null);
  const focusDetail = useRef(false);

  useEffect(() => {
    if (open && focusDetail.current) {
      focusDetail.current = false;
      detailHeading.current?.focus();
    }
  }, [open]);

  function show(category: Category, button: HTMLButtonElement) {
    opener.current = button;
    focusDetail.current = true;
    // The chosen direction keeps its own tags; another category starts from its recommended ones.
    setTagIds(selected?.categoryId === category.id ? [...selected.tagIds] : [...category.recommended]);
    setOpen(category);
  }

  function back() {
    setOpen(null);
    opener.current?.focus();
  }

  function change() {
    setExpanded(true);
    firstCard.current?.focus();
  }

  const cards = expanded ? CATEGORIES : CATEGORIES.slice(0, FIRST_CARDS);
  const detailTags = open ? [...new Set<string>([...open.recommended, ...(selected?.categoryId === open.id ? selected.tagIds : [])])] : [];
  const sameAsSelected = !!open && selected?.categoryId === open.id
    && selected.tagIds.length === tagIds.length && tagIds.every((id) => selected.tagIds.includes(id));

  return (
    <section id="inspiration" className={styles.panel} aria-labelledby="inspiration-title">
      <div className={styles.heading}>
        <h2 id="inspiration-title" tabIndex={-1}>还没想法？选一个故事方向</h2>
        <p>方向会加在上方「故事想法」末尾，你已写的剧名和内容都会保留。选方向不会创建作品，也不会调用 AI；「AI 一键创作」只使用剧名。</p>
      </div>

      {selected ? (
        <div className={styles.selected} role="group" aria-labelledby="selected-direction-title">
          <span className={styles.selectedArt}><CategoryArtwork id={selected.categoryId ?? ""} /></span>
          <div className={styles.selectedBody}>
            <p id="selected-direction-title" className={styles.selectedLabel}>已选方向</p>
            <p className={styles.selectedName}>{categoryName(selected.categoryId)}</p>
            {selected.tagIds.length ? <p className={styles.selectedTags}>{tagNames(selected.tagIds).join(" · ")}</p> : null}
            {state ? <p className={styles.selectedState} data-state={state}>{STATE_TEXT[state]}</p> : null}
          </div>
          <div className={styles.selectedActions}>
            {state === "pending" ? (
              <button className="ui-button ui-button-primary" type="button" disabled={frozen} onClick={() => onUse(selected)}>用这个方向</button>
            ) : null}
            <a className={styles.textButton} href="#idea">回到故事想法</a>
            <button className="ui-button ui-button-secondary" type="button" disabled={frozen} onClick={change}>更换方向</button>
            <button className={styles.textButton} type="button" disabled={frozen} onClick={onRemove}>移除方向</button>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className={styles.note} role="status">
          <p>{note}</p>
          {keepAndAppend ? (
            <button className="ui-button ui-button-secondary" type="button" disabled={frozen} onClick={() => onUse(keepAndAppend, true)}>
              保留原文字，另外加入「{categoryName(keepAndAppend.categoryId)}」
            </button>
          ) : null}
        </div>
      ) : null}

      <ul id="inspiration-cards" className={styles.cards} aria-label="故事方向">
        {cards.map((category, index) => {
          const chosen = selected?.categoryId === category.id;
          return (
            <li key={category.id}>
              <button ref={index === 0 ? firstCard : undefined} type="button" className={styles.card}
                data-selected={chosen || undefined} data-open={open?.id === category.id || undefined}
                aria-expanded={open?.id === category.id} aria-controls="inspiration-detail"
                onClick={(event) => show(category, event.currentTarget)}>
                <span className={styles.cardArt}><CategoryArtwork id={category.id} /></span>
                <span className={styles.cardText}>
                  <strong>{category.name}</strong>
                  <small>{category.description}</small>
                </span>
                {chosen ? <span className={styles.badge}>已选</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <button className={styles.more} type="button" aria-expanded={expanded} aria-controls="inspiration-cards"
        onClick={() => setExpanded(!expanded)}>
        {expanded ? "收起方向" : `查看更多方向（共 ${CATEGORIES.length} 个）`}
      </button>

      {open ? (
        <div id="inspiration-detail" className={styles.detail} role="region" aria-labelledby="inspiration-detail-title">
          <div className={styles.detailHead}>
            <span className={styles.detailArt}><CategoryArtwork id={open.id} /></span>
            <div>
              <p className={styles.eyebrow}>方向说明</p>
              <h3 id="inspiration-detail-title" ref={detailHeading} tabIndex={-1}>{open.name}</h3>
            </div>
          </div>
          <p className={styles.description}>{open.description}</p>
          <div className={styles.prompt}><strong>从这个问题开始</strong><p>{open.prompt}</p></div>
          <fieldset className={styles.tags}>
            <legend>可以搭配的标签（可取消）</legend>
            <div>
              {detailTags.map((id) => {
                const on = tagIds.includes(id);
                return (
                  <button key={id} type="button" aria-pressed={on} disabled={frozen}
                    onClick={() => setTagIds(on ? tagIds.filter((tag) => tag !== id) : [...tagIds, id])}>
                    <span aria-hidden="true">{on ? "✓" : "＋"}</span>{TAGS.find((tag) => tag.id === id)?.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className={styles.detailActions}>
            <button className="ui-button ui-button-primary" type="button" disabled={frozen}
              onClick={() => onUse({ version: 1, categoryId: open.id, tagIds: TAGS.map((tag) => tag.id).filter((id) => tagIds.includes(id)) })}>
              {sameAsSelected && state === "applied" ? "已在使用这个方向" : "用这个方向"}
            </button>
            <button className="ui-button ui-button-secondary" type="button" onClick={back}>收起说明</button>
          </div>
          {frozen ? <p className={styles.frozen} role="status">正在创建作品，内容已锁定，可以查看方向，但现在不能更换。</p> : null}
        </div>
      ) : null}
    </section>
  );
}
