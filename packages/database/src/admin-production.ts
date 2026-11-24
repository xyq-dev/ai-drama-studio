import {
  COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_JOB_SCHEMA,
  VOICE_COMPOSE_JOB_SCHEMA,
} from "@ai-drama/domain";

export const ADMIN_JOB_TYPES = [
  "writing",
  "scene",
  "shot",
  "image",
  "video",
  "voice",
  "subtitle",
  "music",
  "shot_compose",
  "episode_compose",
  "other",
] as const;
export type AdminJobType = (typeof ADMIN_JOB_TYPES)[number];

// Project, asset and task listings use the same classification for both filters and labels.
export const generationJobTypeSql = `CASE
  WHEN j.kind = 'MEDIA_COMPOSE' AND j.input_snapshot->>'schema' = '${EPISODE_COMPOSE_JOB_SCHEMA}' THEN 'episode_compose'
  WHEN j.kind = 'MEDIA_COMPOSE' AND (to_jsonb(j)->>'source_shot_revision_id' IS NOT NULL OR j.input_snapshot->>'schema' IN ('${COMPOSE_JOB_SCHEMA}','${VOICE_COMPOSE_JOB_SCHEMA}')) THEN 'shot_compose'
  WHEN j.kind IN ('SCENES','MOCK_TEXT_SCENES') THEN 'scene'
  WHEN j.kind IN ('SHOTS','MOCK_TEXT_SHOTS') THEN 'shot'
  WHEN j.kind IN ('WRITING','SCRIPT','STORY') THEN 'writing'
  WHEN j.kind IN ('MEDIA_IMAGE','MEDIA_CHARACTER_REFERENCE') OR j.input_snapshot->>'capability' = 'image.generate' THEN 'image'
  WHEN j.kind = 'MEDIA_TTS' OR j.input_snapshot->>'capability' = 'audio.tts' THEN 'voice'
  WHEN j.kind = 'MEDIA_VIDEO' OR j.input_snapshot->>'capability' = 'video.generate' THEN 'video'
  WHEN j.kind = 'MEDIA_SUBTITLE' OR j.input_snapshot->>'capability' = 'subtitle.generate' THEN 'subtitle'
  WHEN j.kind = 'MEDIA_MUSIC' OR j.input_snapshot->>'capability' = 'audio.music' THEN 'music'
  ELSE 'other' END`;

function sources(job: string): string {
  const objects = `${job}.input_snapshot #> '{input,sourceObjects}'`;
  return `jsonb_array_elements(CASE WHEN jsonb_typeof(${objects})='array' THEN ${objects} ELSE '[]'::jsonb END)`;
}

// Mirrors the real-only compose gate: a shot's frozen input must contain exclusively real S3 media.
// Empty, incomplete or unknown inputs give no proof of a real output.
function shotSourceClass(job: string): string {
  return `(SELECT CASE WHEN bool_or(src->>'storageProvider'='mock-object-store') THEN 'demo'
            WHEN bool_and((src->>'storageProvider'='s3') IS TRUE) THEN 'real' END
          FROM ${sources(job)} src)`;
}

export const episodeSourceClassSql = `(SELECT CASE WHEN bool_or(evidence.origin='demo') THEN 'demo'
    WHEN bool_and((evidence.origin='real') IS TRUE) THEN 'real' END
  FROM ${sources("j")} segment
  LEFT JOIN LATERAL (
    SELECT a.source_generation_job_id FROM asset a
     WHERE a.id=CASE WHEN pg_input_is_valid(segment->>'assetId','uuid') THEN (segment->>'assetId')::uuid END
       AND a.workspace_id=j.workspace_id AND a.project_id=j.project_id AND a.kind='COMPOSITE' AND a.source_shot_revision_id IS NOT NULL
     LIMIT 1
  ) shot_asset ON TRUE
  LEFT JOIN generation_job shot_job ON shot_job.id=shot_asset.source_generation_job_id
    AND shot_job.workspace_id=j.workspace_id AND shot_job.project_id=j.project_id
    AND shot_job.input_snapshot->>'schema' IN ('${COMPOSE_JOB_SCHEMA}','${VOICE_COMPOSE_JOB_SCHEMA}')
  CROSS JOIN LATERAL (SELECT ${shotSourceClass("shot_job")} AS origin) evidence)`;

export function generationJobDemoSql(hasAssets: boolean): string {
  return `CASE
    WHEN j.kind IN ('MOCK','MOCK_TEXT_SCENES','MOCK_TEXT_SHOTS') OR j.input_snapshot->>'schema' LIKE '%.mock.%' THEN TRUE
    WHEN j.input_snapshot->>'schema' IN ('${COMPOSE_JOB_SCHEMA}','${VOICE_COMPOSE_JOB_SCHEMA}') THEN ${shotSourceClass("j")}='demo'
    ${hasAssets ? `WHEN j.input_snapshot->>'schema'='${EPISODE_COMPOSE_JOB_SCHEMA}' THEN ${episodeSourceClassSql}='demo'` : ""}
    ELSE FALSE END`;
}
