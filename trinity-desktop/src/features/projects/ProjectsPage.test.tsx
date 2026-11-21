import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from './ProjectsPage';

const mocks = vi.hoisted(() => ({
  listProjects: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  listConversations: vi.fn(),
  setProjectMember: vi.fn(),
  setProjectBackground: vi.fn(),
}));

vi.mock('../../hooks/useCoreStatus', () => ({
  useCore: () => ({ state: 'connected', lastCheckedAt: null, lastError: null }),
}));

vi.mock('../../services/core-api', () => ({
  listProjects: mocks.listProjects,
  createProject: mocks.createProject,
  getProject: mocks.getProject,
  listConversations: mocks.listConversations,
  setProjectMember: mocks.setProjectMember,
  setProjectBackground: mocks.setProjectBackground,
}));

const project = {
  id: 'p1',
  name: '项目一',
  description: null,
  created_at: '2026-11-21T00:00:00.000Z',
  updated_at: '2026-11-21T00:00:00.000Z',
  conversation_count: 0,
  background_count: 0,
};

const conversation = {
  id: 'c1',
  project_id: null,
  title: '对话一',
  status: 'active',
  created_at: '2026-11-21T00:00:00.000Z',
  updated_at: '2026-11-21T00:00:00.000Z',
};

const detail = {
  project,
  members: [] as unknown[],
  background: [] as string[],
};

describe('ProjectsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjects.mockResolvedValue({ items: [] });
    mocks.listConversations.mockResolvedValue({ items: [conversation], total: 1, limit: 100, offset: 0 });
    mocks.createProject.mockResolvedValue(project);
    mocks.getProject.mockResolvedValue(detail);
    mocks.setProjectMember.mockResolvedValue({ ...detail, members: [conversation] });
    mocks.setProjectBackground.mockResolvedValue({ background: ['c1'] });
  });

  afterEach(() => {
    cleanup();
  });

  it('新建项目后可以看到对话并勾选归属与背景', async () => {
    render(<ProjectsPage />);

    expect(await screen.findByText('还没有项目')).toBeTruthy();

    // The list reload after creating returns the new project.
    mocks.listProjects.mockResolvedValue({ items: [project] });

    fireEvent.change(screen.getByLabelText('新项目名称'), {
      target: { value: '项目一' },
    });
    fireEvent.click(screen.getByRole('button', { name: /新建项目/ }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(await screen.findByText('对话一')).toBeTruthy();

    const member = screen.getAllByLabelText('归属')[0] as HTMLInputElement;
    fireEvent.click(member);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.setProjectMember).toHaveBeenCalledWith('p1', 'c1', true);

    const background = screen.getAllByLabelText('背景')[0] as HTMLInputElement;
    fireEvent.click(background);

    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.setProjectBackground).toHaveBeenCalledWith('p1', 'c1', true);
  });
});
