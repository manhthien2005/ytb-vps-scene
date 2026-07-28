import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const defaultOutput = join(repositoryRoot, "contracts", "publisher-api", "v1");

function parseArguments(argv) {
  let check = false;
  let output = defaultOutput;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a directory");
      }
      output = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { check, output };
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function reference(schemaName) {
  return { $ref: `#/components/schemas/${schemaName}` };
}

function operation({ request, response, security = true }) {
  return {
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: reference(response),
          },
        },
        description: "Successful response",
      },
      "400": {
        content: {
          "application/json": {
            schema: reference("PublisherPublicError"),
          },
        },
        description: "Invalid request",
      },
    },
    ...(request
      ? {
          requestBody: {
            content: {
              "application/json": {
                schema: reference(request),
              },
            },
            required: true,
          },
        }
      : {}),
    ...(security ? { security: [{ publisherBearer: [] }] } : {}),
  };
}

function taskPath(method, taskOperation) {
  return {
    parameters: [
      {
        in: "path",
        name: "taskId",
        required: true,
        schema: {
          format: "uuid",
          type: "string",
        },
      },
    ],
    [method]: taskOperation,
  };
}

function buildOpenApi(schemaGroups) {
  const schemas = Object.assign({}, ...Object.values(schemaGroups));
  return {
    openapi: "3.1.0",
    info: {
      title: "Publisher API",
      version: "1.0.0",
    },
    components: {
      schemas,
      securitySchemes: {
        publisherBearer: {
          scheme: "bearer",
          type: "http",
        },
      },
    },
    paths: {
      "/api/v1/publisher/capabilities": {
        get: operation({
          request: null,
          response: "PublisherCapabilities",
          security: false,
        }),
      },
      "/api/v1/publisher/enroll": {
        post: operation({
          request: "PublisherEnrollRequest",
          response: "PublisherEnrollResponse",
          security: false,
        }),
      },
      "/api/v1/publisher/heartbeat": {
        post: operation({
          request: "PublisherHeartbeatRequest",
          response: "PublisherCapabilities",
        }),
      },
      "/api/v1/publisher/outputs": {
        get: operation({
          request: null,
          response: "PublisherOutputPage",
        }),
      },
      "/api/v1/publisher/tasks/{taskId}/claim": {
        ...taskPath("post", operation({
          request: "PublisherClaimRequest",
          response: "PublisherClaimResponse",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/renew": {
        ...taskPath("post", operation({
          request: "PublisherRenewRequest",
          response: "PublisherRenewResponse",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/progress": {
        ...taskPath("post", operation({
          request: "PublisherProgressRequest",
          response: "PublisherRenewResponse",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/release": {
        ...taskPath("post", operation({
          request: "PublisherReleaseRequest",
          response: "PublisherRenewResponse",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/download-access": {
        ...taskPath("get", operation({
          request: null,
          response: "PublisherDownloadAccess",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/complete": {
        ...taskPath("post", operation({
          request: "PublicationCompletionRequest",
          response: "PublicationCompletionRequest",
        })),
      },
      "/api/v1/publisher/tasks/{taskId}/reconcile": {
        ...taskPath("post", operation({
          request: "PublisherReconcileRequest",
          response: "PublisherRenewResponse",
        })),
      },
    },
  };
}

function addCrossFieldSchemaRules(schemaGroups) {
  schemaGroups.common.PublicationMetadata.allOf = [
    {
      if: {
        properties: {
          visibility: { const: "SCHEDULED" },
        },
        required: ["visibility"],
      },
      then: {
        properties: {
          scheduledAt: { format: "date-time", type: "string" },
        },
      },
      else: {
        properties: {
          scheduledAt: { type: "null" },
        },
      },
    },
  ];
  schemaGroups.common.PublicationMetadata["x-runtime-refinements"] = [
    "scheduledAt matches visibility",
  ];

  schemaGroups.output.PublisherArtifactSummary["x-runtime-refinements"] = [
    "mimeType is allowed for artifact kind",
  ];
  schemaGroups.output.PublisherDownloadArtifact["x-runtime-refinements"] = [
    "mimeType is allowed for artifact kind",
  ];
  schemaGroups.output.PublisherOutput["x-runtime-refinements"] = [
    "output kind is OUTPUT",
    "transcript kind is TRANSCRIPT",
    "thumbnailCandidates kinds are THUMB_CANDIDATE",
  ];
  schemaGroups.output.PublisherDownloadAccess.allOf = [
    {
      properties: {
        artifacts: {
          contains: {
            properties: { kind: { const: "OUTPUT" } },
            required: ["kind"],
          },
          maxContains: 1,
          minContains: 1,
        },
      },
    },
    {
      properties: {
        artifacts: {
          contains: {
            properties: { kind: { const: "TRANSCRIPT" } },
            required: ["kind"],
          },
          maxContains: 1,
          minContains: 1,
        },
      },
    },
    {
      properties: {
        artifacts: {
          contains: {
            properties: { kind: { const: "THUMB_CANDIDATE" } },
            required: ["kind"],
          },
          maxContains: 12,
          minContains: 0,
        },
      },
    },
  ];
  schemaGroups.output.PublisherDownloadAccess["x-runtime-refinements"] = [
    "artifactId and driveFileId are unique",
  ];

  schemaGroups.task.PublicationCompletionRequest["x-runtime-refinements"] = [
    "youtubeUrl identifies youtubeVideoId",
    "outcome matches finalMetadata.visibility",
  ];
  schemaGroups.task.PublisherReconcileRequest["x-runtime-refinements"] = [
    "youtubeVideoId and youtubeUrl are supplied together and agree",
    "terminal observation requires video evidence",
    "NOT_FOUND requires explicitNotFoundConfirmation",
  ];
}

async function listJsonFiles(root, subdirectory = "") {
  let entries;
  try {
    entries = await readdir(join(root, subdirectory), { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const child = join(subdirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonFiles(root, child)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(child.replaceAll("\\", "/"));
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function buildBundle() {
  const contractModule = await import(
    pathToFileURL(
      join(
        repositoryRoot,
        "packages",
        "publisher-contracts",
        "src",
        "index.ts",
      ),
    ).href
  );
  const schemaGroups = contractModule.createPublisherContractJsonSchemas();
  addCrossFieldSchemaRules(schemaGroups);

  const fixtureTimestamp = "2026-07-28T12:00:00.000Z";
  const profile = {
    profileId: "123e4567-e89b-42d3-a456-426614174003",
    channelId: "123e4567-e89b-42d3-a456-426614174000",
    youtubeChannelId: "UC1234567890123456789012",
    version: 1,
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
    createdAt: fixtureTimestamp,
  };
  const metadata = {
    title: "A reviewed title",
    description: "A reviewed description",
    tags: ["channel-tag"],
    hashtags: ["#example"],
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
  };
  const fixtures = {
    "fixtures/capabilities.json": contractModule.PublisherCapabilitiesSchema.parse({
      apiMajor: 1,
      apiMinor: 0,
      contractSha256: "0".repeat(64),
      minimumClientVersion: "0.1.0",
      latestClientVersion: "0.1.0",
      automationPolicy: "STANDARD_ASSIST",
      features: {
        directDriveDownload: true,
        thumbnailApi: true,
        studioAssist: true,
      },
    }),
    "fixtures/claim-response.json":
      contractModule.PublisherClaimResponseSchema.parse({
        taskId: "123e4567-e89b-42d3-a456-426614174001",
        leaseId: "123e4567-e89b-42d3-a456-426614174006",
        fencingToken: 1,
        leaseExpiresAt: "2026-07-28T12:01:30.000Z",
        profile,
        proposedScheduleAt: null,
      }),
    "fixtures/completion-request.json":
      contractModule.PublicationCompletionRequestSchema.parse({
        requestId: "123e4567-e89b-42d3-a456-426614174005",
        fencingToken: 1,
        youtubeVideoId: "dQw4w9WgXcQ",
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        outcome: "PUBLISHED",
        effectiveAt: fixtureTimestamp,
        finalMetadata: metadata,
        thumbnailArtifactId: null,
        observedAt: fixtureTimestamp,
      }),
  };

  const files = new Map();
  for (const [groupName, schemas] of Object.entries(schemaGroups)) {
    files.set(
      `schemas/${groupName}.json`,
      canonicalJson({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        schemas,
      }),
    );
  }
  files.set("openapi.json", canonicalJson(buildOpenApi(schemaGroups)));
  for (const [path, fixture] of Object.entries(fixtures)) {
    files.set(path, canonicalJson(fixture));
  }

  const manifestFiles = [...files.entries()]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const contractSha256 = sha256(
    manifestFiles.map((file) => `${file.path}\0${file.sha256}\n`).join(""),
  );
  files.set(
    "manifest.json",
    canonicalJson({
      apiMajor: 1,
      apiMinor: 0,
      contractSha256,
      files: manifestFiles,
    }),
  );
  return files;
}

async function writeBundle(output, files) {
  for (const [path, content] of files) {
    const destination = join(output, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content, "utf8");
  }
}

async function checkBundle(output, files) {
  const expectedPaths = [...files.keys()].sort((left, right) =>
    left.localeCompare(right),
  );
  const actualPaths = await listJsonFiles(output);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
    return false;
  }

  for (const [path, expected] of files) {
    const actual = await readFile(join(output, path), "utf8");
    if (actual !== expected) {
      return false;
    }
  }
  return true;
}

async function main() {
  const { check, output } = parseArguments(process.argv.slice(2));
  const files = await buildBundle();

  if (check) {
    if (!(await checkBundle(output, files))) {
      process.stderr.write(
        `Contract bundle is out of date: ${relative(repositoryRoot, output)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  await writeBundle(output, files);
}

await main();
