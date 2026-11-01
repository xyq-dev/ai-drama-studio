import { PersistenceError } from "@ai-drama/database";
import { composeSourcesAllowed } from "@ai-drama/contracts";
export function assertComposeSourcesEnabled(sources:readonly {role:string;storageProvider:string}[],flags:{real:boolean;mockAv:boolean;mockSm:boolean}):void{
  if(!sources.length||!sources.some(source=>source.role==="video"))throw new PersistenceError("COMPOSE_INPUT_INVALID","Compose requires a video source");
  if(!composeSourcesAllowed(sources,{allowReal:flags.real,allowMockAv:flags.mockAv,allowMockSm:flags.mockSm}))throw new PersistenceError("CONFIGURATION_ERROR","The selected compose source is not enabled");
}
