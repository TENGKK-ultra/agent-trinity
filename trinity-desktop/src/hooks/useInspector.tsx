import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { TaskDto } from '../services/core-api';

/**
 * The inspector keeps one place for everything that is only read: backend,
 * agents, task detail, project and context all live on the same page, because
 * each of them is a few lines and splitting them cost more navigation than it
 * saved. The todo list stays separate: it is the only page that asks the user
 * to act.
 */
export const INSPECTOR_PANELS = ['info', 'settings', 'todo'] as const;
export type InspectorPanel = (typeof INSPECTOR_PANELS)[number];

export const INSPECTOR_PANEL_LABEL: Record<InspectorPanel, string> = {
  info: '信息',
  settings: '设置',
  todo: '待办',
};

interface InspectorContextValue {
  panel: InspectorPanel;
  selectedTask: TaskDto | null;
  setPanel: (panel: InspectorPanel) => void;
  toggleTask: (task: TaskDto) => void;
  closeTask: () => void;
}

const InspectorContext = createContext<InspectorContextValue | null>(null);

/**
 * Lives above the router on purpose: switching pages must not close the drawer
 * or forget which task was being inspected.
 */
export function InspectorProvider({ children }: { children: ReactNode }) {
  const [panel, setPanelState] = useState<InspectorPanel>('info');
  const [selectedTask, setSelectedTask] = useState<TaskDto | null>(null);

  const setPanel = useCallback((next: InspectorPanel) => {
    setPanelState(next);
  }, []);

  const closeTask = useCallback(() => {
    setSelectedTask(null);
  }, []);

  const toggleTask = useCallback(
    (task: TaskDto) => {
      if (selectedTask?.id === task.id) {
        setSelectedTask(null);
        return;
      }

      setSelectedTask(task);
      setPanelState('info');
    },
    [selectedTask],
  );

  const value = useMemo(
    () => ({ panel, selectedTask, setPanel, toggleTask, closeTask }),
    [panel, selectedTask, setPanel, toggleTask, closeTask],
  );

  return <InspectorContext.Provider value={value}>{children}</InspectorContext.Provider>;
}

export function useInspector(): InspectorContextValue {
  const value = useContext(InspectorContext);

  if (value === null) {
    throw new Error('useInspector must be used inside InspectorProvider');
  }

  return value;
}
