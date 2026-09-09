import { z } from 'zod';

export const RemoteDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RemoteIdSchema = z.string().uuid();
export const RemoteJobKindSchema = z.enum(['audio_analysis', 'text_generation']);
export const RemoteJobStateSchema = z.enum([
  'uploading',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export const RemoteEmbeddingIdentitySchema = z
  .object({
    repository: z.string().min(1).max(200),
    revision: z.string().min(1).max(200),
    preprocessing: z.string().min(1).max(200),
    dimension: z.number().int().min(1).max(4096),
    normalization: z.enum(['l2', 'none']),
  })
  .strict();
export const RemoteTextInputSchema = z
  .object({
    transcript: z.string().min(1).max(500_000),
    summaryDetail: z.enum(['concise', 'standard', 'detailed']),
    title: z.string().max(500).nullable(),
    disableThinking: z.boolean(),
  })
  .strict();
export const RemoteCreateJobSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: RemoteJobKindSchema,
    // Opaque desktop identifier; never interpreted as an object key or path.
    clientMeetingId: z.string().min(1).max(200),
    clientRunId: RemoteIdSchema,
    profileId: z.string().min(1).max(100),
    profileDigest: RemoteDigestSchema,
    source: z
      .object({
        bytes: z.number().int().positive().max(1_073_741_824),
        sha256: RemoteDigestSchema,
        contentType: z.enum([
          'audio/mpeg',
          'audio/mp4',
          'audio/wav',
          'audio/x-m4a',
          'application/octet-stream',
          'application/json',
        ]),
      })
      .strict(),
  })
  .strict()
  .refine(
    (v) =>
      v.kind !== 'text_generation' ||
      (v.source.contentType === 'application/json' && v.source.bytes <= 2_000_000),
    'Text inputs must be bounded JSON',
  );
export const RemoteUploadPartsRequestSchema = z
  .object({ partNumbers: z.array(z.number().int().min(1).max(64)).min(1).max(2) })
  .strict();
export const RemoteUploadPartSchema = z
  .object({
    partNumber: z.number().int().positive(),
    etag: z.string(),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export const RemoteUploadSchema = z
  .object({
    uploadId: z.string().nullable(),
    partSize: z.number().int().positive(),
    state: z.enum(['pending', 'uploading', 'verifying', 'complete']),
    parts: z.array(RemoteUploadPartSchema),
  })
  .strict();
export const RemoteUploadUrlsSchema = z
  .object({
    parts: z.array(
      z
        .object({
          partNumber: z.number().int().positive(),
          url: z.string().url(),
          expiresAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export const RemoteErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        requestId: z.string(),
      })
      .strict(),
  })
  .strict();
export const RemoteJobSchema = z
  .object({
    id: RemoteIdSchema,
    kind: RemoteJobKindSchema,
    clientRunId: RemoteIdSchema,
    state: RemoteJobStateSchema,
    phase: z.string(),
    revision: z.number().int().positive(),
    cancelRequested: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    resultAvailable: z.boolean(),
    error: z.object({ code: z.string(), retryable: z.boolean() }).nullable(),
  })
  .strict();
const timing = { start: z.number().finite().nonnegative(), end: z.number().finite().nonnegative() };
export const RemoteTranscriptionSchema = z
  .object({
    segments: z
      .array(
        z
          .object({ ...timing, text: z.string().max(100_000) })
          .strict()
          .refine((s) => s.end >= s.start),
      )
      .max(100_000),
  })
  .strict();
export const RemoteDiarizationSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            ...timing,
            speaker: z.string().max(100),
            embedding: z.array(z.number().finite()).max(4096),
          })
          .strict()
          .refine((s) => s.end >= s.start),
      )
      .max(100_000),
    num_speakers: z.number().int().nonnegative().max(1000),
    embeddingIdentity: RemoteEmbeddingIdentitySchema,
    warnings: z.array(z.string().max(100)).max(1000),
  })
  .strict()
  .refine(
    (v) =>
      v.segments.every(
        (s) => s.embedding.length === 0 || s.embedding.length === v.embeddingIdentity.dimension,
      ),
    'Embedding dimension mismatch',
  );
export const RemoteActionItemsSchema = z
  .array(
    z
      .object({
        text: z.string().min(1).max(10_000),
        owner: z.string().max(500).nullable(),
        due_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
      })
      .strict(),
  )
  .max(1000);
export const RemoteTextResultSchema = z
  .object({ summary: z.string().min(1).max(1_000_000), actionItems: RemoteActionItemsSchema })
  .strict();
export const RemoteArtifactSchema = z
  .object({
    name: z.enum(['transcription', 'diarization', 'text']),
    bytes: z.number().int().positive().max(20_000_000),
    sha256: RemoteDigestSchema,
    contentType: z.literal('application/json'),
  })
  .strict();
export const RemoteManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: RemoteIdSchema,
    clientRunId: RemoteIdSchema,
    profileId: z.string(),
    profileDigest: RemoteDigestSchema,
    generation: z.number().int().positive(),
    artifacts: z.array(RemoteArtifactSchema).min(1).max(2),
  })
  .strict()
  .refine((v) => {
    const names = v.artifacts
      .map((a) => a.name)
      .sort()
      .join(',');
    return names === 'text' || names === 'diarization,transcription';
  }, 'Expected exactly the artifact set for one job kind');
export const RemoteResultSchema = z
  .object({
    manifest: RemoteManifestSchema,
    manifestDigest: RemoteDigestSchema,
    downloads: z
      .array(
        z
          .object({
            name: RemoteArtifactSchema.shape.name,
            url: z.string().url(),
            expiresAt: z.string().datetime(),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .refine(
    (v) =>
      v.downloads
        .map((d) => d.name)
        .sort()
        .join(',') ===
      v.manifest.artifacts
        .map((a) => a.name)
        .sort()
        .join(','),
    'Download names must match manifest',
  );
export const RemoteAcknowledgementSchema = z
  .object({ manifestDigest: RemoteDigestSchema })
  .strict();
export const RemoteProfileSchema = z
  .object({
    id: z.string(),
    digest: RemoteDigestSchema,
    processor: z.enum(['providers', 'synthetic']),
    transcriptionModel: z.string(),
    llmModel: z.string(),
    embeddingIdentity: RemoteEmbeddingIdentitySchema,
  })
  .strict();
export const RemoteCapabilitiesSchema = z
  .object({
    schemaVersions: z.array(z.literal(1)),
    serviceId: z.string().min(1),
    ownerId: z.string().min(1),
    profiles: z.array(RemoteProfileSchema),
    limits: z
      .object({
        sourceBytes: z.number().int().positive(),
        durationSeconds: z.number().int().positive(),
        partBytes: z.literal(16_777_216),
        concurrentParts: z.literal(2),
        queuedJobs: z.number().int().positive(),
        textBytes: z.number().int().positive(),
        textCharacters: z.number().int().positive(),
      })
      .strict(),
    retention: z
      .object({
        abandonedUploadHours: z.literal(24),
        acknowledgedHours: z.literal(24),
        resultDays: z.literal(30),
        tombstoneDays: z.literal(90),
      })
      .strict(),
  })
  .strict();
export type RemoteCreateJob = z.infer<typeof RemoteCreateJobSchema>;
export type RemoteJob = z.infer<typeof RemoteJobSchema>;
export type RemoteManifest = z.infer<typeof RemoteManifestSchema>;
export type RemoteProfile = z.infer<typeof RemoteProfileSchema>;
export type RemoteTextInput = z.infer<typeof RemoteTextInputSchema>;
export type RemoteCapabilities = z.infer<typeof RemoteCapabilitiesSchema>;
export type RemoteResult = z.infer<typeof RemoteResultSchema>;
export type RemoteDiarization = z.infer<typeof RemoteDiarizationSchema>;
