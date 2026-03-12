/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dynamic per-peer agent creation for Feishu direct messages and groups.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import type { DynamicAgentCreationConfig } from './types';

type AgentConfigEntry = NonNullable<NonNullable<ClawdbotConfig['agents']>['list']>[number];
type BindingEntry = NonNullable<ClawdbotConfig['bindings']>[number];
type DynamicPeerKind = Extract<NonNullable<NonNullable<BindingEntry['match']['peer']>['kind']>, 'direct' | 'group'>;

export interface MaybeCreateDynamicAgentResult {
  created: boolean;
  updatedCfg: ClawdbotConfig;
  agentId?: string;
}

export async function maybeCreateDynamicAgent(params: {
  cfg: ClawdbotConfig;
  runtime: PluginRuntime;
  peerKind: DynamicPeerKind;
  peerId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  accountId?: string;
  log: (...args: unknown[]) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, peerKind, peerId, dynamicCfg, accountId, log } = params;

  const existingBindings: BindingEntry[] = cfg.bindings ?? [];
  const hasBinding = existingBindings.some(
    (binding) =>
      binding.match.channel === 'feishu' &&
      (!accountId || binding.match.accountId === accountId) &&
      binding.match.peer?.kind === peerKind &&
      binding.match.peer?.id === peerId,
  );

  if (hasBinding) {
    return { created: false, updatedCfg: cfg };
  }

  const existingAgents: AgentConfigEntry[] = cfg.agents?.list ?? [];

  if (dynamicCfg.maxAgents !== undefined) {
    const feishuAgentCount = existingAgents.filter((agent) => agent.id.startsWith('feishu-')).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(
        `feishu[${accountId ?? 'default'}]: dynamic agent creation skipped because maxAgents=${dynamicCfg.maxAgents} was reached`,
      );
      return { created: false, updatedCfg: cfg };
    }
  }

  const agentId = buildDynamicAgentId(peerKind, peerId);
  const existingAgent = existingAgents.find((agent) => agent.id === agentId);

  if (existingAgent) {
    const updatedCfg: ClawdbotConfig = {
      ...cfg,
      bindings: [
        ...existingBindings,
        createBinding(agentId, peerKind, peerId, accountId),
      ],
    };

    await runtime.config.writeConfigFile(updatedCfg);
    log(`feishu[${accountId ?? 'default'}]: added missing dynamic binding for ${peerKind}:${peerId} -> ${agentId}`);
    return { created: true, updatedCfg, agentId };
  }

  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? '~/.openclaw/workspaces/{agentId}';
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? '~/.openclaw/agents/{agentId}/agent';
  const workspace = resolveUserPath(
    workspaceTemplate
      .replaceAll('{userId}', peerKind === 'direct' ? peerId : '')
      .replaceAll('{chatId}', peerKind === 'group' ? peerId : '')
      .replaceAll('{peerId}', peerId)
      .replaceAll('{kind}', peerKind)
      .replaceAll('{agentId}', agentId),
  );
  const agentDir = resolveUserPath(
    agentDirTemplate
      .replaceAll('{userId}', peerKind === 'direct' ? peerId : '')
      .replaceAll('{chatId}', peerKind === 'group' ? peerId : '')
      .replaceAll('{peerId}', peerId)
      .replaceAll('{kind}', peerKind)
      .replaceAll('{agentId}', agentId),
  );

  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(agentDir, { recursive: true });

  const updatedCfg: ClawdbotConfig = {
    ...cfg,
    agents: {
      ...(cfg.agents ?? {}),
      list: [...existingAgents, { id: agentId, workspace, agentDir }],
    },
    bindings: [
      ...existingBindings,
      createBinding(agentId, peerKind, peerId, accountId),
    ],
  };

  await runtime.config.writeConfigFile(updatedCfg);
  log(
    `feishu[${accountId ?? 'default'}]: created dynamic agent ${agentId} with workspace ${path.normalize(workspace)}`,
  );

  return { created: true, updatedCfg, agentId };
}

export function shouldCreateDynamicAgentForPeer(
  dynamicCfg: DynamicAgentCreationConfig | undefined,
  peerKind: DynamicPeerKind,
): boolean {
  if (!dynamicCfg?.enabled) return false;

  const scope = dynamicCfg.scope ?? 'direct';
  return scope === 'both' || scope === peerKind;
}

function buildDynamicAgentId(peerKind: 'direct' | 'group', peerId: string): string {
  return peerKind === 'group' ? `feishu-group-${peerId}` : `feishu-${peerId}`;
}

function createBinding(
  agentId: string,
  peerKind: DynamicPeerKind,
  peerId: string,
  accountId?: string,
): BindingEntry {
  return {
    agentId,
    match: {
      channel: 'feishu',
      ...(accountId ? { accountId } : {}),
      peer: { kind: peerKind, id: peerId },
    },
  };
}

function resolveUserPath(rawPath: string): string {
  if (rawPath === '~' || rawPath === '～') return os.homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('～/')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}