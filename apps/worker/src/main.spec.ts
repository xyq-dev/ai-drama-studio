import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const bootstrap=vi.hoisted(()=>({loadEnv:vi.fn(),startRuntime:vi.fn(),createApp:vi.fn()}));
vi.mock("./config/env",async importOriginal=>({...await importOriginal<typeof import("./config/env")>(),loadWorkerEnv:bootstrap.loadEnv}));
vi.mock("./config/env-file",()=>({findRepoRoot:()=>"/repo",readEnvFile:()=>({})}));
vi.mock("./runtime/start-runtime",()=>({startQueueRuntime:bootstrap.startRuntime}));
vi.mock("./app.module",()=>({AppModule:{register:()=>({})}}));
vi.mock("@nestjs/core",()=>({NestFactory:{create:bootstrap.createApp}}));
vi.mock("@nestjs/common",async importOriginal=>({...await importOriginal<typeof import("@nestjs/common")>(),Logger:class{log(){} }}));
vi.mock("@ai-drama/providers",()=>({ServerRealMediaRuntime:class{readonly receiptCipher={};}}));

const beforeSignals=new Map<string,Set<unknown>>();
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();for(const signal of ["SIGTERM","SIGINT"])beforeSignals.set(signal,new Set(process.listeners(signal)));});
afterEach(()=>{for(const signal of ["SIGTERM","SIGINT"])for(const listener of process.listeners(signal))if(!beforeSignals.get(signal)?.has(listener))process.removeListener(signal,listener);});

describe("worker main compose options",()=>{
  it.each([
    {nodeEnv:"test",authorized:false,episode:true},
    {nodeEnv:"production",authorized:false,episode:false},
    {nodeEnv:"production",authorized:true,episode:true},
  ])("boots $nodeEnv episode composition independently of shot/Mock generation (authorized=$authorized)",async({nodeEnv,authorized,episode})=>{
    bootstrap.loadEnv.mockReturnValue({NODE_ENV:nodeEnv,DATABASE_URL:"postgresql://unused",REDIS_URL:"redis://unused",BIND_HOST:"127.0.0.1",WORKER_HEALTH_PORT:4040,
      M3_MOCK_IMAGE_ENABLED:false,M3_MOCK_AV_ENABLED:false,M3_MOCK_SUBTITLE_MUSIC_ENABLED:false,M4_MOCK_SAMPLE_VIDEO_ENABLED:false,
      M4_LOCAL_COMPOSE_ENABLED:false,M4_LOCAL_EPISODE_COMPOSE_ENABLED:true,M4_COMPOSE_WORK_DIR:"/tmp/compose-work",M4_COMPOSE_OBJECT_DIR:"/tmp/compose-objects",
      M4_COMPOSE_PYTHON:"python3",M3_CHARACTER_REFERENCE_GATE:"legacy",REAL_MEDIA_SITE_AUTH_CONFIGURED:authorized,
      ...(authorized?{REAL_MEDIA_WORKSPACE_ID:"workspace",REAL_MEDIA_ENV:{REAL_MEDIA_ALLOW_PRODUCTION:"true"},REAL_MEDIA_S3:{bucket:"test"}}:{})});
    bootstrap.startRuntime.mockResolvedValue({status:{},shutdown:vi.fn(async()=>undefined)});
    const listen=vi.fn(async()=>undefined);
    bootstrap.createApp.mockResolvedValue({enableShutdownHooks:vi.fn(),useGlobalFilters:vi.fn(),listen});
    await import("./main");await vi.waitFor(()=>expect(listen).toHaveBeenCalledWith(4040,"127.0.0.1"));
    expect(bootstrap.startRuntime).toHaveBeenCalledOnce();
    expect(bootstrap.startRuntime).toHaveBeenCalledWith(expect.objectContaining({nodeEnv,episodeComposeEnabled:episode,localComposeEnabled:false,
      mockObjectDir:undefined,mockImageEnabled:false,mockAvEnabled:false,mockSmEnabled:false,voiceComposeEnabled:false,
      composeWorkDir:"/tmp/compose-work",composeObjectDir:"/tmp/compose-objects"}));
  });
});
