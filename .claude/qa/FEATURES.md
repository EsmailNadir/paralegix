# QA Feature Matrix

Durable state for the `/qa-sweep` loop. The loop reads this file at the start of every
iteration and writes it back at the end. It is the loop's memory: without it, a long
`/loop` run re-tests the same screens forever and never reaches the bottom of the list.

**Only the `Status`, `Last tested`, and `Bug` columns are meant to change.** Leave the ID,
Area, Feature, and Reach columns alone unless a route genuinely moved.

## Status values

| Value | Meaning |
| --- | --- |
| `todo` | Never tested by the loop. |
| `pass` | Verified working in the browser on the date shown. |
| `fail` | Broken. Must have a bug file in `.claude/qa/bugs/`. |
| `fixed` | Was broken, fix applied and re-verified in the browser this run. |
| `blocked` | Can't be tested (missing data, missing plan feature, needs a second browser). Say why in the Bug column. |
| `deferred` | Broken, but the fix is too large or architectural for a loop iteration. Bug file written, fix left for a human. |

## Order of work

Areas are worked top to bottom: **Matters → Tasks → Files → Messages**. Within an area,
take the lowest `todo` row. Re-test `fail` rows before starting new `todo` rows in the
same area, since a fix in one row often unblocks the next.

## Environment

Firm owner `test3@gmail.com` / `password`, firm **Test3 Test Firm**
`/lawfirm/1354e5d3-1b94-46b2-b78d-0e04faece7d4`. Full details and gotchas live in the
`playwright-mcp-testing` skill and the `test-accounts` memory.

---

## Matters

Matter detail tabs are deep-linkable: `/lawfirm/<firmId>/matters/<matterId>?tab=<tab>`.

| ID | Feature | Reach | Status | Last tested | Bug |
| --- | --- | --- | --- | --- | --- |
| M01 | Matters list renders; counts and columns correct | `/matters` | pass | 2026-07-24 | |
| M02 | Matters list search, filter, sort, filter cleanup | `/matters` | pass | 2026-07-24 | |
| M03 | ~~Matters kanban view~~ — removed in `47d12d94`; matters list is list-only now, no board toggle. Row obsolete, leave as-is | `/matters` | blocked | 2026-08-06 | Feature removed, not a bug |
| M04 | Create matter (required fields, validation, appears in list) | `CreateMatterModal` | pass | 2026-07-24 | |
| M05 | Edit matter (all fields save and re-render) | `EditMatterModal` | pass | 2026-07-24 | |
| M06 | Stage bar: advance stage, branching stages, Won/Lost/Settled endings | `MatterStageBar` | todo | | Dead end on a flat pipeline fixed (sibling fallback); re-test. Finding: M06-flat-stages-dead-end (repro refreshed 2026-07-27) |
| M07 | Stage pipeline editor: add and rename stages | `settings/matter-stages` + `StagePipelineEditor` | pass | 2026-07-24 | Branch/reorder split out to M27/M28 |
| M27 | Stage editor: "Add step after" branching, "Mark as ending" | `StagePipelineEditor` | todo | | Split from M07, not yet exercised. Reorder moved to M28 |
| M28 | Stage editor: reorder stages | `StagePipelineEditor` | blocked | 2026-07-27 | No reorder UI exists. The flowchart editor replaced the old up/down list; `reorderStages` is wired backend→service→hook with zero component callers. Product decision needed before this can be tested |
| M08 | Tab: Overview renders all detail fields | `?tab=overview` | todo | | |
| M09 | Overview: custom fields card reads and writes | `MatterCustomFieldsCard` | todo | | |
| M10 | Overview: budget card, billing prefs, budget warnings | `MatterBudgetCard` | todo | | |
| M11 | Overview: conflict check banner and legal hold control | `ConflictCheckBanner`, `MatterLegalHoldControl` | todo | | |
| M12 | Tab: Tasks lists matter tasks; create task from matter | `?tab=tasks` | todo | | |
| M13 | Tab: Events, key dates and SOL entries CRUD | `?tab=events` | todo | | |
| M14 | Tab: Clients, add and edit a client on the matter | `?tab=clients` | todo | | |
| M15 | Tab: Contacts, related contacts CRUD | `?tab=contacts` | todo | | |
| M16 | Tab: Messages, matter-scoped thread loads and sends | `?tab=messages` | todo | | |
| M17 | Tab: Team, add and remove a firm member | `?tab=team` | todo | | |
| M18 | Tab: Notes, create, edit, delete | `?tab=notes` | todo | | |
| M19 | Tab: Time tracking, add entry, timer start/stop, totals | `?tab=time-tracking` | todo | | |
| M20 | Tab: Billing, invoice list, totals, generate-invoice link | `?tab=billing` | todo | | |
| M21 | Tab: Documents / Files sub-tab, upload, folder, preview | `?tab=files` | todo | | |
| M22 | Tab: Documents / Requests sub-tab, create and fulfil a request | `?tab=requests` | todo | | |
| M23 | Matter activity feed records the actions taken above | `MatterActivityFeed` | todo | | |
| M24 | Apply deadline set to a matter | `ApplyDeadlineSetModal` | todo | | |
| M25 | Bulk assign member across matters | `BulkAssignMemberModal` | todo | | |
| M26 | Close and delete a matter (no orphaned data, no data loss) | `/matters` | todo | | Cover BOTH paths: single delete and the list's bulk delete. M26 is FIXED and covered by a test. Finding: M26-bulk-delete-bypasses-billing-guard (fixed 2026-07-27, not yet browser-verified) |

## Tasks

| ID | Feature | Reach | Status | Last tested | Bug |
| --- | --- | --- | --- | --- | --- |
| T01 | Tasks list renders (`TasksGrid`) | `/tasks` | todo | | |
| T02 | ~~Tasks kanban~~: removed; tasks list is list-only now, no board toggle. Row obsolete | `/tasks` | blocked | 2026-09-20 | Feature removed, not a bug |
| T03 | Create task, validation, appears in list | `CreateTaskModal` | todo | | |
| T04 | Edit task, all fields save | `EditTaskModal` | todo | | |
| T05 | Task detail overview tab | `TaskOverviewTab` | todo | | |
| T06 | Subtasks: add, complete, reorder, delete | `TaskSubtasks` | todo | | |
| T07 | Task attachments upload and open | `TaskAttachments` | todo | | |
| T08 | Assignees and visibility (ethical wall hides task from non-members) | `AddTaskClientModal`, task visibility | todo | | |
| T09 | Task notes CRUD | task notes | todo | | |
| T10 | Task filters, search, sort | `/tasks` | todo | | |
| T11 | Task analytics figures match the underlying list | `TaskAnalytics` | todo | | |
| T12 | Complete and reopen a task; status colours consistent | `taskConstants.ts` | todo | | |
| T13 | Task dependencies block/unblock correctly | task dependencies | todo | | |

## Files

| ID | Feature | Reach | Status | Last tested | Bug |
| --- | --- | --- | --- | --- | --- |
| F01 | Files page renders; storage usage bar accurate | `/files` | todo | | |
| F02 | Upload a file | `FileUpload` | todo | | |
| F03 | Create folder; folder colours persist | `FolderColorPicker` | todo | | |
| F04 | Move file to folder | `MoveToFolderModal` | todo | | |
| F05 | Preview a file, including PDF preview | `FilePreviewModal`, `PdfPreview` | todo | | |
| F06 | Rename and delete a file | `FileItemMenu` | todo | | |
| F07 | Bulk actions on multi-select | `BulkActionsMenu` | todo | | |
| F08 | Share files with a client | `ClientSharePickerModal` | todo | | |
| F09 | Secure share link: create, expiry, revoke, anonymous access | `ShareLinkModal` | todo | | |
| F10 | Files search and filter | `/files` | todo | | |
| F11 | Client-uploaded documents appear to the firm | two-way docs | todo | | |

## Messages

| ID | Feature | Reach | Status | Last tested | Bug |
| --- | --- | --- | --- | --- | --- |
| MSG01 | Messages page renders; conversation list ordering and unread badges | `/messages` | todo | | |
| MSG02 | Open a conversation; history renders | `ConversationView` | todo | | |
| MSG03 | Send a message; it persists across reload | `MessageInput` | todo | | |
| MSG04 | Attach a file to a message | `MessageFilePicker` | todo | | |
| MSG05 | Create a group conversation | `NewGroupModal` | todo | | |
| MSG06 | Add and remove participants; inline system messages appear | `GroupParticipantsModal` | todo | | |
| MSG07 | History-visibility toggle when adding a client to a group | `history_visible_from` | todo | | |
| MSG08 | Tag a conversation to matters | `GroupMattersModal`, `ConversationMatterTags` | todo | | |
| MSG09 | Message search | `MessageSearch` | todo | | |
| MSG10 | Messaging settings menu | `MessagingSettingsMenu` | todo | | |
| MSG11 | Read state clears the unread badge and survives reload | `conversation_read_state` | todo | | |

---

## Run log

The loop appends one line per iteration to `.claude/qa/runs/<date>.md`.
