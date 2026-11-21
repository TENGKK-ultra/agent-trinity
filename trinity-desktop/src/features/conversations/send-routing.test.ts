import { describe, expect, it } from 'vitest';
import type { AgentSessionDto } from '../../services/core-api';
import { mentionedAgents, planSend } from './send-routing';

function agent(
  name: 'claude' | 'codex' | 'deepseek',
  participating: boolean,
  active = false,
): AgentSessionDto {
  return {
    agent: name,
    display_name: name,
    active,
    participating,
    status: 'idle',
    native_session_id: null,
    cwd: null,
    model: null,
    last_seen_at: null,
  };
}

describe('发送路由', () => {
  it('只点亮 Claude 时，普通发送只走 Claude', () => {
    const plan = planSend('你好', [agent('claude', true, true)]);
    expect(plan).toEqual({ mode: 'solo', targets: ['claude'] });
  });

  it('点亮两个时，走群聊且只包含这两个', () => {
    const plan = planSend('你好', [agent('claude', true, true), agent('codex', true)]);
    expect(plan).toEqual({ mode: 'group', targets: ['claude', 'codex'] });
  });

  it('三个全部点亮才启动三个', () => {
    const plan = planSend('你好', [
      agent('claude', true, true),
      agent('codex', true),
      agent('deepseek', true),
    ]);
    expect(plan).toEqual({ mode: 'group', targets: ['claude', 'codex', 'deepseek'] });
  });

  it('三个都已绑定但只点亮一个，仍然只启动一个', () => {
    const plan = planSend('你好', [
      agent('claude', true, true),
      agent('codex', false),
      agent('deepseek', false),
    ]);
    expect(plan).toEqual({ mode: 'solo', targets: ['claude'] });
  });

  it('提及优先：点亮 Claude 和 Codex，但 @DSH 只启动 DSH', () => {
    const plan = planSend('请 @DSH 查一下', [
      agent('claude', true, true),
      agent('codex', true),
      agent('deepseek', false),
    ]);
    expect(plan).toEqual({ mode: 'mention', targets: ['deepseek'] });
  });

  it('同时提及多个 Agent，只启动被提及且已绑定的集合', () => {
    const plan = planSend('@Claude 和 @Codex 一起看', [
      agent('claude', false),
      agent('codex', false),
      agent('deepseek', true, true),
    ]);
    expect(plan).toEqual({ mode: 'mention', targets: ['claude', 'codex'] });
  });

  it('混合提及时只保留已绑定的被提及者', () => {
    const plan = planSend('@Claude 和 @DSH 一起看', [agent('claude', true)]);
    expect(plan).toEqual({ mode: 'mention', targets: ['claude'] });
  });

  it('只提及未绑定的 Agent 时不启动任何人', () => {
    const plan = planSend('@DSH 看一下', [agent('claude', true, true)]);
    expect(plan).toEqual({
      mode: 'none',
      targets: [],
      reason: '被提及的 Agent 尚未绑定',
    });
  });

  it('没有任何点亮时普通发送被拒绝', () => {
    const plan = planSend('你好', [agent('claude', false, true)]);
    expect(plan).toEqual({
      mode: 'none',
      targets: [],
      reason: '先在顶部点亮至少一个 Agent',
    });
  });

  it('提及解析支持 dsh 别名并按固定顺序去重', () => {
    expect(mentionedAgents('@Codex @dsh @Codex')).toEqual(['codex', 'deepseek']);
    expect(mentionedAgents('邮箱 foo@bar.com 不是提及')).toEqual([]);
  });

  it('团队模式：点亮三个时只启动 Codex，其余待命', () => {
    const plan = planSend(
      '做一个任务',
      [agent('claude', true, true), agent('codex', true), agent('deepseek', true)],
      { mode: 'team' },
    );

    expect(plan).toEqual({ mode: 'team', targets: ['codex'], dispatcher: 'codex' });
  });

  it('团队模式：Codex 不在场时退回普通群聊，由界面提示', () => {
    const plan = planSend(
      '做一个任务',
      [agent('claude', true, true), agent('deepseek', true)],
      { mode: 'team' },
    );

    expect(plan).toEqual({ mode: 'group', targets: ['claude', 'deepseek'] });
  });

  it('团队模式不覆盖用户点名', () => {
    const plan = planSend(
      '@Claude 就看这个',
      [agent('claude', true, true), agent('codex', true), agent('deepseek', true)],
      { mode: 'team' },
    );

    expect(plan).toEqual({ mode: 'mention', targets: ['claude'] });
  });

  it('用户显式选择「Codex 执行」时，只启动 Codex 的普通回合', () => {
    const plan = planSend(
      '这次你来做',
      [agent('claude', true, true), agent('codex', true), agent('deepseek', true)],
      { mode: 'codex' },
    );

    expect(plan).toEqual({ mode: 'solo', targets: ['codex'] });
  });

  it('「Codex 执行」要求 Codex 已绑定并参与', () => {
    expect(
      planSend('这次你来做', [agent('claude', true, true)], { mode: 'codex' }),
    ).toEqual({ mode: 'none', targets: [], reason: 'Codex 尚未绑定到这个工作区' });

    expect(
      planSend('这次你来做', [agent('codex', false)], { mode: 'codex' }),
    ).toEqual({ mode: 'none', targets: [], reason: '先在顶部点亮 Codex' });
  });

  it('全员模式：即使 Codex 在场，也回到所有参与者各答各的', () => {
    const plan = planSend(
      '大家说说',
      [agent('claude', true, true), agent('codex', true), agent('deepseek', true)],
      { mode: 'broadcast' },
    );

    expect(plan).toEqual({ mode: 'group', targets: ['claude', 'codex', 'deepseek'] });
  });
});
