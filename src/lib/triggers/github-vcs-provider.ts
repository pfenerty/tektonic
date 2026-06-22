import { Construct } from 'constructs';
import { GitHubPushTrigger } from './github-push.trigger';
import { GitHubPullRequestTrigger } from './github-pull-request.trigger';
import { GitHubTagTrigger } from './github-tag.trigger';
import { TRIGGER_EVENTS } from '../core/trigger-events';
import type { VcsProvider, VcsProviderCtx, VcsTriggerContribution } from './vcs-provider';

/**
 * GitHub VCS provider.
 *
 * Implements {@link VcsProvider} over the existing GitHub trigger classes,
 * supporting push, pull request, and tag events. When both push and tag events
 * are configured, the push trigger automatically adds a CEL interceptor that
 * excludes `refs/tags/` pushes so they are handled only by the tag trigger.
 */
export class GitHubVcsProvider implements VcsProvider {
  readonly supportedEvents: TRIGGER_EVENTS[] = [
    TRIGGER_EVENTS.PUSH,
    TRIGGER_EVENTS.PULL_REQUEST,
    TRIGGER_EVENTS.TAG,
  ];

  buildTrigger(
    scope: Construct,
    pipelineRef: string,
    event: TRIGGER_EVENTS,
    ctx: VcsProviderCtx,
  ): VcsTriggerContribution {
    const triggerProps = {
      namespace: ctx.namespace,
      namePrefix: ctx.namePrefix,
      pipelineRef,
      urlParam: ctx.urlParam,
      revisionParam: ctx.revisionParam,
      gitRefParam: ctx.gitRefParam,
      workspaceStorageSize: ctx.workspaceStorageSize,
      workspaceStorageClass: ctx.workspaceStorageClass,
      workspaceAccessModes: ctx.workspaceAccessModes,
      cacheWorkspaces: ctx.cacheWorkspaces,
      defaultPodSecurityContext: ctx.defaultPodSecurityContext,
      pipelineRunAnnotations: ctx.pipelineRunAnnotations,
    };

    const secretInterceptorParam = ctx.webhookSecretRef
      ? [{ name: 'secretRef', value: ctx.webhookSecretRef }]
      : [];

    if (event === TRIGGER_EVENTS.PUSH) {
      const trigger = new GitHubPushTrigger(scope, 'github-push-trigger', triggerProps);
      const hasTagEvent = ctx.allEvents.includes(TRIGGER_EVENTS.TAG);
      return {
        bindingRef: trigger.bindingRef,
        templateRef: trigger.templateRef,
        eventListenerEntry: {
          bindings: [{ kind: 'TriggerBinding', ref: trigger.bindingRef }],
          interceptors: [
            {
              ref: { kind: 'ClusterInterceptor', name: 'github' },
              params: [
                { name: 'eventTypes', value: ['push'] },
                ...secretInterceptorParam,
              ],
            },
            ...(hasTagEvent
              ? [{
                  ref: { kind: 'ClusterInterceptor', name: 'cel' },
                  params: [{ name: 'filter', value: "!body.ref.startsWith('refs/tags/')" }],
                }]
              : []),
          ],
          template: { ref: trigger.templateRef },
        },
      };
    }

    if (event === TRIGGER_EVENTS.PULL_REQUEST) {
      const trigger = new GitHubPullRequestTrigger(scope, 'github-pr-trigger', triggerProps);
      return {
        bindingRef: trigger.bindingRef,
        templateRef: trigger.templateRef,
        eventListenerEntry: {
          bindings: [{ kind: 'TriggerBinding', ref: trigger.bindingRef }],
          interceptors: [
            {
              ref: { kind: 'ClusterInterceptor', name: 'github' },
              params: [
                { name: 'eventTypes', value: ['pull_request'] },
                ...secretInterceptorParam,
              ],
            },
          ],
          template: { ref: trigger.templateRef },
        },
      };
    }

    if (event === TRIGGER_EVENTS.TAG) {
      const trigger = new GitHubTagTrigger(scope, 'github-tag-trigger', triggerProps);
      return {
        bindingRef: trigger.bindingRef,
        templateRef: trigger.templateRef,
        eventListenerEntry: {
          bindings: [{ kind: 'TriggerBinding', ref: trigger.bindingRef }],
          interceptors: [
            {
              ref: { kind: 'ClusterInterceptor', name: 'github' },
              params: [
                { name: 'eventTypes', value: ['push'] },
                ...secretInterceptorParam,
              ],
            },
            {
              ref: { kind: 'ClusterInterceptor', name: 'cel' },
              params: [{ name: 'filter', value: "body.ref.startsWith('refs/tags/')" }],
            },
          ],
          template: { ref: trigger.templateRef },
        },
      };
    }

    const _exhaustive: never = event;
    throw new Error(`GitHubVcsProvider: unsupported event type "${_exhaustive}"`);
  }
}
