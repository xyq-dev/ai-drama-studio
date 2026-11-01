export interface RealMediaAcceptanceEnv {
  REAL_MEDIA_ACCEPTANCE_AUTHORIZED?:string;REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED?:string;
  REAL_MEDIA_ACCEPTANCE_DATABASE_NAME?:string;REAL_MEDIA_ACCEPTANCE_DATABASE_URL?:string;DATABASE_URL?:string;
}
/** Pure refusal-by-default guard. It never falls back to the business DATABASE_URL. */
export function checkRealMediaAcceptanceEnv(env:RealMediaAcceptanceEnv):{ok:true;url:string;databaseName:string}|{ok:false;reason:string}{
  if(env.REAL_MEDIA_ACCEPTANCE_AUTHORIZED!=="true"||env.REAL_MEDIA_ACCEPTANCE_DRAFT_AUTHORIZED!=="true")return {ok:false,reason:"Both real-media acceptance and draft authorization flags are required"};
  const databaseName=env.REAL_MEDIA_ACCEPTANCE_DATABASE_NAME;
  if(!databaseName||!/^ads_media_acceptance_[a-z0-9_]{6,40}$/.test(databaseName))return {ok:false,reason:"Name a new disposable ads_media_acceptance database"};
  const url=env.REAL_MEDIA_ACCEPTANCE_DATABASE_URL;
  const name=(value:string)=>{try{const parsed=new URL(value);return ["postgres:","postgresql:"].includes(parsed.protocol)?decodeURIComponent(parsed.pathname.slice(1)):null;}catch{return null;}};
  if(!url||name(url)!==databaseName)return {ok:false,reason:"The dedicated acceptance URL must name the exact disposable database"};
  if(env.DATABASE_URL&&(env.DATABASE_URL===url||name(env.DATABASE_URL)===databaseName))return {ok:false,reason:"The business database cannot be used for acceptance"};
  return {ok:true,url,databaseName};
}
