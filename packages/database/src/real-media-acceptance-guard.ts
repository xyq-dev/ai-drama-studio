import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase,
  type DisposableAcceptanceDecision, type DisposableReadOnlyQueryable } from "./disposable-acceptance-guard";

export const REAL_MEDIA_ACCEPTANCE_NAME_PATTERN = /^ads_media_acceptance_[a-z0-9_]{6,40}$/;
export interface RealMediaAcceptanceEnv {
  REAL_MEDIA_ACCEPTANCE_AUTHORIZED?:string;REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED?:string;
  REAL_MEDIA_ACCEPTANCE_DATABASE_NAME?:string;REAL_MEDIA_ACCEPTANCE_DATABASE_URL?:string;DATABASE_URL?:string;
}
/** Pure refusal-by-default guard. It never falls back to the business DATABASE_URL. */
export function checkRealMediaAcceptanceEnv(env:RealMediaAcceptanceEnv):DisposableAcceptanceDecision{
  if(env.REAL_MEDIA_ACCEPTANCE_AUTHORIZED!=="true"||env.REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED!=="true")return {ok:false,reason:"Both real-media acceptance and draft authorization flags are required"};
  return checkDisposableAcceptanceEnv({databaseName:env.REAL_MEDIA_ACCEPTANCE_DATABASE_NAME,url:env.REAL_MEDIA_ACCEPTANCE_DATABASE_URL,
    businessDatabaseUrl:env.DATABASE_URL,namePattern:REAL_MEDIA_ACCEPTANCE_NAME_PATTERN,nameHint:"ads_media_acceptance_<6-40 of a-z 0-9 _>"});
}
export function verifyRealMediaAcceptanceDatabase(client:DisposableReadOnlyQueryable,expectedName:string):Promise<DisposableAcceptanceDecision>{
  return verifyDisposableAcceptanceDatabase(client,expectedName,REAL_MEDIA_ACCEPTANCE_NAME_PATTERN);
}
