"use client";

import { useId, useState, type KeyboardEvent } from "react";
import type { TitleWritingProviderKey } from "@ai-drama/contracts";
import { MODEL_CANDIDATES, candidateFor } from "../lib/admin-model-catalog";
import styles from "./admin-models.module.css";

export const MAX_MODELS = 10;
const MODEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The model part of a provider draft. The API takes one ordered `models` array and uses its first entry as the
 * provider's default, so the default is kept here separately and only becomes the first entry when saving.
 * `custom` keeps IDs outside the candidate list visible (saved ones and ones added by hand) even while unselected.
 * `pendingCustom` is a custom ID typed but not yet added: it belongs to the provider's draft, so switching providers
 * keeps it and reading the server config clears it, like the rest of the draft. It is never sent.
 */
export type ModelDraft = { models: string[]; defaultModel: string; custom: string[]; pendingCustom: string };

export function modelDraftFor(providerKey: TitleWritingProviderKey, models: readonly string[]): ModelDraft {
  return { models: [...models], defaultModel: models[0] ?? "",
    custom: models.filter((id) => !candidateFor(providerKey, id)), pendingCustom: "" };
}
/** The array the existing save contract expects: the default first, the rest in the order they were chosen. */
export function orderedModels(draft: ModelDraft): string[] {
  if (!draft.defaultModel || !draft.models.includes(draft.defaultModel)) return [...draft.models];
  return [draft.defaultModel, ...draft.models.filter((id) => id !== draft.defaultModel)];
}
/**
 * What this provider's draft lacks before it can be saved, or "" when it is complete. Only the provider being saved is
 * checked; the others may stay unconfigured. An empty list is allowed while clearing the key, which is how a provider
 * is cleared (the contract accepts `secretAction: "clear"` with `models: []`).
 */
export function modelProblem(draft: ModelDraft, clearing = false): string {
  if (draft.models.length === 0) return clearing ? "" : "请选择至少一个模型。";
  if (!draft.defaultModel || !draft.models.includes(draft.defaultModel)) return "请从已选的可用模型中选择默认模型。";
  return "";
}

type Option = { id: string; name: string; note: string; custom: boolean };

export function ModelPicker({ providerKey, draft, showProblem, clearing, onChange }: {
  providerKey: TitleWritingProviderKey;
  draft: ModelDraft;
  showProblem: boolean;
  clearing: boolean;
  onChange: (next: ModelDraft) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [customError, setCustomError] = useState("");
  const [defaultCleared, setDefaultCleared] = useState(false);
  const options: Option[] = [
    ...MODEL_CANDIDATES[providerKey].map((candidate) => ({ ...candidate, custom: false })),
    ...draft.custom.map((custom) => ({ id: custom, name: custom, note: "不在候选列表中，按填写的 ID 原样保存", custom: true })),
  ];
  const needle = query.trim().toLowerCase();
  const visible = needle ? options.filter((option) => `${option.name} ${option.id} ${option.note}`.toLowerCase().includes(needle)) : options;
  const full = draft.models.length >= MAX_MODELS;
  const problem = modelProblem(draft, clearing);
  const label = (model: string) => {
    const candidate = candidateFor(providerKey, model);
    return candidate ? `${candidate.name} · ${model}` : `${model}（自定义模型）`;
  };

  function toggle(model: string, checked: boolean) {
    if (checked) {
      if (draft.models.includes(model) || full) return;
      onChange({ ...draft, models: [...draft.models, model] });
      return;
    }
    const removingDefault = model === draft.defaultModel;
    // Removing the default never promotes another model silently: the administrator picks the new one.
    onChange({ ...draft, models: draft.models.filter((item) => item !== model), defaultModel: removingDefault ? "" : draft.defaultModel });
    if (removingDefault) setDefaultCleared(true);
  }
  function chooseDefault(model: string) {
    onChange({ ...draft, defaultModel: model });
    if (model) setDefaultCleared(false);
  }
  function addCustom() {
    const value = draft.pendingCustom.trim();
    if (!MODEL_ID.test(value)) { setCustomError("模型 ID 只能包含字母、数字和 . _ : -，最长 128 个字符。"); return; }
    const known = options.some((option) => option.id === value);
    if (draft.models.includes(value)) { setCustomError("该模型已在可用模型中。"); return; }
    if (full) { setCustomError(`最多选择 ${MAX_MODELS} 个模型，请先取消一个再添加。`); return; }
    onChange({ ...draft, models: [...draft.models, value], custom: known ? draft.custom : [...draft.custom, value], pendingCustom: "" });
    setCustomError("");
  }
  function onCustomKey(event: KeyboardEvent<HTMLInputElement>) {
    // Enter adds the ID instead of submitting the whole provider form.
    if (event.key === "Enter") { event.preventDefault(); addCustom(); }
  }
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    // Enter in the search box only filters; it must never submit the provider form (and with it the key action).
    if (event.key === "Enter") event.preventDefault();
  }

  return <div className={styles.picker}>
    <div className={styles.field} role="group" aria-labelledby={`${id}-label`}
      aria-describedby={draft.models.length ? `${id}-help` : `${id}-help ${id}-problem`}>
      <span id={`${id}-label`}>可用模型</span>
      <div className={styles.pickerBox}>
        <input type="search" aria-label="搜索可用模型" aria-controls={`${id}-list`} placeholder="按名称或 ID 搜索" value={query}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKey} spellCheck={false} autoComplete="off" maxLength={128} />
        <ul id={`${id}-list`} className={styles.pickerList} aria-label="候选模型">
          {visible.map((option) => {
            const checked = draft.models.includes(option.id);
            return <li key={option.id}><label className={`${styles.pickerOption} ${checked ? styles.pickerChecked : ""}`}>
              <input type="checkbox" checked={checked} disabled={!checked && full} onChange={(event) => toggle(option.id, event.target.checked)} />
              <span className={styles.pickerText}><strong>{option.name}{option.custom && <span className={styles.customTag}>自定义模型</span>}{option.id === draft.defaultModel && checked && <span className={styles.defaultTag}>默认</span>}</strong>
                {!option.custom && <code>{option.id}</code>}<small>{option.note}</small></span>
            </label></li>;
          })}
          {visible.length === 0 && <li className={styles.pickerEmpty}>没有匹配的候选模型。可在下方“高级设置”中添加自定义模型 ID。</li>}
        </ul>
      </div>
      <small id={`${id}-help`}>已选 {draft.models.length} / {MAX_MODELS}。候选仅供选择，不代表账户已开通或已经真实调用验证。</small>
      {draft.models.length === 0 && (clearing
        ? <small id={`${id}-problem`}>未选择模型：保存后将清空该供应商的模型列表并清除密钥。</small>
        : <small className={showProblem ? styles.fieldError : undefined} id={`${id}-problem`} role={showProblem ? "alert" : undefined}>请选择至少一个模型。如需清空该供应商的配置，请同时选择“清除密钥”。</small>)}
    </div>
    <label className={styles.field}>默认模型
      <select value={draft.models.includes(draft.defaultModel) ? draft.defaultModel : ""} onChange={(event) => chooseDefault(event.target.value)}
        disabled={draft.models.length === 0} aria-invalid={showProblem && !!problem && draft.models.length > 0}>
        <option value="">{draft.models.length ? "请选择默认模型" : "请先选择可用模型"}</option>
        {draft.models.map((model) => <option key={model} value={model}>{label(model)}</option>)}
      </select>
      {draft.models.length > 0 && problem
        ? <small className={showProblem || defaultCleared ? styles.fieldError : undefined} role={showProblem ? "alert" : undefined}>
          {defaultCleared ? "原默认模型已取消选择，请从已选模型中重新选择默认模型。" : "请从已选的可用模型中选择默认模型。"}</small>
        : <small>创作者未指定模型时使用该模型。保存时排在模型列表第一位。</small>}
    </label>
    <details className={styles.advanced}>
      <summary>高级设置</summary>
      <div className={styles.customRow}>
        <label className={styles.field}>添加自定义模型 ID
          <input type="text" value={draft.pendingCustom} onChange={(event) => { onChange({ ...draft, pendingCustom: event.target.value }); setCustomError(""); }} onKeyDown={onCustomKey}
            placeholder="例如账户中已开通的其他模型 ID" spellCheck={false} autoComplete="off" maxLength={128} aria-invalid={!!customError} />
          {customError ? <small className={styles.fieldError} role="alert">{customError}</small>
            : <small>仅在候选列表中没有需要的模型时使用。请填写供应商控制台中的准确 ID，不会自动校验是否可用。</small>}
        </label>
        <button type="button" className={styles.secondary} onClick={addCustom} disabled={!draft.pendingCustom.trim()}>添加</button>
      </div>
    </details>
  </div>;
}
