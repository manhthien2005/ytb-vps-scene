import {
  type PublicationState,
  type ScheduleRules,
  ScheduleRulesSchema,
  type UploadDefaults,
  UploadDefaultsSchema,
} from "@zeus/publisher-contracts";
import { Temporal } from "@js-temporal/polyfill";

export class PublishingDomainError extends Error {
  constructor(
    readonly code:
      | "PUBLICATION_TRANSITION_INVALID"
      | "PUBLISHER_TIMEZONE_INVALID"
      | "PUBLISHER_SCHEDULE_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "PublishingDomainError";
  }
}

const TRANSITIONS: Readonly<
  Record<PublicationState, readonly PublicationState[]>
> = {
  READY: ["RESERVED"],
  RESERVED: ["DOWNLOADING", "RELEASED", "FAILED_RETRYABLE"],
  DOWNLOADING: ["GENERATING", "FAILED_RETRYABLE", "RELEASED"],
  GENERATING: ["REVIEW", "FAILED_RETRYABLE", "RELEASED"],
  REVIEW: ["GENERATING", "BROWSER_PREP", "RELEASED"],
  BROWSER_PREP: [
    "UPLOADING",
    "MANUAL_ASSIST",
    "FAILED_RETRYABLE",
    "RELEASED",
  ],
  UPLOADING: [
    "WAITING_CONFIRMATION",
    "MANUAL_ASSIST",
    "RECONCILE_REQUIRED",
  ],
  WAITING_CONFIRMATION: [
    "SCHEDULED",
    "PUBLISHED",
    "MANUAL_ASSIST",
    "RECONCILE_REQUIRED",
  ],
  MANUAL_ASSIST: [
    "WAITING_CONFIRMATION",
    "SCHEDULED",
    "PUBLISHED",
    "RECONCILE_REQUIRED",
  ],
  RECONCILE_REQUIRED: ["SCHEDULED", "PUBLISHED", "FAILED_RETRYABLE"],
  SCHEDULED: [],
  PUBLISHED: [],
  FAILED_RETRYABLE: ["READY"],
  RELEASED: ["READY"],
};

export function assertPublicationTransition(
  from: PublicationState,
  to: PublicationState,
): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new PublishingDomainError(
      "PUBLICATION_TRANSITION_INVALID",
      `Publication transition ${from} -> ${to} is not allowed`,
    );
  }
}

export function parseUploadDefaults(input: unknown): UploadDefaults {
  return UploadDefaultsSchema.parse(input);
}

export function parseScheduleRules(input: unknown): ScheduleRules {
  const rules = ScheduleRulesSchema.parse(input);
  const hasIanaName = rules.timezone === "UTC" || rules.timezone.includes("/");
  if (!hasIanaName) {
    throw new PublishingDomainError(
      "PUBLISHER_TIMEZONE_INVALID",
      `Expected an IANA timezone: ${rules.timezone}`,
    );
  }
  try {
    Temporal.ZonedDateTime.from({
      timeZone: rules.timezone,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
    });
  } catch {
    throw new PublishingDomainError(
      "PUBLISHER_TIMEZONE_INVALID",
      `Unknown IANA timezone: ${rules.timezone}`,
    );
  }
  return rules;
}

export interface PublicationScheduleReservation {
  readonly scheduledAt: string;
  readonly status: "HELD" | "COMMITTED";
}

function instantMilliseconds(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

function sameLocalDate(
  left: Temporal.Instant,
  right: Temporal.Instant,
  timezone: string,
): boolean {
  return left
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .equals(right.toZonedDateTimeISO(timezone).toPlainDate());
}

function candidateFor(
  date: Temporal.PlainDate,
  time: string,
  timezone: string,
): Temporal.Instant | null {
  const [hourText, minuteText] = time.split(":");
  try {
    return Temporal.ZonedDateTime.from(
      {
        timeZone: timezone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour: Number(hourText),
        minute: Number(minuteText),
      },
      { disambiguation: "reject" },
    ).toInstant();
  } catch {
    return null;
  }
}

export function findNextScheduleSlot(
  rules: ScheduleRules,
  reservations: readonly PublicationScheduleReservation[],
  now: Date,
): string {
  const nowInstant = Temporal.Instant.from(now.toISOString());
  const earliest = nowInstant.add({ minutes: rules.minimumLeadMinutes });
  const startDate = nowInstant
    .toZonedDateTimeISO(rules.timezone)
    .toPlainDate();
  const existing = reservations.map((reservation) => ({
    ...reservation,
    instant: Temporal.Instant.from(reservation.scheduledAt),
  }));
  const blackouts = rules.blackouts.map((blackout) => ({
    start: instantMilliseconds(blackout.startsAt),
    end: instantMilliseconds(blackout.endsAt),
  }));

  for (let offset = 0; offset < 180; offset += 1) {
    const date = startDate.add({ days: offset });
    const candidates = rules.preferredSlots
      .filter((slot) => slot.weekday === date.dayOfWeek)
      .map((slot) => candidateFor(date, slot.time, rules.timezone))
      .filter((candidate): candidate is Temporal.Instant => candidate !== null)
      .sort((left, right) =>
        Temporal.Instant.compare(left, right),
      );

    for (const candidate of candidates) {
      if (Temporal.Instant.compare(candidate, earliest) < 0) {
        continue;
      }

      const candidateMs = candidate.epochMilliseconds;
      if (
        blackouts.some(
          (blackout) =>
            candidateMs >= blackout.start && candidateMs < blackout.end,
        )
      ) {
        continue;
      }

      const sameDayCount = existing.filter((reservation) =>
        sameLocalDate(candidate, reservation.instant, rules.timezone),
      ).length;
      if (sameDayCount >= rules.maximumPerDay) {
        continue;
      }

      const minimumGapMs = rules.minimumGapMinutes * 60_000;
      if (
        existing.some(
          (reservation) =>
            Math.abs(candidateMs - reservation.instant.epochMilliseconds) <
            minimumGapMs,
        )
      ) {
        continue;
      }

      return candidate.toString({ smallestUnit: "millisecond" });
    }
  }

  throw new PublishingDomainError(
    "PUBLISHER_SCHEDULE_UNAVAILABLE",
    "No publication slot is available within 180 calendar days",
  );
}
