import { get } from "node:https";
import semver from "semver";
import { escapePackageName } from "./package-name";

export const TRANSFORM_REVISION = 1;

export interface CommonJsSourceMetadata {
  name: string;
  version: string;
}

export interface CommonJsMetadata {
  source: CommonJsSourceMetadata;
  transformRevision: number;
  buildKey: string;
}

export interface PublishedCommonJsVersion {
  version: string;
  commonjs?: CommonJsMetadata;
  unpublished?: boolean;
}

export type PublishedCommonJsVersions = Record<string, PublishedCommonJsVersion>;

export type RegistryPackument = {
  versions?: unknown;
  time?: unknown;
};

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const MAX_REDIRECTS = 5;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const parseCommonJsMetadata = (value: unknown): CommonJsMetadata | undefined => {
  if (!isRecord(value) || !isRecord(value.source)) {
    return;
  }

  const sourceName = value.source.name;
  const sourceVersion = value.source.version;
  const transformRevision = value.transformRevision;
  const buildKey = value.buildKey;

  if (
    typeof sourceName !== "string" ||
    typeof sourceVersion !== "string" ||
    typeof transformRevision !== "number" ||
    typeof buildKey !== "string"
  ) {
    return;
  }

  return {
    source: {
      name: sourceName,
      version: sourceVersion
    },
    transformRevision,
    buildKey
  };
};

const getCanonicalVersion = (sourceVersion: string) => {
  const parsedVersion = semver.parse(sourceVersion);

  if (!parsedVersion) {
    throw new Error(`Invalid source package version: ${sourceVersion}`);
  }

  const prerelease = parsedVersion.prerelease.length
    ? `-${parsedVersion.prerelease.join(".")}`
    : "";

  return {
    parsedVersion,
    version: `${parsedVersion.major}.${parsedVersion.minor}.${parsedVersion.patch}${prerelease}`
  };
};

const getOccupiedVersions = (
  publishedVersions: Readonly<PublishedCommonJsVersions>,
  reservedVersions: Iterable<string>
) => {
  const occupiedVersions = new Set<string>(reservedVersions);

  for (const [version, publishedVersion] of Object.entries(publishedVersions)) {
    occupiedVersions.add(version);
    occupiedVersions.add(publishedVersion.version);
  }

  return occupiedVersions;
};

const hasEquivalentVersion = (versions: ReadonlySet<string>, candidate: string) => {
  for (const version of versions) {
    const parsedVersion = semver.parse(version);

    if (parsedVersion && semver.eq(parsedVersion, candidate)) {
      return true;
    }
  }

  return false;
};

export const getCommonJsPackageName = (sourcePackageName: string) => (
  `@common.js/${escapePackageName(sourcePackageName)}`
);

export const allocateCommonJsVersion = (
  sourceVersion: string,
  buildKey: string,
  publishedVersions: Readonly<PublishedCommonJsVersions>,
  reservedVersions: Iterable<string> = []
) => {
  const matchingVersions: string[] = [];

  for (const [version, publishedVersion] of Object.entries(publishedVersions)) {
    const metadata = publishedVersion.commonjs;
    const candidateVersion = semver.valid(publishedVersion.version)
      ? publishedVersion.version
      : version;

    if (
      semver.valid(candidateVersion) &&
      metadata?.source.version === sourceVersion &&
      metadata.transformRevision === TRANSFORM_REVISION &&
      metadata.buildKey === buildKey
    ) {
      matchingVersions.push(candidateVersion);
    }
  }

  if (matchingVersions.length) {
    return matchingVersions.sort(semver.rcompare)[0] as string;
  }

  const { parsedVersion: parsedSourceVersion, version: canonicalSourceVersion } = getCanonicalVersion(sourceVersion);
  const occupiedVersions = getOccupiedVersions(publishedVersions, reservedVersions);

  if (!hasEquivalentVersion(occupiedVersions, canonicalSourceVersion)) {
    return canonicalSourceVersion;
  }

  if (parsedSourceVersion.prerelease.length) {
    let revision = TRANSFORM_REVISION;

    for (const version of occupiedVersions) {
      const parsedVersion = semver.parse(version);

      if (!parsedVersion) {
        continue;
      }

      const prerelease = parsedVersion.prerelease;
      const commonJsMarkerIndex = parsedSourceVersion.prerelease.length;
      const hasSamePrereleasePrefix = parsedSourceVersion.prerelease.every(
        (identifier, index) => prerelease[index] === identifier
      );

      if (
        parsedVersion.major === parsedSourceVersion.major &&
        parsedVersion.minor === parsedSourceVersion.minor &&
        parsedVersion.patch === parsedSourceVersion.patch &&
        hasSamePrereleasePrefix &&
        prerelease[commonJsMarkerIndex] === "commonjs" &&
        typeof prerelease[commonJsMarkerIndex + 1] === "number"
      ) {
        revision = Math.max(revision, Number(prerelease[commonJsMarkerIndex + 1]) + 1);
      }
    }

    while (true) {
      const candidate = `${canonicalSourceVersion}.commonjs.${revision}`;

      if (!hasEquivalentVersion(occupiedVersions, candidate)) {
        return candidate;
      }

      revision += 1;
    }
  }

  let highestPatch = parsedSourceVersion.patch;

  for (const version of occupiedVersions) {
    const parsedVersion = semver.parse(version);

    if (
      parsedVersion &&
      parsedVersion.major === parsedSourceVersion.major &&
      parsedVersion.minor === parsedSourceVersion.minor
    ) {
      highestPatch = Math.max(highestPatch, parsedVersion.patch);
    }
  }

  const candidate = `${parsedSourceVersion.major}.${parsedSourceVersion.minor}.${highestPatch + 1}`;

  if (!semver.valid(candidate)) {
    throw new Error(`Unable to allocate a version after ${canonicalSourceVersion}`);
  }

  return candidate;
};

const fetchRegistryJson = (url: URL, redirectCount = 0): Promise<unknown | undefined> => (
  new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        headers: {
          accept: "application/json",
          "user-agent": "common.js"
        }
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;

        if (statusCode === 404) {
          response.resume();
          resolve(undefined);
          return;
        }

        if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
          response.resume();

          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error(`Too many redirects while fetching ${url.toString()}`));
            return;
          }

          const redirectUrl = new URL(response.headers.location, url);

          if (redirectUrl.protocol !== "https:") {
            reject(new Error(`Refusing non-HTTPS registry redirect to ${redirectUrl.toString()}`));
            return;
          }

          fetchRegistryJson(redirectUrl, redirectCount + 1).then(resolve, reject);
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new Error(`npm registry request failed with status ${statusCode} for ${url.toString()}`));
          return;
        }

        response.setEncoding("utf8");
        let responseBody = "";

        response.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve(JSON.parse(responseBody) as unknown);
          } catch (error) {
            reject(new Error(`Invalid npm registry response for ${url.toString()}: ${String(error)}`));
          }
        });
      }
    );

    request.setTimeout(15_000, () => {
      request.destroy(new Error(`npm registry request timed out for ${url.toString()}`));
    });
    request.on("error", reject);
  })
);

export const getPublishedCommonJsVersions = async (
  sourcePackageName: string
): Promise<PublishedCommonJsVersions> => {
  const commonJsPackageName = getCommonJsPackageName(sourcePackageName);
  const registryUrl = new URL(`${NPM_REGISTRY_URL}/${encodeURIComponent(commonJsPackageName)}`);
  const packument = await fetchRegistryJson(registryUrl) as RegistryPackument | undefined;

  if (!packument) {
    return {};
  }

  return parsePublishedCommonJsVersions(packument);
};

export const parsePublishedCommonJsVersions = (
  packument: RegistryPackument
): PublishedCommonJsVersions => {
  const versions = isRecord(packument.versions) ? packument.versions : {};
  const time = isRecord(packument.time) ? packument.time : {};

  const publishedVersions: PublishedCommonJsVersions = {};

  for (const [version, manifest] of Object.entries(versions)) {
    if (!isRecord(manifest)) {
      continue;
    }

    const manifestVersion = typeof manifest.version === "string"
      ? manifest.version
      : version;
    const metadata = parseCommonJsMetadata(manifest.commonjs);

    publishedVersions[version] = {
      version: manifestVersion,
      ...(metadata ? { commonjs: metadata } : {})
    };
  }

  // npm permanently reserves unpublished name/version pairs. The registry removes
  // their manifests from `versions` but retains their semver keys in `time`.
  for (const version of Object.keys(time)) {
    if (semver.valid(version) && !publishedVersions[version]) {
      publishedVersions[version] = {
        version,
        unpublished: true
      };
    }
  }

  return publishedVersions;
};
