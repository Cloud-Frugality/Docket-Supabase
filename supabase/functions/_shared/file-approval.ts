// A file's approval, hold and retention. The uploader submits a file, its
// approvers approve it or send it back, and an approved file is kept for as
// long as its type says. A rule can send a category to an approver group;
// without one the file goes to the team's default approvers. Import-free, so the tests run this file;
// the client mirrors the states in src/lib/document-types.ts (drift-tested).

export const APPROVAL_STATES = ["none", "pending", "approved", "sent_back"] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];
export const APPROVAL_DECISIONS = ["approved", "sent_back"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const MAX_DECISION_COMMENT = 2000;
export const MAX_RETENTION_YEARS = 100;
export const MAX_GROUP_NAME = 100;
export const RULE_SCOPES = ["team", "client", "engagement"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];

/** One rule: this category goes to this group, for a team, a client or an engagement. */
export interface ApprovalRule {
  teamId: string | null;
  clientId: string | null;
  engagementId: string | null;
  categoryId: string;
  groupId: string;
}

/**
 * The group a file's approval goes to, or null for the default approvers. The
 * most specific rule for its category wins: the engagement's, then the
 * client's, then the team's.
 */
export function ruleFor(
  rules: readonly ApprovalRule[],
  file: { engagementId: string | null; clientId: string | null; teamId: string | null; categoryId: string | null },
): string | null {
  if (!file.categoryId) return null;
  const mine = rules.filter((r) => r.categoryId === file.categoryId);
  const hit = (file.engagementId ? mine.find((r) => r.engagementId === file.engagementId) : undefined) ??
    (file.clientId ? mine.find((r) => r.clientId === file.clientId) : undefined) ??
    (file.teamId ? mine.find((r) => r.teamId === file.teamId) : undefined);
  return hit?.groupId ?? null;
}

/** A group's members who can approve this file: never its uploader. */
export function groupPool(memberIds: readonly string[], uploaderId: string | null): string[] {
  return memberIds.filter((id) => id !== uploaderId);
}

/** Who of a group that needs everyone has still to approve. */
export function outstandingApprovers(pool: readonly string[], approvedIds: readonly string[]): string[] {
  return pool.filter((id) => !approvedIds.includes(id));
}

/**
 * Whose approval the caller gives next where everyone must approve: their own
 * first, then each person they stand in for. Null when they have none left.
 */
export function nextApprovalFor(input: {
  callerId: string;
  pool: readonly string[];
  delegatorIds: readonly string[];
  approvedIds: readonly string[];
}): string | null {
  const mine = [input.callerId, ...input.delegatorIds].filter((id) => input.pool.includes(id));
  return mine.find((id) => !input.approvedIds.includes(id)) ?? null;
}

/** A group's name as sent, or why it can't be used. */
export function parseGroupName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!name) return { ok: false, error: "Give the group a name." };
  if (name.length > MAX_GROUP_NAME) return { ok: false, error: `A group's name must be ${MAX_GROUP_NAME} characters or fewer.` };
  return { ok: true, name };
}

/** Who a file's approval goes to: the team's default approvers, or its team
 *  admins when it has none. Never the uploader, unless none is named. */
export function approverPool(defaultApproverIds: readonly string[], teamAdminIds: readonly string[], uploaderId: string | null): string[] {
  const approvers = defaultApproverIds.filter((id) => id !== uploaderId);
  return approvers.length ? approvers : teamAdminIds.filter((id) => id !== uploaderId);
}

export type ApprovalRight = { ok: true; actingFor: string | null } | { ok: false; reason: string };

/**
 * Whether the caller may decide a waiting file, and for whom. `delegatorIds`
 * are the people who named the caller as their delegate. Pass no uploader
 * where the organisation lets people approve their own.
 */
export function approvalRight(input: {
  callerId: string;
  uploaderId: string | null;
  callerIsGlobalAdmin: boolean;
  pool: readonly string[];
  delegatorIds: readonly string[];
}): ApprovalRight {
  const { callerId, uploaderId, pool } = input;
  if (uploaderId && callerId === uploaderId) return { ok: false, reason: "You can't approve a file you uploaded." };
  if (pool.includes(callerId)) return { ok: true, actingFor: null };
  // Standing in for the uploader would be approving your own work by proxy.
  const standIn = input.delegatorIds.find((id) => id !== uploaderId && pool.includes(id));
  if (standIn) return { ok: true, actingFor: standIn };
  // A file with no one else to ask falls to the global admins.
  if (pool.length === 0 && input.callerIsGlobalAdmin) return { ok: true, actingFor: null };
  return { ok: false, reason: "Only this file's approvers can approve it." };
}

/** Why a file can't be sent for approval, or null when it can. */
export function submitRefusal(file: { approvalState: string; archived: boolean; isLatest: boolean }): string | null {
  if (file.archived) return "Restore this file before sending it for approval.";
  if (!file.isLatest) return "Only the latest version can be sent for approval.";
  if (file.approvalState === "pending") return "This file is already waiting for approval.";
  if (file.approvalState === "approved") return "This file is already approved. Upload a new version to change it.";
  return null;
}

/** The day an approved file may first be deleted: the approval day plus the
 *  type's years. Null when the type has no retention. */
export function retainUntil(approvedOn: string, years: number | null): string | null {
  if (!years || years < 1) return null;
  const date = new Date(`${approvedOn}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/** Why a file can't be removed or deleted today, or null when nothing holds it. */
export function retentionRefusal(file: { onHold: boolean; retainUntil: string | null }, today: string): string | null {
  if (file.onHold) return "This file is on hold and can't be removed.";
  if (file.retainUntil && file.retainUntil > today) return `This file is retained until ${file.retainUntil} and can't be removed before then.`;
  return null;
}

/** A retention period as sent: whole years from 1 to the limit, or null for none. */
export function parseRetentionYears(raw: unknown): { ok: true; years: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, years: null };
  const years = Number(raw);
  if (!Number.isInteger(years) || years < 1 || years > MAX_RETENTION_YEARS) {
    return { ok: false, error: `A retention period is a whole number of years from 1 to ${MAX_RETENTION_YEARS}.` };
  }
  return { ok: true, years };
}

/**
 * The approval rules of a client or engagement not saved yet: what they will
 * be scoped as, and whether the caller may set them. An engagement names its
 * team and needs the caller in it (or a global admin); a client has no team.
 * Either way the caller must be able to write that kind of record.
 */
export function draftRuleRight(input: { teamId: string | null; writeLevel: number; inTeam: boolean; globalAdmin: boolean }): {
  scope: "client" | "engagement";
  allowed: boolean;
} {
  const scope = input.teamId ? "engagement" : "client";
  return { scope, allowed: input.writeLevel > 0 && (scope === "client" || input.globalAdmin || input.inTeam) };
}
