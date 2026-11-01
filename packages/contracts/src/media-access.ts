/** Non-secret readiness check shared by process bootstrap code. No password verification or credential is returned. */
export function mediaSiteAuthenticationConfigured(environment:Record<string,string|undefined>,nodeEnv:string):boolean{
  if(environment.SITE_AUTH_ENABLED!=="true"||!/^[A-Za-z0-9._-]{1,64}$/.test(environment.SITE_AUTH_USERNAME||"admin"))return false;
  const match=/^scrypt\$(\d{2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,88})\$([A-Za-z0-9_-]{43,88})$/.exec(environment.SITE_AUTH_PASSWORD_HASH??"");
  if(!match)return false;
  const n=Number(match[1]),r=Number(match[2]),p=Number(match[3]);
  if(n<15||n>20||r<8||r>16||p<1||p>4||128*r*2**n*p>256*1024*1024||Math.floor(match[4]!.length*3/4)<16||Math.floor(match[5]!.length*3/4)<32)return false;
  try{
    const origin=new URL(environment.SITE_AUTH_PUBLIC_ORIGIN??"");
    const loopback=["localhost","127.0.0.1","[::1]"].includes(origin.hostname);
    return origin.origin===environment.SITE_AUTH_PUBLIC_ORIGIN&&!origin.username&&!origin.password
      &&(origin.protocol==="https:"||(nodeEnv!=="production"&&origin.protocol==="http:"&&loopback));
  }catch{return false;}
}
export function realMediaAccessAllowed(input:{nodeEnv:string;siteAuthConfigured:boolean;allowProduction:boolean}):boolean{
  return input.siteAuthConfigured&&(input.nodeEnv!=="production"||input.allowProduction);
}
/** Feature switches only. Asset receipt, checksum and scope validation stay in Core and the object reader. */
export function composeSourcesAllowed(sources:unknown,flags:{allowReal:boolean;allowMockAv:boolean;allowMockSm:boolean}):boolean{
  if(!Array.isArray(sources)||sources.length===0||!sources.some(value=>value&&typeof value==="object"&&value.role==="video"))return false;
  return sources.every(value=>{
    if(!value||typeof value!=="object")return false;
    const {role,storageProvider}=value as {role?:unknown;storageProvider?:unknown};
    if(typeof role!=="string")return false;
    if(storageProvider==="s3")return flags.allowReal&&["video","audio","music"].includes(role);
    if(storageProvider==="mock-object-store")return ["video","audio"].includes(role)?flags.allowMockAv:["subtitle","music"].includes(role)&&flags.allowMockSm;
    return false;
  });
}
