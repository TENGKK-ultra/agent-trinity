import { Database } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';

export function MemoryPage() {
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>项目记忆</h1>
          <p>经确认的项目事实、决策与约束</p>
        </div>
        <div className="grow" />
        <span className="chip chip-warning">Phase 2 未完成</span>
      </div>

      <div className="page-body">
        <div className="tiles">
          <div className="tile">
            <div className="label">已确认事实</div>
            <div className="value">0</div>
          </div>
          <div className="tile">
            <div className="label">已确认决策</div>
            <div className="value">0</div>
          </div>
          <div className="tile">
            <div className="label">已知问题</div>
            <div className="value">0</div>
          </div>
          <div className="tile">
            <div className="label">待验证</div>
            <div className="value">0</div>
          </div>
        </div>

        <div className="card">
          <EmptyState
            icon={Database}
            title="记忆系统尚未启用"
            description="数据库表已由 Migration 002 建立，但确认流程与对外 API 仍属于 Phase 2 的后续里程碑。完成前此处不会显示任何模拟记忆。"
          />
        </div>
      </div>
    </section>
  );
}
