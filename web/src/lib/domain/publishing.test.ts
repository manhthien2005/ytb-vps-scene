import { describe, expect, it } from "vitest";

import {
  assertPublicationTransition,
  findNextScheduleSlot,
  parseScheduleRules,
  parseUploadDefaults,
  PublishingDomainError,
} from "./publishing";

const defaultRules = {
  timezone: "Asia/Bangkok",
  preferredSlots: [{ weekday: 3, time: "19:30" }],
  minimumGapMinutes: 1440,
  maximumPerDay: 1,
  minimumLeadMinutes: 120,
  blackouts: [],
} as const;

describe("publication state transitions", () => {
  it("allows reviewed work to enter browser preparation", () => {
    expect(() =>
      assertPublicationTransition("REVIEW", "BROWSER_PREP"),
    ).not.toThrow();
  });

  it("forbids an upload from returning directly to READY", () => {
    expect(() => assertPublicationTransition("UPLOADING", "READY")).toThrow(
      expect.objectContaining({ code: "PUBLICATION_TRANSITION_INVALID" }),
    );
  });

  it("requires reconciliation after ambiguous post-upload state", () => {
    expect(() =>
      assertPublicationTransition("UPLOADING", "RECONCILE_REQUIRED"),
    ).not.toThrow();
    expect(() =>
      assertPublicationTransition("RECONCILE_REQUIRED", "READY"),
    ).toThrow();
  });
});

describe("publishing profile parsing", () => {
  it("validates upload defaults through the shared contract", () => {
    expect(
      parseUploadDefaults({
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
      }).visibility,
    ).toBe("PRIVATE");
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() =>
      parseScheduleRules({ ...defaultRules, timezone: "Bangkok-ish" }),
    ).toThrow(
      expect.objectContaining({ code: "PUBLISHER_TIMEZONE_INVALID" }),
    );
  });

  it("rejects a fixed offset where an IANA timezone is required", () => {
    expect(() =>
      parseScheduleRules({ ...defaultRules, timezone: "+07:00" }),
    ).toThrow(
      expect.objectContaining({ code: "PUBLISHER_TIMEZONE_INVALID" }),
    );
  });
});

describe("publication scheduling", () => {
  it("chooses the next preferred slot in the channel timezone", () => {
    const result = findNextScheduleSlot(
      parseScheduleRules(defaultRules),
      [],
      new Date("2026-07-28T12:00:00.000Z"),
    );
    expect(result).toBe("2026-07-29T12:30:00.000Z");
  });

  it("skips a slot blocked by minimum gap and returns the following week", () => {
    const result = findNextScheduleSlot(
      parseScheduleRules(defaultRules),
      [
        {
          scheduledAt: "2026-07-29T12:30:00.000Z",
          status: "HELD",
        },
      ],
      new Date("2026-07-28T12:00:00.000Z"),
    );
    expect(result).toBe("2026-08-05T12:30:00.000Z");
  });

  it("respects daily maximum across held and committed reservations", () => {
    const rules = parseScheduleRules({
      ...defaultRules,
      preferredSlots: [
        { weekday: 3, time: "18:00" },
        { weekday: 3, time: "19:30" },
      ],
      minimumGapMinutes: 0,
      maximumPerDay: 1,
    });
    const result = findNextScheduleSlot(
      rules,
      [
        {
          scheduledAt: "2026-07-29T11:00:00.000Z",
          status: "COMMITTED",
        },
      ],
      new Date("2026-07-28T12:00:00.000Z"),
    );
    expect(result).toBe("2026-08-05T11:00:00.000Z");
  });

  it("skips a nonexistent local time during daylight-saving transition", () => {
    const result = findNextScheduleSlot(
      parseScheduleRules({
        timezone: "America/New_York",
        preferredSlots: [{ weekday: 7, time: "02:30" }],
        minimumGapMinutes: 0,
        maximumPerDay: 1,
        minimumLeadMinutes: 0,
        blackouts: [],
      }),
      [],
      new Date("2026-03-07T12:00:00.000Z"),
    );
    expect(result).toBe("2026-03-15T06:30:00.000Z");
  });

  it("fails with a stable code when no slot exists within 180 days", () => {
    expect(() =>
      findNextScheduleSlot(
        parseScheduleRules({
          ...defaultRules,
          blackouts: [
            {
              startsAt: "2026-07-28T00:00:00.000Z",
              endsAt: "2027-02-01T00:00:00.000Z",
            },
          ],
        }),
        [],
        new Date("2026-07-28T12:00:00.000Z"),
      ),
    ).toThrow(
      expect.objectContaining<Partial<PublishingDomainError>>({
        code: "PUBLISHER_SCHEDULE_UNAVAILABLE",
      }),
    );
  });
});
