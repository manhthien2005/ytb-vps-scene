import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ChannelProfileSnapshotSchema,
  PublicationCompletionRequestSchema,
  PublicationMetadataSchema,
  PublicationStateSchema,
  PublisherCapabilitiesSchema,
  PublisherClaimResponseSchema,
  PublisherDownloadAccessSchema,
  PublisherDownloadArtifactSchema,
  PublisherEnrollRequestSchema,
  PublisherEnrollResponseSchema,
  PublisherOutputSchema,
  PublisherProgressRequestSchema,
  PublisherReconcileRequestSchema,
  UploadDefaultsSchema,
} from "../src/index.js";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const TASK_UUID = "123e4567-e89b-42d3-a456-426614174001";
const ARTIFACT_UUID = "123e4567-e89b-42d3-a456-426614174002";
const PROFILE_UUID = "123e4567-e89b-42d3-a456-426614174003";
const DEVICE_UUID = "123e4567-e89b-42d3-a456-426614174004";
const REQUEST_UUID = "123e4567-e89b-42d3-a456-426614174005";
const NOW = "2026-07-28T12:00:00.000Z";
const LATER = "2026-07-28T12:01:30.000Z";
const SHA256 = createHash("sha256").update("artifact").digest("hex");

const artifact = {
  artifactId: ARTIFACT_UUID,
  kind: "OUTPUT",
  fileName: "video.mp4",
  mimeType: "video/mp4",
  sizeBytes: 100,
  sha256: SHA256,
} as const;

const metadata = {
  title: "A reviewed title",
  description: "A reviewed description",
  tags: ["one", "two"],
  hashtags: ["#one"],
  categoryId: "22",
  language: "vi",
  audience: "NOT_MADE_FOR_KIDS",
  ageRestriction: "NONE",
  playlistIds: [],
  license: "YOUTUBE",
  commentsMode: "ALLOW_ALL",
  showRatings: true,
  paidPromotion: false,
  containsSyntheticMedia: false,
  automaticChapters: true,
  featuredPlaces: true,
  automaticConcepts: true,
  allowEmbedding: true,
  notifySubscribers: false,
  allowRemixing: "VIDEO_AND_AUDIO",
  visibility: "PRIVATE",
  scheduledAt: null,
} as const;

const profile = {
  profileId: PROFILE_UUID,
  channelId: UUID,
  youtubeChannelId: "UC1234567890123456789012",
  version: 3,
  titlePrompt: "Create a title",
  descriptionPrompt: "Create a description",
  tagsPrompt: "Create tags",
  thumbnailPrompt: "Create a thumbnail",
  defaultTags: ["channel-tag"],
  uploadDefaults: {
    categoryId: "22",
    language: "vi",
    audience: "NOT_MADE_FOR_KIDS",
    ageRestriction: "NONE",
    playlistIds: [],
    license: "YOUTUBE",
    commentsMode: "ALLOW_ALL",
    showRatings: true,
    paidPromotion: false,
    containsSyntheticMedia: false,
    automaticChapters: true,
    featuredPlaces: true,
    automaticConcepts: true,
    allowEmbedding: true,
    notifySubscribers: false,
    allowRemixing: "VIDEO_AND_AUDIO",
    visibility: "PRIVATE",
  },
  scheduleRules: {
    timezone: "Asia/Bangkok",
    preferredSlots: [{ weekday: 3, time: "19:30" }],
    minimumGapMinutes: 1440,
    maximumPerDay: 1,
    minimumLeadMinutes: 120,
    blackouts: [],
  },
  createdAt: NOW,
} as const;

describe("publisher contracts", () => {
  it("rejects an unknown publication state", () => {
    expect(() => PublicationStateSchema.parse("AUTOMATION_BYPASS")).toThrow();
  });

  it("requires a canonical SHA-256 artifact descriptor", () => {
    expect(() =>
      PublisherDownloadArtifactSchema.parse({
        ...artifact,
        driveFileId: "drive-output-file-001",
        sha256: "x".repeat(64),
      }),
    ).toThrow();
  });

  it("rejects unknown token fields on download artifacts", () => {
    expect(() =>
      PublisherDownloadArtifactSchema.parse({
        ...artifact,
        driveFileId: "drive-output-file-001",
        driveAccessToken: "must-not-be-embedded",
      }),
    ).toThrow();
  });

  it("requires scheduledAt only for scheduled metadata", () => {
    expect(PublicationMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(() =>
      PublicationMetadataSchema.parse({
        ...metadata,
        visibility: "SCHEDULED",
      }),
    ).toThrow();
    expect(() =>
      PublicationMetadataSchema.parse({
        ...metadata,
        scheduledAt: LATER,
      }),
    ).toThrow();
  });

  it("accepts a strict immutable channel profile snapshot", () => {
    expect(ChannelProfileSnapshotSchema.parse(profile)).toEqual(profile);
    expect(() =>
      ChannelProfileSnapshotSchema.parse({ ...profile, refreshToken: "secret" }),
    ).toThrow();
  });

  it("allows channel defaults to require a synthetic-media review decision", () => {
    expect(
      UploadDefaultsSchema.parse({
        ...profile.uploadDefaults,
        containsSyntheticMedia: null,
      }).containsSyntheticMedia,
    ).toBeNull();
    expect(() =>
      PublicationMetadataSchema.parse({
        ...metadata,
        containsSyntheticMedia: null,
      }),
    ).toThrow();
  });

  it("validates a bounded publisher output", () => {
    const output = {
      taskId: TASK_UUID,
      projectId: UUID,
      projectName: "Project A",
      renderJobId: REQUEST_UUID,
      state: "READY",
      contentKind: "LONG",
      output: artifact,
      transcript: {
        ...artifact,
        artifactId: randomUUID(),
        kind: "TRANSCRIPT",
        fileName: "video.vtt",
        mimeType: "text/vtt",
      },
      thumbnailCandidates: [],
      channelId: null,
      deviceLabel: null,
      scheduledAt: null,
      youtubeUrl: null,
      updatedAt: NOW,
    };
    expect(PublisherOutputSchema.parse(output)).toEqual(output);
    expect(() =>
      PublisherOutputSchema.parse({
        ...output,
        thumbnailCandidates: Array.from({ length: 13 }, (_, index) => ({
          ...artifact,
          artifactId: randomUUID(),
          kind: "THUMB_CANDIDATE",
          fileName: `candidate-${index}.png`,
          mimeType: "image/png",
        })),
      }),
    ).toThrow();
  });

  it("validates capability compatibility fields", () => {
    expect(
      PublisherCapabilitiesSchema.parse({
        apiMajor: 1,
        apiMinor: 0,
        contractSha256: "a".repeat(64),
        minimumClientVersion: "0.1.0",
        latestClientVersion: "0.1.0",
        automationPolicy: "STANDARD_ASSIST",
        features: {
          directDriveDownload: true,
          thumbnailApi: true,
          studioAssist: true,
        },
      }),
    ).toBeTruthy();
  });

  it("validates enrollment without accepting extra credentials", () => {
    expect(
      PublisherEnrollRequestSchema.parse({
        activationToken: "a".repeat(43),
        deviceLabel: "Editing PC",
        appVersion: "0.1.0",
      }),
    ).toBeTruthy();
    expect(
      PublisherEnrollResponseSchema.parse({
        deviceId: DEVICE_UUID,
        deviceSecret: "b".repeat(43),
        enrolledAt: NOW,
      }),
    ).toBeTruthy();
  });

  it("validates claim and progress fencing data", () => {
    expect(
      PublisherClaimResponseSchema.parse({
        taskId: TASK_UUID,
        leaseId: UUID,
        fencingToken: 1,
        leaseExpiresAt: LATER,
        profile,
        proposedScheduleAt: null,
      }),
    ).toBeTruthy();
    expect(
      PublisherProgressRequestSchema.parse({
        requestId: REQUEST_UUID,
        fencingToken: 1,
        fromState: "RESERVED",
        toState: "DOWNLOADING",
        progressPercent: 10,
        message: "Downloading",
        observedAt: NOW,
      }),
    ).toBeTruthy();
  });

  it("requires completion URL and video ID to agree", () => {
    const completion = {
      requestId: REQUEST_UUID,
      fencingToken: 1,
      youtubeVideoId: "dQw4w9WgXcQ",
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      outcome: "PUBLISHED",
      effectiveAt: NOW,
      finalMetadata: metadata,
      thumbnailArtifactId: null,
      observedAt: NOW,
    };
    expect(PublicationCompletionRequestSchema.parse(completion)).toEqual(completion);
    expect(() =>
      PublicationCompletionRequestSchema.parse({
        ...completion,
        youtubeUrl: "https://youtu.be/aaaaaaaaaaa",
      }),
    ).toThrow();
  });

  it("requires an exact, non-duplicated download bundle", () => {
    const output = {
      ...artifact,
      driveFileId: "drive-output-file-001",
    };
    const transcript = {
      ...artifact,
      artifactId: REQUEST_UUID,
      kind: "TRANSCRIPT",
      fileName: "video.vtt",
      mimeType: "text/vtt",
      driveFileId: "drive-transcript-file-001",
    };
    const grant = {
      taskId: TASK_UUID,
      driveAccessToken: "short-lived-access-token",
      expiresAt: LATER,
      artifacts: [output, transcript],
    };

    expect(PublisherDownloadAccessSchema.parse(grant)).toEqual(grant);
    expect(() =>
      PublisherDownloadAccessSchema.parse({
        ...grant,
        artifacts: [output, { ...output, artifactId: REQUEST_UUID }],
      }),
    ).toThrow();
    expect(() =>
      PublisherDownloadAccessSchema.parse({
        ...grant,
        artifacts: [output, transcript, transcript],
      }),
    ).toThrow();
  });

  it("requires explicit, internally consistent reconciliation evidence", () => {
    const published = {
      requestId: REQUEST_UUID,
      fencingToken: 1,
      observation: "PUBLISHED",
      youtubeVideoId: "dQw4w9WgXcQ",
      youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
      explicitNotFoundConfirmation: false,
      observedAt: NOW,
    };
    expect(PublisherReconcileRequestSchema.parse(published)).toEqual(published);
    expect(() =>
      PublisherReconcileRequestSchema.parse({
        ...published,
        youtubeUrl: "https://youtu.be/aaaaaaaaaaa",
      }),
    ).toThrow();
    expect(() =>
      PublisherReconcileRequestSchema.parse({
        ...published,
        observation: "NOT_FOUND",
        youtubeVideoId: null,
        youtubeUrl: null,
      }),
    ).toThrow();
  });
});
