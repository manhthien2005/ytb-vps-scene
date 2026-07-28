import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const scriptPath = join(repositoryRoot, "scripts", "export-publisher-contract.mjs");
const temporaryDirectories: string[] = [];

async function newOutputDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "publisher-contract-"));
  temporaryDirectories.push(root);
  return join(root, name);
}

function runExport(outputDirectory: string, check = false) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      scriptPath,
      "--output",
      outputDirectory,
      ...(check ? ["--check"] : []),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

async function readTree(root: string, relative = ""): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = join(relative, entry.name);
    if (entry.isDirectory()) {
      for (const [path, content] of await readTree(root, child)) {
        result.set(path, content);
      }
    } else {
      result.set(child.replaceAll("\\", "/"), await readFile(join(root, child), "utf8"));
    }
  }
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("publisher contract export", () => {
  it("exports the same canonical bytes twice", async () => {
    const first = await newOutputDirectory("first");
    const second = await newOutputDirectory("second");

    const firstResult = runExport(first);
    const secondResult = runExport(second);

    expect(firstResult.stderr).toBe("");
    expect(secondResult.stderr).toBe("");
    expect(firstResult.status).toBe(0);
    expect(secondResult.status).toBe(0);
    expect(await readTree(first)).toEqual(await readTree(second));
  });

  it("writes a timestamp-free manifest with a canonical contract hash", async () => {
    const output = await newOutputDirectory("bundle");
    expect(runExport(output).status).toBe(0);

    const manifest = JSON.parse(
      await readFile(join(output, "manifest.json"), "utf8"),
    ) as {
      contractSha256: string;
      files: Array<{ path: string; sha256: string }>;
      generatedAt?: string;
    };

    expect(manifest.generatedAt).toBeUndefined();
    expect(manifest.contractSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.map((file) => file.path)).not.toContain("manifest.json");
    expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(
      true,
    );
  });

  it("detects drift in check mode", async () => {
    const output = await newOutputDirectory("bundle");
    expect(runExport(output).status).toBe(0);
    expect(runExport(output, true).status).toBe(0);

    const commonPath = join(output, "schemas", "common.json");
    await writeFile(
      commonPath,
      `${await readFile(commonPath, "utf8")} `,
      "utf8",
    );

    const drift = runExport(output, true);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("Contract bundle is out of date");
  });

  it("retains cross-field invariants in the vendored schema bundle", async () => {
    const output = await newOutputDirectory("bundle");
    expect(runExport(output).status).toBe(0);

    const common = JSON.parse(
      await readFile(join(output, "schemas", "common.json"), "utf8"),
    ) as {
      schemas: {
        PublicationMetadata: {
          allOf?: unknown[];
          "x-runtime-refinements"?: string[];
        };
      };
    };
    const artifactSchemas = JSON.parse(
      await readFile(join(output, "schemas", "output.json"), "utf8"),
    ) as {
      schemas: {
        PublisherDownloadAccess: {
          allOf?: unknown[];
          "x-runtime-refinements"?: string[];
        };
      };
    };
    const task = JSON.parse(
      await readFile(join(output, "schemas", "task.json"), "utf8"),
    ) as {
      schemas: {
        PublicationCompletionRequest: {
          "x-runtime-refinements"?: string[];
        };
        PublisherReconcileRequest: {
          "x-runtime-refinements"?: string[];
        };
      };
    };

    expect(common.schemas.PublicationMetadata.allOf).toHaveLength(1);
    expect(
      common.schemas.PublicationMetadata["x-runtime-refinements"],
    ).toContain("scheduledAt matches visibility");
    expect(artifactSchemas.schemas.PublisherDownloadAccess.allOf).toHaveLength(3);
    expect(
      artifactSchemas.schemas.PublisherDownloadAccess["x-runtime-refinements"],
    ).toContain("artifactId and driveFileId are unique");
    expect(
      task.schemas.PublicationCompletionRequest["x-runtime-refinements"],
    ).toContain("youtubeUrl identifies youtubeVideoId");
    expect(
      task.schemas.PublisherReconcileRequest["x-runtime-refinements"],
    ).toContain("NOT_FOUND requires explicitNotFoundConfirmation");
  });

  it("declares every OpenAPI path parameter", async () => {
    const output = await newOutputDirectory("bundle");
    expect(runExport(output).status).toBe(0);
    const openApi = JSON.parse(
      await readFile(join(output, "openapi.json"), "utf8"),
    ) as {
      paths: Record<
        string,
        {
          parameters?: Array<{
            in: string;
            name: string;
            required: boolean;
          }>;
        }
      >;
    };

    for (const [path, pathItem] of Object.entries(openApi.paths)) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(
        (match) => match[1],
      );
      for (const placeholder of placeholders) {
        expect(pathItem.parameters).toContainEqual(
          expect.objectContaining({
            in: "path",
            name: placeholder,
            required: true,
          }),
        );
      }
    }
  });
});
