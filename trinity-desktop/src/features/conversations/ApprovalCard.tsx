import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ApprovalDto } from '../../services/core-api';

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  deepseek: 'DSH',
};

type Question = NonNullable<ApprovalDto['payload']['questions']>[number];

function questionsOf(approval: ApprovalDto): Question[] {
  const raw = approval.payload?.questions;
  if (!Array.isArray(raw)) return [];

  return raw.filter((item) => typeof item?.question === 'string');
}

/** The one line the user has to read before deciding. */
function detailOf(approval: ApprovalDto): string {
  const detail = approval.payload?.detail;
  if (typeof detail === 'string' && detail !== '') return detail;

  const keys = approval.payload?.input_keys;
  if (Array.isArray(keys) && keys.length > 0) return `涉及参数：${keys.join('、')}`;

  return approval.tool_name ?? '';
}

export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: ApprovalDto;
  busy: boolean;
  onDecide: (decision: 'approve' | 'deny', answers?: Record<string, string>) => void;
}) {
  const questions = approval.kind === 'question' ? questionsOf(approval) : [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});

  const toggle = (question: Question, label: string): void => {
    setPicked((current) => {
      const selected = current[question.question] ?? [];

      if (question.multiSelect) {
        return {
          ...current,
          [question.question]: selected.includes(label)
            ? selected.filter((item) => item !== label)
            : [...selected, label],
        };
      }

      return { ...current, [question.question]: [label] };
    });
  };

  const ready =
    questions.length === 0 || questions.every((q) => (picked[q.question] ?? []).length > 0);

  const approve = (): void => {
    if (questions.length === 0) {
      onDecide('approve');
      return;
    }

    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = (picked[q.question] ?? []).join(', ');
    onDecide('approve', answers);
  };

  return (
    <section className="approval-card" data-kind={approval.kind}>
      <header className="approval-head">
        <ShieldAlert size={15} strokeWidth={1.8} />
        <span className="approval-agent">{AGENT_LABEL[approval.agent] ?? approval.agent}</span>
        <span className="approval-title">
          {approval.kind === 'question'
            ? '想问你一个问题'
            : (approval.payload?.label ?? `请求使用 ${approval.tool_name ?? '工具'}`)}
        </span>
      </header>

      {questions.length > 0 ? (
        <div className="approval-questions">
          {questions.map((question) => (
            <div key={question.question} className="approval-question">
              <p>{question.question}</p>
              <div className="approval-options">
                {(question.options ?? []).map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className="approval-option"
                    data-picked={(picked[question.question] ?? []).includes(option.label)}
                    title={option.description ?? undefined}
                    onClick={() => toggle(question, option.label)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <pre className="approval-detail">{detailOf(approval)}</pre>
      )}

      <div className="approval-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={() => onDecide('deny')}>
          拒绝
        </button>
        <button className="btn btn-primary" disabled={busy || !ready} onClick={approve}>
          批准
        </button>
      </div>
    </section>
  );
}
