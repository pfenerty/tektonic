import { Construct } from 'constructs';
import { GitHubTriggerBase, GitHubTriggerBaseProps } from './github-trigger-base';

/** Props for {@link GitHubPushTrigger}. Identical to {@link GitHubTriggerBaseProps}. */
export type GitHubPushTriggerProps = GitHubTriggerBaseProps;

/** Trigger that fires on GitHub `push` events. Extracts revision from `body.head_commit.id`. */
export class GitHubPushTrigger extends GitHubTriggerBase {
  constructor(scope: Construct, id: string, props: GitHubPushTriggerProps) {
    super(scope, id, props, {
      bindingName: 'github-push',
      templateName: 'github-push-trigger-template',
      pipelineRunGenerateName: 'github-push-pipeline-run-',
      gitRevisionValue: '$(body.head_commit.id)',
      gitRefValue: '$(body.ref)',
      // Normalized branch name from the CEL overlay (see GitHubVcsProvider push interceptor).
      branchValue: '$(extensions.branch)',
      // Diff against the commit prior to this push.
      diffBaseValue: '$(body.before)',
    });
  }
}
