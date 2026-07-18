import { Construct } from 'constructs';
import { GitHubTriggerBase, GitHubTriggerBaseProps } from './github-trigger-base';

/** Props for {@link GitHubPullRequestTrigger}. Identical to {@link GitHubTriggerBaseProps}. */
export type GitHubPullRequestTriggerProps = GitHubTriggerBaseProps;

/** Trigger that fires on GitHub `pull_request` events. Extracts revision from `body.pull_request.head.sha`. */
export class GitHubPullRequestTrigger extends GitHubTriggerBase {
  constructor(scope: Construct, id: string, props: GitHubPullRequestTriggerProps) {
    super(scope, id, props, {
      bindingName: 'github-pull-request',
      templateName: 'github-pull-request-trigger-template',
      pipelineRunGenerateName: 'github-pull-request-pipeline-run-',
      gitRevisionValue: '$(body.pull_request.head.sha)',
      gitRefValue: '$(body.pull_request.head.ref)',
      // head.ref is already the bare branch name.
      branchValue: '$(body.pull_request.head.ref)',
      // Diff against the PR target branch tip.
      diffBaseValue: '$(body.pull_request.base.sha)',
    });
  }
}
