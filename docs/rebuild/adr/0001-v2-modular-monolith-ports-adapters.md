# ADR-0001: Build v2 as a modular monolith with ports and adapters

Date: 2026-07-16
Status: accepted

## Context

The audited legacy application is not end-to-end runnable and contains coupled
timeline, persistence, backup, cleanup, and provider behavior. The target host is
a constrained NVIDIA VPS where resume and data durability matter more than
throughput. V2 must be built beside legacy and remain independently testable.

## Decision

Build v2 under `src/ytb_vps_v2/` as a modular monolith:

- pure domain rules;
- application orchestration;
- narrow provider and persistence ports;
- infrastructure adapters;
- CLI, doctor, configuration, and service interfaces.

V2 does not import legacy runtime modules. It preserves safe operator-facing CLI,
configuration, and Drive compatibility through adapters. It owns `job-v2.sqlite`
and never migrates a legacy database in place.

## Consequences

Benefits:

- deterministic offline testing;
- explicit dependency invalidation;
- replaceable provider implementations;
- low deployment overhead;
- durable state can be tested without production services;
- legacy remains available for comparison and rollback.

Costs:

- more interfaces and typed boundary objects at the start;
- temporary duplication while legacy and v2 coexist;
- explicit compatibility and migration work before cutover.

## Rejected alternatives

- Wrapping legacy stages would inherit known unsafe contracts and refactor debt.
- An external workflow engine would add services and operational failure modes
  that are not justified for a single-job, resource-constrained pipeline.
