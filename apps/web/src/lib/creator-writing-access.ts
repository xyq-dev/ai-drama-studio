import { useCallback, useEffect, useRef, useState } from "react";
import type { MembershipDenialCode } from "@ai-drama/domain/creator-membership";
import { ApiError, StudioClient } from "./studio-client";

const client = new StudioClient();
const messages: Record<MembershipDenialCode, string> = {
  MEMBERSHIP_REQUIRED: "还没有开通会员，请联系管理员开通。",
  MEMBERSHIP_DISABLED: "会员已停用，请联系管理员。",
  MEMBERSHIP_EXPIRED: "会员已到期，请联系管理员续期。",
  FEATURE_NOT_INCLUDED: "当前套餐不包含编剧，请联系管理员开通。",
  QUOTA_EXHAUSTED: "编剧额度已用完，请联系管理员增加额度。",
};
const unavailable = "暂时无法核对会员写作额度，请刷新后再试。";

function denialMessage(code: unknown): string | undefined {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code as MembershipDenialCode] : undefined;
}

/** Reads never reserve a unit. The task endpoint still checks and reserves atomically when it accepts a new task. */
export function useCreatorWritingAccess(required: boolean) {
  // undefined = not read yet; null = allowed. Unknown or failed responses keep project creation disabled.
  const [reason, setReason] = useState<string | null | undefined>();
  const sequence = useRef(0);
  const check = useCallback(async () => {
    if (!required) return true;
    const turn = ++sequence.current;
    let next: string | null;
    try {
      const view = await client.get<{ denial: MembershipDenialCode | null }>("/account/membership?preflight=writing");
      next = view.denial === null ? null : denialMessage(view.denial) ?? unavailable;
    } catch {
      next = unavailable;
    }
    if (turn !== sequence.current) return false;
    setReason(next);
    return next === null;
  }, [required]);

  useEffect(() => {
    if (!required) return;
    void check();
    window.addEventListener("focus", check);
    return () => { sequence.current++; window.removeEventListener("focus", check); };
  }, [required, check]);

  function recordRefusal(caught: unknown) {
    const message = caught instanceof ApiError ? denialMessage(caught.code) : undefined;
    if (!message) return false;
    sequence.current++;
    setReason(message);
    return true;
  }

  return { blocked: (required && reason === undefined) || Boolean(reason), reason, check, recordRefusal };
}
