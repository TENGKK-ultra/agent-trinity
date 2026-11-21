import type { AgentKind } from '../../services/core-api';

export const AGENT_ORDER: AgentKind[] = ['claude', 'codex', 'deepseek'];

export const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DSH',
};

export const AGENT_LABEL_SHORT: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DSH',
};

export const AGENT_BY_SENDER: Record<string, AgentKind> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  'DeepSeek Harness': 'deepseek',
  DSH: 'deepseek',
};

export const MENTION_NAME: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DSH',
};
