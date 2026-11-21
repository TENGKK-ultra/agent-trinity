import type { Migration } from './types.ts';

/*
 * An assignment has to say why it went to that agent. The reason belongs with
 * the message, not in a log line: the collaboration tree is read back from
 * these rows, and "why not someone else" is the question it must answer.
 */
const REASON_SQL = `
ALTER TABLE agent_messages ADD COLUMN reason TEXT;
ALTER TABLE agent_messages ADD COLUMN assigned_by TEXT;
`;

export const migration013: Migration = {
  id: '013_collab_message_reason',
  up: (db) => {
    db.exec(REASON_SQL);
  },
};
