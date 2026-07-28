import { z } from "zod";

export const PUBLICATION_STATES = [
  "READY",
  "RESERVED",
  "DOWNLOADING",
  "GENERATING",
  "REVIEW",
  "BROWSER_PREP",
  "UPLOADING",
  "WAITING_CONFIRMATION",
  "MANUAL_ASSIST",
  "RECONCILE_REQUIRED",
  "SCHEDULED",
  "PUBLISHED",
  "FAILED_RETRYABLE",
  "RELEASED",
] as const;

export const PublicationStateSchema = z.enum(PUBLICATION_STATES);
export type PublicationState = z.infer<typeof PublicationStateSchema>;

export const ArtifactKindSchema = z.enum([
  "OUTPUT",
  "TRANSCRIPT",
  "THUMB_CANDIDATE",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UtcTimestampSchema = z
  .string()
  .datetime({ offset: false, precision: 3 })
  .refine((value) => value.endsWith("Z"), "Timestamp must be UTC");
const NonEmptyTextSchema = z.string().trim().min(1);
const SafeLineSchema = NonEmptyTextSchema.max(256).refine(
  (value) => !/[\u0000\r\n]/u.test(value),
  "Value must be a single safe line",
);
const SemverSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/);
const YouTubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const YouTubeChannelIdSchema = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const Base64UrlSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const FileNameSchema = SafeLineSchema.max(255).refine(
  (value) => !/[\\/]/u.test(value) && value !== "." && value !== "..",
  "File name must not contain a path",
);
const MimeTypeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);

const ARTIFACT_MIME_TYPES: Readonly<Record<ArtifactKind, readonly string[]>> = {
  OUTPUT: ["video/mp4", "video/webm", "video/quicktime"],
  TRANSCRIPT: [
    "text/plain",
    "text/vtt",
    "application/x-subrip",
    "application/json",
  ],
  THUMB_CANDIDATE: ["image/png", "image/jpeg", "image/webp"],
};

export const PublisherArtifactSummarySchema = z
  .strictObject({
    artifactId: UuidSchema,
    kind: ArtifactKindSchema,
    fileName: FileNameSchema,
    mimeType: MimeTypeSchema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
  })
  .superRefine((value, context) => {
    if (!ARTIFACT_MIME_TYPES[value.kind].includes(value.mimeType)) {
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: `Unsupported MIME type for ${value.kind}`,
      });
    }
  });
export type PublisherArtifactSummary = Readonly<
  z.infer<typeof PublisherArtifactSummarySchema>
>;

export const PublisherDownloadArtifactSchema = z
  .strictObject({
    artifactId: UuidSchema,
    kind: ArtifactKindSchema,
    fileName: FileNameSchema,
    mimeType: MimeTypeSchema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: Sha256Schema,
    driveFileId: SafeLineSchema.max(256),
  })
  .superRefine((value, context) => {
    if (!ARTIFACT_MIME_TYPES[value.kind].includes(value.mimeType)) {
      context.addIssue({
        code: "custom",
        path: ["mimeType"],
        message: `Unsupported MIME type for ${value.kind}`,
      });
    }
  });
export type PublisherDownloadArtifact = Readonly<
  z.infer<typeof PublisherDownloadArtifactSchema>
>;

export const PublisherOutputSchema = z.strictObject({
  taskId: UuidSchema,
  projectId: UuidSchema,
  projectName: SafeLineSchema.max(200),
  renderJobId: UuidSchema,
  state: PublicationStateSchema,
  contentKind: z.enum(["AUTO", "LONG", "SHORT"]),
  output: PublisherArtifactSummarySchema.refine(
    (value) => value.kind === "OUTPUT",
    "Primary artifact must be OUTPUT",
  ),
  transcript: PublisherArtifactSummarySchema.refine(
    (value) => value.kind === "TRANSCRIPT",
    "Transcript artifact must be TRANSCRIPT",
  ),
  thumbnailCandidates: z
    .array(
      PublisherArtifactSummarySchema.refine(
        (value) => value.kind === "THUMB_CANDIDATE",
        "Thumbnail artifact must be THUMB_CANDIDATE",
      ),
    )
    .max(12),
  channelId: UuidSchema.nullable(),
  deviceLabel: SafeLineSchema.max(100).nullable(),
  scheduledAt: UtcTimestampSchema.nullable(),
  youtubeUrl: z.string().url().max(512).nullable(),
  updatedAt: UtcTimestampSchema,
});
export type PublisherOutput = Readonly<z.infer<typeof PublisherOutputSchema>>;

export const UploadDefaultsSchema = z.strictObject({
  categoryId: z.string().regex(/^\d{1,4}$/),
  language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
  audience: z.enum(["MADE_FOR_KIDS", "NOT_MADE_FOR_KIDS"]),
  ageRestriction: z.enum(["NONE", "AGE_18_PLUS"]),
  playlistIds: z.array(SafeLineSchema.max(128)).max(50),
  license: z.enum(["YOUTUBE", "CREATIVE_COMMONS"]),
  commentsMode: z.enum([
    "ALLOW_ALL",
    "HOLD_POTENTIALLY_INAPPROPRIATE",
    "HOLD_ALL",
    "DISABLED",
  ]),
  showRatings: z.boolean(),
  paidPromotion: z.boolean(),
  containsSyntheticMedia: z.boolean().nullable(),
  automaticChapters: z.boolean(),
  featuredPlaces: z.boolean(),
  automaticConcepts: z.boolean(),
  allowEmbedding: z.boolean(),
  notifySubscribers: z.boolean(),
  allowRemixing: z.enum(["VIDEO_AND_AUDIO", "AUDIO_ONLY", "DISABLED"]),
  visibility: z.enum(["PRIVATE", "UNLISTED", "SCHEDULED"]),
});
export type UploadDefaults = Readonly<z.infer<typeof UploadDefaultsSchema>>;

export const PreferredScheduleSlotSchema = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
});

export const ScheduleBlackoutSchema = z
  .strictObject({
    startsAt: UtcTimestampSchema,
    endsAt: UtcTimestampSchema,
  })
  .refine((value) => value.startsAt < value.endsAt, {
    message: "Blackout end must be after start",
    path: ["endsAt"],
  });

export const ScheduleRulesSchema = z.strictObject({
  timezone: SafeLineSchema.max(100),
  preferredSlots: z.array(PreferredScheduleSlotSchema).min(1).max(50),
  minimumGapMinutes: z.number().int().min(0).max(60 * 24 * 31),
  maximumPerDay: z.number().int().min(1).max(24),
  minimumLeadMinutes: z.number().int().min(0).max(60 * 24 * 31),
  blackouts: z.array(ScheduleBlackoutSchema).max(100),
});
export type ScheduleRules = Readonly<z.infer<typeof ScheduleRulesSchema>>;

export const PublicationMetadataSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(5_000),
    tags: z.array(SafeLineSchema.max(500)).max(500),
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]{1,100}$/u)).max(30),
    categoryId: z.string().regex(/^\d{1,4}$/),
    language: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
    audience: z.enum(["MADE_FOR_KIDS", "NOT_MADE_FOR_KIDS"]),
    ageRestriction: z.enum(["NONE", "AGE_18_PLUS"]),
    playlistIds: z.array(SafeLineSchema.max(128)).max(50),
    license: z.enum(["YOUTUBE", "CREATIVE_COMMONS"]),
    commentsMode: z.enum([
      "ALLOW_ALL",
      "HOLD_POTENTIALLY_INAPPROPRIATE",
      "HOLD_ALL",
      "DISABLED",
    ]),
    showRatings: z.boolean(),
    paidPromotion: z.boolean(),
    containsSyntheticMedia: z.boolean(),
    automaticChapters: z.boolean(),
    featuredPlaces: z.boolean(),
    automaticConcepts: z.boolean(),
    allowEmbedding: z.boolean(),
    notifySubscribers: z.boolean(),
    allowRemixing: z.enum(["VIDEO_AND_AUDIO", "AUDIO_ONLY", "DISABLED"]),
    visibility: z.enum(["PRIVATE", "UNLISTED", "SCHEDULED"]),
    scheduledAt: UtcTimestampSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (value.visibility === "SCHEDULED" && value.scheduledAt === null) {
      context.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "Scheduled visibility requires scheduledAt",
      });
    }
    if (value.visibility !== "SCHEDULED" && value.scheduledAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["scheduledAt"],
        message: "scheduledAt is only valid for scheduled visibility",
      });
    }
  });
export type PublicationMetadata = Readonly<
  z.infer<typeof PublicationMetadataSchema>
>;

export const ChannelProfileSnapshotSchema = z.strictObject({
  profileId: UuidSchema,
  channelId: UuidSchema,
  youtubeChannelId: YouTubeChannelIdSchema,
  version: z.number().int().positive(),
  titlePrompt: z.string().min(1).max(32_768),
  descriptionPrompt: z.string().min(1).max(32_768),
  tagsPrompt: z.string().min(1).max(32_768),
  thumbnailPrompt: z.string().min(1).max(32_768),
  defaultTags: z.array(SafeLineSchema.max(500)).max(500),
  uploadDefaults: UploadDefaultsSchema,
  scheduleRules: ScheduleRulesSchema,
  createdAt: UtcTimestampSchema,
});
export type ChannelProfileSnapshot = Readonly<
  z.infer<typeof ChannelProfileSnapshotSchema>
>;

export const PublisherCapabilitiesSchema = z.strictObject({
  apiMajor: z.literal(1),
  apiMinor: z.number().int().nonnegative(),
  contractSha256: Sha256Schema,
  minimumClientVersion: SemverSchema,
  latestClientVersion: SemverSchema,
  automationPolicy: z.enum(["STANDARD_ASSIST", "MANUAL_ONLY", "DISABLED"]),
  features: z.strictObject({
    directDriveDownload: z.boolean(),
    thumbnailApi: z.boolean(),
    studioAssist: z.boolean(),
  }),
});
export type PublisherCapabilities = Readonly<
  z.infer<typeof PublisherCapabilitiesSchema>
>;

export const PublisherEnrollRequestSchema = z.strictObject({
  activationToken: Base64UrlSecretSchema,
  deviceLabel: SafeLineSchema.max(100),
  appVersion: SemverSchema,
});
export type PublisherEnrollRequest = Readonly<
  z.infer<typeof PublisherEnrollRequestSchema>
>;

export const PublisherEnrollResponseSchema = z.strictObject({
  deviceId: UuidSchema,
  deviceSecret: Base64UrlSecretSchema,
  enrolledAt: UtcTimestampSchema,
});
export type PublisherEnrollResponse = Readonly<
  z.infer<typeof PublisherEnrollResponseSchema>
>;

export const PublisherHeartbeatRequestSchema = z.strictObject({
  appVersion: SemverSchema,
  activeTaskId: UuidSchema.nullable(),
});
export type PublisherHeartbeatRequest = Readonly<
  z.infer<typeof PublisherHeartbeatRequestSchema>
>;

export const PublisherClaimRequestSchema = z.strictObject({
  requestId: UuidSchema,
  channelId: UuidSchema,
});
export type PublisherClaimRequest = Readonly<
  z.infer<typeof PublisherClaimRequestSchema>
>;

export const PublisherClaimResponseSchema = z.strictObject({
  taskId: UuidSchema,
  leaseId: UuidSchema,
  fencingToken: z.number().int().positive(),
  leaseExpiresAt: UtcTimestampSchema,
  profile: ChannelProfileSnapshotSchema,
  proposedScheduleAt: UtcTimestampSchema.nullable(),
});
export type PublisherClaimResponse = Readonly<
  z.infer<typeof PublisherClaimResponseSchema>
>;

export const PublisherRenewRequestSchema = z.strictObject({
  requestId: UuidSchema,
  fencingToken: z.number().int().positive(),
});
export type PublisherRenewRequest = Readonly<
  z.infer<typeof PublisherRenewRequestSchema>
>;

export const PublisherRenewResponseSchema = z.strictObject({
  taskId: UuidSchema,
  fencingToken: z.number().int().positive(),
  leaseExpiresAt: UtcTimestampSchema,
});
export type PublisherRenewResponse = Readonly<
  z.infer<typeof PublisherRenewResponseSchema>
>;

export const PublisherProgressRequestSchema = z.strictObject({
  requestId: UuidSchema,
  fencingToken: z.number().int().positive(),
  fromState: PublicationStateSchema,
  toState: PublicationStateSchema,
  progressPercent: z.number().min(0).max(100),
  message: z.string().max(1_000).nullable(),
  observedAt: UtcTimestampSchema,
});
export type PublisherProgressRequest = Readonly<
  z.infer<typeof PublisherProgressRequestSchema>
>;

export const PublisherReleaseRequestSchema = z.strictObject({
  requestId: UuidSchema,
  fencingToken: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  observedAt: UtcTimestampSchema,
});
export type PublisherReleaseRequest = Readonly<
  z.infer<typeof PublisherReleaseRequestSchema>
>;

export const PublisherDownloadAccessSchema = z
  .strictObject({
    taskId: UuidSchema,
    driveAccessToken: z.string().min(1).max(4_096),
    expiresAt: UtcTimestampSchema,
    artifacts: z.array(PublisherDownloadArtifactSchema).min(2).max(14),
  })
  .superRefine((value, context) => {
    const counts = { OUTPUT: 0, TRANSCRIPT: 0, THUMB_CANDIDATE: 0 };
    const artifactIds = new Set<string>();
    const driveFileIds = new Set<string>();
    for (const artifact of value.artifacts) {
      counts[artifact.kind] += 1;
      artifactIds.add(artifact.artifactId);
      driveFileIds.add(artifact.driveFileId);
    }
    if (
      counts.OUTPUT !== 1 ||
      counts.TRANSCRIPT !== 1 ||
      counts.THUMB_CANDIDATE > 12
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message:
          "Download bundle requires one output, one transcript and at most 12 thumbnails",
      });
    }
    if (
      artifactIds.size !== value.artifacts.length ||
      driveFileIds.size !== value.artifacts.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "Download bundle artifacts must be unique",
      });
    }
  });
export type PublisherDownloadAccess = Readonly<
  z.infer<typeof PublisherDownloadAccessSchema>
>;

function youtubeUrlVideoId(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.hostname === "www.youtube.com" && parsed.pathname === "/watch") {
    return parsed.searchParams.get("v");
  }
  if (parsed.hostname === "youtu.be") {
    return parsed.pathname.slice(1);
  }
  return null;
}

export const PublicationCompletionRequestSchema = z
  .strictObject({
    requestId: UuidSchema,
    fencingToken: z.number().int().positive(),
    youtubeVideoId: YouTubeVideoIdSchema,
    youtubeUrl: z.string().url().max(512),
    outcome: z.enum(["SCHEDULED", "PUBLISHED"]),
    effectiveAt: UtcTimestampSchema,
    finalMetadata: PublicationMetadataSchema,
    thumbnailArtifactId: UuidSchema.nullable(),
    observedAt: UtcTimestampSchema,
  })
  .superRefine((value, context) => {
    if (youtubeUrlVideoId(value.youtubeUrl) !== value.youtubeVideoId) {
      context.addIssue({
        code: "custom",
        path: ["youtubeUrl"],
        message: "YouTube URL and video ID must agree",
      });
    }
    if (
      value.outcome === "SCHEDULED" &&
      value.finalMetadata.visibility !== "SCHEDULED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalMetadata", "visibility"],
        message: "Scheduled outcome requires scheduled metadata",
      });
    }
    if (
      value.outcome === "PUBLISHED" &&
      value.finalMetadata.visibility === "SCHEDULED"
    ) {
      context.addIssue({
        code: "custom",
        path: ["finalMetadata", "visibility"],
        message: "Published outcome cannot retain scheduled visibility",
      });
    }
  });
export type PublicationCompletionRequest = Readonly<
  z.infer<typeof PublicationCompletionRequestSchema>
>;

export const PublisherReconcileRequestSchema = z
  .strictObject({
    requestId: UuidSchema,
    fencingToken: z.number().int().positive(),
    observation: z.enum(["SCHEDULED", "PUBLISHED", "NOT_FOUND", "AMBIGUOUS"]),
    youtubeVideoId: YouTubeVideoIdSchema.nullable(),
    youtubeUrl: z.string().url().max(512).nullable(),
    explicitNotFoundConfirmation: z.boolean(),
    observedAt: UtcTimestampSchema,
  })
  .superRefine((value, context) => {
    const hasVideoEvidence =
      value.youtubeVideoId !== null && value.youtubeUrl !== null;
    const hasPartialVideoEvidence =
      (value.youtubeVideoId === null) !== (value.youtubeUrl === null);

    if (hasPartialVideoEvidence) {
      context.addIssue({
        code: "custom",
        path: ["youtubeUrl"],
        message: "Video ID and URL must be supplied together",
      });
    }
    if (
      hasVideoEvidence &&
      youtubeUrlVideoId(value.youtubeUrl as string) !== value.youtubeVideoId
    ) {
      context.addIssue({
        code: "custom",
        path: ["youtubeUrl"],
        message: "YouTube URL and video ID must agree",
      });
    }
    if (
      (value.observation === "SCHEDULED" ||
        value.observation === "PUBLISHED") &&
      !hasVideoEvidence
    ) {
      context.addIssue({
        code: "custom",
        path: ["youtubeVideoId"],
        message: "Terminal observation requires video evidence",
      });
    }
    if (value.observation === "NOT_FOUND") {
      if (hasVideoEvidence || hasPartialVideoEvidence) {
        context.addIssue({
          code: "custom",
          path: ["youtubeVideoId"],
          message: "Not-found observation cannot include video evidence",
        });
      }
      if (!value.explicitNotFoundConfirmation) {
        context.addIssue({
          code: "custom",
          path: ["explicitNotFoundConfirmation"],
          message: "Not-found reconciliation requires explicit confirmation",
        });
      }
    } else if (value.explicitNotFoundConfirmation) {
      context.addIssue({
        code: "custom",
        path: ["explicitNotFoundConfirmation"],
        message: "Not-found confirmation is only valid for NOT_FOUND",
      });
    }
  });
export type PublisherReconcileRequest = Readonly<
  z.infer<typeof PublisherReconcileRequestSchema>
>;

export const PublisherOutputPageSchema = z.strictObject({
  items: z.array(PublisherOutputSchema).max(100),
  nextCursor: z.string().max(512).nullable(),
  etag: SafeLineSchema.max(256),
});
export type PublisherOutputPage = Readonly<
  z.infer<typeof PublisherOutputPageSchema>
>;

export const PublisherPublicErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    requestId: UuidSchema.nullable(),
  }),
});
export type PublisherPublicError = Readonly<
  z.infer<typeof PublisherPublicErrorSchema>
>;

export const CONTRACT_SCHEMAS = {
  common: {
    PublicationState: PublicationStateSchema,
    PublicationMetadata: PublicationMetadataSchema,
    PublisherPublicError: PublisherPublicErrorSchema,
  },
  device: {
    PublisherCapabilities: PublisherCapabilitiesSchema,
    PublisherEnrollRequest: PublisherEnrollRequestSchema,
    PublisherEnrollResponse: PublisherEnrollResponseSchema,
    PublisherHeartbeatRequest: PublisherHeartbeatRequestSchema,
  },
  channel: {
    UploadDefaults: UploadDefaultsSchema,
    ScheduleRules: ScheduleRulesSchema,
    ChannelProfileSnapshot: ChannelProfileSnapshotSchema,
  },
  output: {
    PublisherArtifactSummary: PublisherArtifactSummarySchema,
    PublisherDownloadArtifact: PublisherDownloadArtifactSchema,
    PublisherOutput: PublisherOutputSchema,
    PublisherOutputPage: PublisherOutputPageSchema,
    PublisherDownloadAccess: PublisherDownloadAccessSchema,
  },
  task: {
    PublisherClaimRequest: PublisherClaimRequestSchema,
    PublisherClaimResponse: PublisherClaimResponseSchema,
    PublisherRenewRequest: PublisherRenewRequestSchema,
    PublisherRenewResponse: PublisherRenewResponseSchema,
    PublisherProgressRequest: PublisherProgressRequestSchema,
    PublisherReleaseRequest: PublisherReleaseRequestSchema,
    PublicationCompletionRequest: PublicationCompletionRequestSchema,
    PublisherReconcileRequest: PublisherReconcileRequestSchema,
  },
} as const;

export function createPublisherContractJsonSchemas(): Record<
  keyof typeof CONTRACT_SCHEMAS,
  Record<string, unknown>
> {
  return Object.fromEntries(
    Object.entries(CONTRACT_SCHEMAS).map(([groupName, schemas]) => [
      groupName,
      Object.fromEntries(
        Object.entries(schemas).map(([schemaName, schema]) => [
          schemaName,
          z.toJSONSchema(schema),
        ]),
      ),
    ]),
  ) as Record<
    keyof typeof CONTRACT_SCHEMAS,
    Record<string, unknown>
  >;
}
