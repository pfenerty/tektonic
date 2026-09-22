import * as fs from 'fs';
import * as path from 'path';
import { Yaml } from 'cdk8s';
import { TEKTON_API_V1 } from '../../constants';
import type { CatalogMetadata } from '../../core/catalog';
import {
  CATALOG_CATEGORIES,
  DEFAULT_CATALOG_PLATFORMS,
  DEFAULT_MIN_PIPELINES_VERSION,
} from '../../core/catalog';
import type { BuiltTask, EmittedFile, SynthModel, SynthTarget } from '../../core/synth-target';
import { catalogReadme } from './catalog-readme';

/**
 * Annotation prefix a catalog entry carries none of. PAC annotations describe how a *this
 * repository's* run is delivered, which is exactly the context a published entry leaves
 * behind. Written out rather than imported from the PAC target so the two stay independent.
 */
const PAC_ANNOTATION_PREFIX = 'pipelinesascode.tekton.dev';

/**
 * Registries a published entry may pull from unless the target is told otherwise.
 *
 * A catalog entry runs in someone else's cluster, which has no pull secret for a private
 * registry — so an entry referencing one is broken for every consumer while looking fine to
 * its author. These are the registries that serve anonymous pulls.
 */
export const PUBLIC_REGISTRIES = [
  'docker.io',
  'ghcr.io',
  'quay.io',
  'gcr.io',
  'registry.k8s.io',
  'mcr.microsoft.com',
  'public.ecr.aws',
  'cgr.dev',
];

/** Entry version, and the minimum-Pipelines annotation: `major.minor` or `major.minor.patch`. */
const VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

/**
 * The registry an image reference pulls from. A first path segment is a registry only when
 * it looks like a host — this is the same rule the OCI reference grammar uses, and it is
 * what makes `alpine:3` and `docker.io/alpine:3` the same image.
 */
export function registryOf(image: string): string {
  const [first, ...rest] = image.split('/');
  if (rest.length === 0) return 'docker.io';
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : 'docker.io';
}

/** Every image a Task spec pulls: its steps' and its sidecars'. */
function imagesIn(spec: Record<string, unknown>): { image: string; where: string }[] {
  const from = (field: string, label: string): { image: string; where: string }[] => {
    const list = Array.isArray(spec[field]) ? (spec[field] as { name?: string; image?: string }[]) : [];
    return list
      .filter(s => typeof s.image === 'string')
      .map(s => ({ image: s.image as string, where: `${label} '${s.name ?? '?'}'` }));
  };
  return [...from('steps', 'step'), ...from('sidecars', 'sidecar')];
}

/** Named entries of a Task spec array field, for the description checks. */
function described(spec: Record<string, unknown>, field: string): { name: string; description?: string }[] {
  const value = spec[field];
  return Array.isArray(value) ? (value as { name: string; description?: string }[]) : [];
}

/**
 * Everything wrong with one catalog entry, as a list of one-line problems.
 *
 * Collected rather than thrown one at a time: the hub's own checks run when a pull request
 * is already open against the catalog repository, so learning about three problems in three
 * round trips is the failure mode this replaces.
 */
export function catalogProblems(
  task: BuiltTask,
  catalog: CatalogMetadata,
  allowedRegistries: string[],
): string[] {
  const problems: string[] = [];
  const spec = (task.manifest.spec ?? {}) as Record<string, unknown>;

  if (!VERSION_RE.test(catalog.version)) {
    problems.push(
      `version '${catalog.version}' is not a catalog version — use 'major.minor' or ` +
        `'major.minor.patch', with no leading 'v'`,
    );
  }
  if (catalog.minPipelinesVersion !== undefined && !VERSION_RE.test(catalog.minPipelinesVersion)) {
    problems.push(
      `minPipelinesVersion '${catalog.minPipelinesVersion}' is not a Pipelines version — ` +
        `use 'major.minor' or 'major.minor.patch'`,
    );
  }
  if (catalog.description.trim().length === 0) {
    problems.push(`description is empty — the hub lists entries by it`);
  }
  for (const category of catalog.categories ?? []) {
    if (!CATALOG_CATEGORIES.includes(category)) {
      problems.push(
        `category '${category}' is not one the hub knows — pick from: ${CATALOG_CATEGORIES.join(', ')}`,
      );
    }
  }
  for (const field of ['params', 'results'] as const) {
    for (const entry of described(spec, field)) {
      if ((entry.description ?? '').trim().length === 0) {
        problems.push(
          `${field.slice(0, -1)} '${entry.name}' has no description — a catalog entry's ` +
            `README is generated from them`,
        );
      }
    }
  }
  for (const { image, where } of imagesIn(spec)) {
    // A param-driven image is the consumer's choice, not the publisher's, so there is
    // nothing here to check against a registry list.
    if (image.includes('$(')) continue;
    const registry = registryOf(image);
    if (!allowedRegistries.includes(registry)) {
      problems.push(
        `${where} pulls '${image}' from '${registry}', which is not a registry a consumer ` +
          `can pull anonymously — publish the image to one of: ${allowedRegistries.join(', ')}`,
      );
    }
  }
  return problems;
}

/** Options for {@link HubTarget}. */
export interface HubTargetOptions {
  /**
   * Directory, under the outdir, the catalog tree is written to. Defaults to `'task'`, the
   * layout a Tekton catalog repository expects (`task/<name>/<version>/<name>.yaml`).
   */
  taskDir?: string;
  /**
   * Catalog name written into the generated README's `hub` resolver snippet — the catalog
   * the entry will live in, not a property of the entry. Defaults to `'tekton'`.
   */
  catalog?: string;
  /**
   * Registries a published entry may reference. Defaults to {@link PUBLIC_REGISTRIES}. Pass
   * your own when publishing to a catalog whose consumers all share a registry.
   */
  allowedRegistries?: string[];
  /** Generate a `README.md` beside each entry. Defaults to `true`. */
  readme?: boolean;
}

/**
 * The Tekton catalog synthesis target: publishes tasks as catalog entries, which
 * {@link HubTaskRef} is the read side of.
 *
 * It emits exactly the tasks carrying {@link TaskOptions.catalog | catalog} metadata, each
 * as the layout a catalog repository expects:
 *
 * ```
 * task/<name>/<version>/<name>.yaml   # a standalone kind: Task
 * task/<name>/<version>/README.md     # generated from the task's own params and results
 * ```
 *
 * The manifest is the same one every other target emits, with everything local to *this*
 * repository taken back off it: no namespace, no project name prefix, no PAC annotations.
 * What it gains is the catalog metadata — `tekton.dev/categories`, `tekton.dev/tags`,
 * `tekton.dev/platforms`, `tekton.dev/displayName`, `tekton.dev/pipelines.minVersion` and
 * the `app.kubernetes.io/version` label — plus a `spec.description`.
 *
 * Publication itself stays outside the tool: a catalog entry is landed by a pull request
 * against the catalog repository, so this writes the tree and stops there. That is also why
 * the CLI reaches it as `tektonic synth --target hub` rather than a `publish` command.
 *
 * Catalog versions are immutable. Emitting over an existing `<version>` directory is how a
 * published entry gets rewritten by accident, so bump {@link CatalogMetadata.version} for
 * every change rather than re-cutting one.
 *
 * @example
 * ```ts
 * new TektonicProject({
 *   namespace: 'ci',
 *   outdir: 'catalog',
 *   pipelines: [pipeline],
 *   targets: [new PacTarget(), new HubTarget()],
 * });
 * ```
 */
export class HubTarget implements SynthTarget {
  readonly name = 'hub';

  constructor(private readonly opts: HubTargetOptions = {}) {}

  emit(model: SynthModel, outdir: string): EmittedFile[] {
    const taskDir = this.opts.taskDir ?? 'task';
    const allowedRegistries = this.opts.allowedRegistries ?? PUBLIC_REGISTRIES;
    const catalogName = this.opts.catalog ?? 'tekton';
    const publishable = model.tasks.filter(t => t.catalog !== undefined);

    if (publishable.length === 0) {
      // Emitting nothing is a plausible end state for a project mid-migration, but a target
      // that silently writes no files is otherwise indistinguishable from one that ran wrong.
      // eslint-disable-next-line no-console
      console.warn(
        `tektonic: the hub target has nothing to publish — no task in this project declares ` +
          `'catalog' metadata, which is what marks one publishable.`,
      );
      return [];
    }

    const files: EmittedFile[] = [];
    for (const task of publishable) {
      const catalog = task.catalog!;
      const problems = catalogProblems(task, catalog, allowedRegistries);
      if (problems.length > 0) {
        throw new Error(
          `HubTarget: task '${task.name}' cannot be published as a catalog entry:\n` +
            problems.map(p => `  - ${p}`).join('\n'),
        );
      }

      const manifest = this.entryManifest(task, catalog);
      const dir = path.join(outdir, taskDir, task.name, catalog.version);
      fs.mkdirSync(dir, { recursive: true });

      const yamlPath = `${taskDir}/${task.name}/${catalog.version}/${task.name}.yaml`;
      Yaml.save(path.join(outdir, yamlPath), [manifest]);
      files.push({ path: yamlPath, manifests: [manifest] });

      if (this.opts.readme ?? true) {
        const readmePath = `${taskDir}/${task.name}/${catalog.version}/README.md`;
        fs.writeFileSync(
          path.join(outdir, readmePath),
          catalogReadme({
            name: task.name,
            catalog,
            spec: (manifest.spec ?? {}) as Record<string, unknown>,
            catalogName,
          }),
          'utf8',
        );
        files.push({ path: readmePath, manifests: [] });
      }
    }
    return files;
  }

  /**
   * One built task, rendered as a standalone catalog entry: this repository's namespace and
   * name prefix dropped, PAC annotations dropped, catalog metadata added.
   */
  private entryManifest(task: BuiltTask, catalog: CatalogMetadata): Record<string, unknown> {
    const metadata = (task.manifest.metadata ?? {}) as Record<string, unknown>;
    const existing = (metadata.annotations ?? {}) as Record<string, string>;
    const carried = Object.fromEntries(
      Object.entries(existing).filter(([key]) => !key.startsWith(`${PAC_ANNOTATION_PREFIX}/`)),
    );
    const platforms = catalog.platforms ?? DEFAULT_CATALOG_PLATFORMS;
    const spec = (task.manifest.spec ?? {}) as Record<string, unknown>;

    return {
      apiVersion: TEKTON_API_V1,
      kind: 'Task',
      metadata: {
        // The declared name, not `resourceName`: a project prefix scopes resources inside one
        // namespace, and a catalog entry is named by the directory it lives in.
        name: task.name,
        labels: { 'app.kubernetes.io/version': catalog.version },
        annotations: {
          ...carried,
          'tekton.dev/pipelines.minVersion': catalog.minPipelinesVersion ?? DEFAULT_MIN_PIPELINES_VERSION,
          'tekton.dev/displayName': catalog.displayName ?? task.name,
          'tekton.dev/platforms': platforms.join(','),
          ...(catalog.categories && catalog.categories.length > 0
            ? { 'tekton.dev/categories': catalog.categories.join(',') }
            : {}),
          ...(catalog.tags && catalog.tags.length > 0
            ? { 'tekton.dev/tags': catalog.tags.join(',') }
            : {}),
        },
      },
      spec: { description: catalog.description, ...spec },
    };
  }
}
