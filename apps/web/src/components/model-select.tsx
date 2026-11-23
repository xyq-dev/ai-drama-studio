import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./model-select.module.css";

interface Props {
  label: string;
  value: string;
  options: readonly { id: string; label: string }[];
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function ModelSelect({ label, value, options, onChange, disabled }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const selected = options.find((option) => option.id === value);
  const needle = query.trim().toLowerCase();
  const visible = options.filter((option) =>
    `${option.label} ${option.id}`.toLowerCase().includes(needle),
  );

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) list.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }, [open, index, query]);

  function show() {
    setQuery("");
    setIndex(
      Math.max(
        0,
        options.findIndex((item) => item.id === value),
      ),
    );
    setOpen(true);
  }
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  function choose(id: string) {
    onChange(id);
    close();
  }
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setIndex(Math.max(0, Math.min(visible.length - 1, index + delta)));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visible[index]) choose(visible[index].id);
    }
  }

  return (
    <div
      className={styles.field}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <span id={id + "-label"}>{label}</span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-labelledby={id + "-label"}
        aria-controls={id + "-options"}
        aria-expanded={open}
        aria-describedby={value ? id + "-detail" : undefined}
        className={styles.trigger}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show();
          }
        }}
        onClick={open ? close : show}
      >
        <span>{selected?.label ?? (value || "请选择模型")}</span>
        <span aria-hidden="true" className={styles.chevron} />
      </button>
      {value && (
        <small id={id + "-detail"} className={styles.detail}>
          {selected ? value : "当前列表不可用"}
        </small>
      )}
      {open && (
        <div className={styles.popup}>
          <input
            ref={search}
            type="search"
            aria-label="搜索模型"
            placeholder="搜索模型名称或 ID"
            value={query}
            aria-controls={id + "-options"}
            aria-activedescendant={visible[index] ? id + "-option-" + index : undefined}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={keyDown}
          />
          <ul ref={list} id={id + "-options"} role="listbox" aria-label={label}>
            {visible.map((option, position) => (
              <li
                key={option.id}
                id={id + "-option-" + position}
                role="option"
                aria-selected={option.id === value}
                data-highlight={position === index}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.id)}
              >
                {option.label}
              </li>
            ))}
          </ul>
          {!visible.length && (
            <p role="status">{query ? "没有匹配的模型" : "当前渠道暂无可选模型"}</p>
          )}
        </div>
      )}
    </div>
  );
}
