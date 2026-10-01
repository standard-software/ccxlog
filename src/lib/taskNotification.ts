// Claude Code's harness injects user-role messages of its own: when a
// background task finishes, a `<task-notification>...</task-notification>`
// block arrives as if the user had typed it. Rendered, such a block is a pair
// whose "question" nobody asked and whose answer is usually empty — pure
// plumbing noise between the real conversation blocks.
//
// The aggregate output drops a pair only when BOTH hold:
//   - the question consists solely of task-notification blocks (one or more,
//     nothing but whitespace around them), and
//   - the answer is empty.
// A single character of real user text keeps the pair (harness notifications
// can be delivered alongside a typed message), and a non-empty answer keeps it
// too — a turn that announced "build finished, tests pass" after a
// notification is real content. Under --watch this is one-directional: an
// answer can only arrive and make a hidden pair appear, never the reverse, so
// the rule cannot fight the automatic-backup machinery.
//
// This is a fixed rule, not a setting: the dropped pairs contain no words from
// either side of the conversation, and the raw JSONL (plus --backup-jsonl)
// remains the complete record.
const TASK_NOTIFICATION_ONLY_RE
  = /^(?:\s*<task-notification>[\s\S]*?<\/task-notification>)+\s*$/;

export function isTaskNotificationOnly(question: string, answer: string): boolean {
  if (answer.trim() !== '') return false;
  return TASK_NOTIFICATION_ONLY_RE.test(question);
}
