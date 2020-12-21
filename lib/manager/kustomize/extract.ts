import { safeLoad } from 'js-yaml';
import * as datasourceDocker from '../../datasource/docker';
import * as datasourceGitTags from '../../datasource/git-tags';
import * as datasourceGitHubTags from '../../datasource/github-tags';
import { logger } from '../../logger';
import * as dockerVersioning from '../../versioning/docker';
import { PackageDependency, PackageFile } from '../common';

interface Image {
  name: string;
  newTag?: string;
  newName?: string;

  digest?: string;
}

interface Kustomize {
  kind: string;
  bases: string[];
  images: Image[];
}

// URL specifications should follow the hashicorp URL format
// https://github.com/hashicorp/go-getter#url-format
const gitUrl = /^(?:git::)?(?<url>(?:(?:(?:http|https|ssh):\/\/)?(?:.*@)?)?(?<path>(?:[^:/]+[:/])?(?<project>[^/]+\/[^/]+)))(?<subdir>[^?]*)\?ref=(?<currentValue>.+)$/;

export function extractBase(base: string): PackageDependency | null {
  const match = gitUrl.exec(base);

  if (!match) {
    return null;
  }

  if (match?.groups.path.startsWith('github.com')) {
    return {
      currentValue: match.groups.currentValue,
      datasource: datasourceGitHubTags.id,
      depName: match.groups.project.replace('.git', ''),
    };
  }

  return {
    datasource: datasourceGitTags.id,
    depName: match.groups.path.replace('.git', ''),
    depNameShort: match.groups.project.replace('.git', ''),
    lookupName: match.groups.url,
    currentValue: match.groups.currentValue,
  };
}

export function extractImage(image: Image): PackageDependency | null {
  if (image?.name && (image.newTag || image.digest)) {
    const res: PackageDependency = {
      datasource: datasourceDocker.id,
      versioning: dockerVersioning.id,
      depName: image.newName ?? image.name,
    };

    if (image.digest) {
      res.currentDigest = image.digest;
      res.currentValue = image.newTag;
    } else if (image.newTag.startsWith('sha256:')) {
      res.currentDigest = image.newTag;
    } else {
      res.currentValue = image.newTag;
    }
    return res;
  }

  return null;
}

export function parseKustomize(content: string): Kustomize | null {
  let pkg = null;
  try {
    pkg = safeLoad(content, { json: true });
  } catch (e) /* istanbul ignore next */ {
    return null;
  }

  if (!pkg) {
    return null;
  }

  if (pkg.kind !== 'Kustomization') {
    return null;
  }

  pkg.bases = (pkg.bases || []).concat(pkg.resources || []);
  pkg.images = pkg.images || [];

  return pkg;
}

export function extractPackageFile(content: string): PackageFile | null {
  logger.trace('kustomize.extractPackageFile()');
  const deps: PackageDependency[] = [];

  const pkg = parseKustomize(content);
  if (!pkg) {
    return null;
  }

  // grab the remote bases
  for (const base of pkg.bases) {
    const dep = extractBase(base);
    if (dep) {
      deps.push(dep);
    }
  }

  // grab the image tags
  for (const image of pkg.images) {
    const dep = extractImage(image);
    if (dep) {
      deps.push({ ...dep, replaceString: content });
    }
  }

  if (!deps.length) {
    return null;
  }
  return { deps };
}
