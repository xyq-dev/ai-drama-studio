import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase,
  type DisposableAcceptanceDecision, type DisposableReadOnlyQueryable } from "./disposable-acceptance-guard";

/** Retains the reviewed title-acceptance environment contract without modifying legacy title suites. */
export const VIMAX_PLANNING_ACCEPTANCE_NAME_PATTERN = /^ads_title_acceptance_[a-z0-9_]{6,40}$/;
export interface VimaxPlanningAcceptanceEnv {
  TITLE_WRITING_ACCEPTANCE_AUTHORIZED?:string;
  TITLE_WRITING_ACCEPTANCE_DATABASE_NAME?:string;
  TITLE_WRITING_ACCEPTANCE_DATABASE_URL?:string;
  VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED?:string;
  VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED?:string;
  DATABASE_URL?:string;
}
/** All three explicit flags precede URL admission and Pool construction. No business DATABASE_URL fallback. */
export function checkVimaxPlanningAcceptanceEnv(env:VimaxPlanningAcceptanceEnv):DisposableAcceptanceDecision {
  if(env.TITLE_WRITING_ACCEPTANCE_AUTHORIZED!=="true"||env.VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED!=="true"
    ||env.VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED!=="true") {
    return {ok:false,reason:"TITLE_WRITING_ACCEPTANCE_AUTHORIZED, VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED and VIMAX_PLANNING_ACCEPTANCE_DRAFT_AUTHORIZED must all be exactly true."};
  }
  return checkDisposableAcceptanceEnv({databaseName:env.TITLE_WRITING_ACCEPTANCE_DATABASE_NAME,url:env.TITLE_WRITING_ACCEPTANCE_DATABASE_URL,
    businessDatabaseUrl:env.DATABASE_URL,namePattern:VIMAX_PLANNING_ACCEPTANCE_NAME_PATTERN,nameHint:"ads_title_acceptance_<6-40 of a-z 0-9 _>"});
}
export function verifyVimaxPlanningAcceptanceDatabase(client:DisposableReadOnlyQueryable,expectedName:string):Promise<DisposableAcceptanceDecision> {
  return verifyDisposableAcceptanceDatabase(client,expectedName,VIMAX_PLANNING_ACCEPTANCE_NAME_PATTERN);
}
