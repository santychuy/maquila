import { resolve } from "node:path";
import { createExeExecutionProvider } from "../integrations/exe-provider.js";
import { createGitHubSourceControlProvider } from "../integrations/github-provider.js";
import { createLinearWorkItemProvider } from "../integrations/linear-provider.js";
import {
  runMaquila,
  type InternalMaquilaRunControls,
  type MaquilaConfig,
  type MaquilaRunRequest,
  type MaquilaRunResult,
} from "../maquila.js";

export interface BuiltInControllerCredentials {
  linearToken: string;
  githubToken: string;
  openRouterKey: string;
  identity?: string;
}
export interface BuiltInControllerTarget {
  issue: string;
  owner: string;
  repo: string;
  baseRef: string;
  tag: string;
  timeoutSeconds: number;
}

/** Private CLI composition. Credentials remain in provider/config instances. */
export function builtInMaquilaInvocation(
  root: string,
  credentials: BuiltInControllerCredentials,
  target: BuiltInControllerTarget,
): { config: MaquilaConfig; request: MaquilaRunRequest } {
  return {
    config: {
      workItemProvider: createLinearWorkItemProvider({ token: credentials.linearToken }),
      sourceControlProvider: createGitHubSourceControlProvider({ token: credentials.githubToken }),
      executionProvider: createExeExecutionProvider(
        credentials.identity ? { identity: credentials.identity } : {},
      ),
      stateDirectory: resolve(root, ".maquila"),
      openRouterApiKey: credentials.openRouterKey,
    },
    request: {
      workItem: { provider: "linear", id: target.issue },
      sourceControl: {
        provider: "github",
        repository: `${target.owner}/${target.repo}`,
        baseRef: target.baseRef,
      },
      execution: { provider: "exe.dev", tag: target.tag },
      timeoutSeconds: target.timeoutSeconds,
    },
  };
}

export function runBuiltInMaquila(
  root: string,
  credentials: BuiltInControllerCredentials,
  target: BuiltInControllerTarget,
  controls?: InternalMaquilaRunControls,
): Promise<MaquilaRunResult> {
  const invocation = builtInMaquilaInvocation(root, credentials, target);
  return runMaquila(invocation.config, invocation.request, controls);
}
