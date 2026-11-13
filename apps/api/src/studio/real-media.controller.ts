import { Body,Controller,Get,Headers,Inject,Param,Post,Put,Res,StreamableFile } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import type { RealMediaService } from "./real-media.service";
import { createTraceId } from "./studio.service";
export const REAL_MEDIA_SERVICE=Symbol("REAL_MEDIA_SERVICE");
const uuid={transform(value:string){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new PersistenceError("VALIDATION_ERROR","Invalid route id");return value.toLowerCase();}};
interface Response { status(code:number):void;setHeader(key:string,value:string):void }
@Controller()
export class RealMediaController {
  constructor(@Inject(REAL_MEDIA_SERVICE) private readonly media:RealMediaService){}
  @Get("projects/:projectId/real-media/capabilities")
  capabilities(@Param("projectId",uuid) projectId:string){return this.media.capabilities(projectId);}
  @Get("projects/:projectId/real-media/cost-exposure")
  exposure(@Param("projectId",uuid) projectId:string){return this.media.costExposure(projectId);}
  @Post("projects/:projectId/shot-revisions/:shotRevisionId/real-media/quote")
  quote(@Param("projectId",uuid) projectId:string,@Param("shotRevisionId",uuid) shotRevisionId:string,@Body() body:unknown){return this.media.quote(projectId,shotRevisionId,body);}
  @Get("projects/:projectId/shot-revisions/:shotRevisionId/real-media/comfyui")
  comfyUiShot(@Param("projectId",uuid) projectId:string,@Param("shotRevisionId",uuid) shotRevisionId:string,@Res({passthrough:true}) response:Response){
    response.setHeader("Cache-Control","private, no-store");
    return this.media.comfyUiShot(projectId,shotRevisionId);
  }
  @Put("projects/:projectId/shot-revisions/:shotRevisionId/real-media/comfyui")
  selectComfyUiImage(@Param("projectId",uuid) projectId:string,@Param("shotRevisionId",uuid) shotRevisionId:string,@Body() body:unknown){
    return this.media.selectComfyUiImage(projectId,shotRevisionId,body);
  }
  @Post("projects/:projectId/real-media/authorize")
  authorize(@Param("projectId",uuid) projectId:string,@Body() body:unknown){return this.media.authorize(projectId,body);}
  @Post("projects/:projectId/shot-revisions/:shotRevisionId/real-media/generate")
  async generate(@Param("projectId",uuid) projectId:string,@Param("shotRevisionId",uuid) shotRevisionId:string,@Body() body:unknown,
    @Headers("idempotency-key") key:string|undefined,@Headers("x-trace-id") trace:string|undefined,@Res({passthrough:true}) response:Response){
    const result=await this.media.generate(projectId,shotRevisionId,body,{actorId:"server-owner",traceId:createTraceId(trace),idempotencyKey:key});
    response.status(result.status);response.setHeader("Cache-Control","private, no-store");return result.body;
  }
  @Get("real-media/assets/:assetId/content")
  async content(@Param("assetId",uuid) assetId:string,@Res({passthrough:true}) response:Response){
    const result=await this.media.readAssetContent(assetId);response.setHeader("Content-Type",result.mimeType);
    response.setHeader("Cache-Control","private, no-store");response.setHeader("X-Content-Type-Options","nosniff");
    return new StreamableFile(result.bytes);
  }
}
