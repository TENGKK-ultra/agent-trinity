import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { appError } from '../types/index.ts';
import { sendError } from './http-utils.ts';
import { handleActivity } from './routes/activity.ts';
import { handleAgents } from './routes/agents.ts';
import { handleApprovals } from './routes/approvals.ts';
import { handleBoard, handleBoardGlobal, handleTeamSettings } from './routes/board.ts';
import { handleInternal } from './routes/internal.ts';
import { handleConversations } from './routes/conversations.ts';
import { handleEvents } from './routes/events.ts';
import { handleSearch } from './routes/search.ts';
import { handleHarnesses } from './routes/harnesses.ts';
import { handleMessages } from './routes/messages.ts';
import { handleAllTasks, handleTasks } from './routes/tasks.ts';
import {
  handleConversationUsage,
  handleTaskUsage,
  handleUsage,
} from './routes/usage.ts';
import { handleGroup } from './routes/group.ts';
import { handleAllRounds, handleCollab } from './routes/collab.ts';
import { handleWorkspaces } from './routes/workspaces.ts';
import { handleProjects } from './routes/projects.ts';
import { defaultRuntime, type CoreRuntime } from '../harnesses/runtime.ts';

export async function route(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  runtime: CoreRuntime = defaultRuntime,
  coreBaseUrl?: string,
): Promise<void> {
  try {
    // Only pathname and searchParams are read; the base is fixed so nothing in
    // this file can start depending on a caller-supplied Host header.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter(Boolean);

    // The only authenticated surface: a delegation token is the whole credential.
    if (segments[0] === 'api' && segments[1] === 'internal') {
      await handleInternal(db, req, res, segments, url, runtime);
      return;
    }

    // The Dashboard reads tasks across conversations.
    if (segments[0] === 'api' && segments[1] === 'tasks' && segments.length === 2) {
      await handleAllTasks(db, req, res, url);
      return;
    }

    // The event timeline: what Core itself observed, across every conversation.
    if (segments[0] === 'api' && segments[1] === 'events' && segments.length === 2) {
      await handleEvents(db, req, res, url);
      return;
    }

    // Global search over conversation titles and what was actually said.
    if (segments[0] === 'api' && segments[1] === 'search' && segments.length === 2) {
      await handleSearch(db, req, res, url);
      return;
    }

    // The capability directory: what is bound and running, across workspaces.
    if (segments[0] === 'api' && segments[1] === 'agents' && segments.length === 2) {
      handleAgents(db, req, res);
      return;
    }

    // Named directories an agent may work in.
    if (segments[0] === 'api' && segments[1] === 'workspaces' && segments.length === 2) {
      await handleWorkspaces(db, req, res);
      return;
    }

    // Projects: membership and the conversations a project uses as background.
    if (
      segments[0] === 'api' &&
      segments[1] === 'projects' &&
      segments.length >= 2 &&
      segments.length <= 4
    ) {
      await handleProjects(db, req, res, segments);
      return;
    }

    // Collaboration rounds across conversations, for the workspace view.
    if (segments[0] === 'api' && segments[1] === 'collab' && segments.length === 3) {
      handleAllRounds(db, req, res, url);
      return;
    }

    // The whiteboard's cross-conversation reads: open findings and live cards.
    if (segments[0] === 'api' && segments[1] === 'board' && segments.length === 3) {
      await handleBoardGlobal(db, req, res, segments, url);
      return;
    }

    // The global team settings (cross-review round limit).
    if (segments[0] === 'api' && segments[1] === 'settings' && segments.length === 3) {
      await handleTeamSettings(db, req, res);
      return;
    }

    // Usage is read across conversations; per-conversation and per-task views
    // live on the conversation paths below.
    if (segments[0] === 'api' && segments[1] === 'usage' && segments.length === 3) {
      await handleUsage(db, req, res, segments, url);
      return;
    }

    if (segments[0] !== 'api' || segments[1] !== 'conversations') {
      throw appError('not_found', 'Not found', 404);
    }

    if (segments.length >= 4) {
      const resource = segments[3];

      if (resource === 'approvals') {
        await handleApprovals(db, req, res, segments, url);
        return;
      }

      if (segments.length === 4 && resource === 'messages') {
        await handleMessages(db, req, res, segments, url);
        return;
      }

      if ((segments.length === 4 || segments.length === 5) && resource === 'activity') {
        await handleActivity(db, req, res, segments, url);
        return;
      }

      if (resource === 'collab') {
        await handleCollab(db, req, res, segments, url, runtime);
        return;
      }

      if (resource === 'board') {
        await handleBoard(db, req, res, segments, url, runtime);
        return;
      }

      if (segments.length === 4 && resource === 'group') {
        await handleGroup(
          db,
          req,
          res,
          decodeURIComponent(segments[2] ?? ''),
          runtime,
        );
        return;
      }

      if (segments.length === 4 && resource === 'usage') {
        await handleConversationUsage(
          db,
          req,
          res,
          decodeURIComponent(segments[2] ?? ''),
          url,
        );
        return;
      }

      if (
        segments.length === 6 &&
        resource === 'tasks' &&
        segments[5] === 'usage'
      ) {
        await handleTaskUsage(
          db,
          req,
          res,
          decodeURIComponent(segments[2] ?? ''),
          decodeURIComponent(segments[4] ?? ''),
          url,
        );
        return;
      }

      if (resource === 'tasks') {
        await handleTasks(db, req, res, segments, url);
        return;
      }

      if (
        segments.length === 4 &&
        (resource === 'agent' || resource === 'turns' || resource === 'permission')
      ) {
        await handleHarnesses(db, req, res, segments, url, runtime, coreBaseUrl);
        return;
      }
    }

    if (segments.length === 2 || segments.length === 3) {
      await handleConversations(db, req, res, segments, url);
      return;
    }

    throw appError('not_found', 'Not found', 404);
  } catch (err) {
    sendError(res, err);
  }
}
