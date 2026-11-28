// Moving a file to a different client or engagement: who may file there, and
// which files may leave where they are.

const LEVEL_OWN = 1;
const LEVEL_ALL = 2;

/** Who is asking, as the access roles and teams have them. */
export interface Mover {
  callerId: string;
  /** Their write level on Clients and on Engagements. */
  clientLevel: number;
  engagementLevel: number;
  teamIds: readonly string[];
}

/**
 * Adding to a client needs Can edit on it (the visibility rule's) and Clients
 * write: at Own, a client you created.
 */
export function mayFileOnClient(who: Mover, client: { createdBy: string | null; canEdit: boolean }): boolean {
  if (!client.canEdit) return false;
  return who.clientLevel >= LEVEL_ALL || (who.clientLevel === LEVEL_OWN && client.createdBy === who.callerId);
}

/**
 * Adding to an engagement needs Can edit on it and Engagements write: at Own,
 * an engagement of one of your teams.
 */
export function mayFileOnEngagement(who: Mover, engagement: { teamId: string; canEdit: boolean }): boolean {
  if (!engagement.canEdit) return false;
  return who.engagementLevel >= LEVEL_ALL || (who.engagementLevel === LEVEL_OWN && who.teamIds.includes(engagement.teamId));
}

/** A file stays in its team; only a global admin moves one to another team's work. */
export function moveTeamRefusal(fromTeamId: string, toTeamId: string, globalAdmin: boolean): string | null {
  return globalAdmin || fromTeamId === toTeamId ? null : "A file can only move within its team.";
}

export interface MoveTarget {
  id: string;
  name: string;
  teamId: string;
  /** Whether a file can go on the client itself, not only on its engagements. */
  canFile: boolean;
  engagements: { id: string; name: string }[];
}

/**
 * Every place the caller may move a file to: each client they can add to or
 * that has an engagement they can add to, by name. Archived ones are left out
 * by whoever reads the rows.
 */
export function moveTargets(
  clients: readonly { id: string; name: string; createdBy: string | null; teamId: string; canEdit: boolean }[],
  engagements: readonly { id: string; name: string; clientId: string; teamId: string; canEdit: boolean }[],
  who: Mover,
): MoveTarget[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return clients
    .map((c) => ({
      id: c.id,
      name: c.name,
      teamId: c.teamId,
      canFile: mayFileOnClient(who, c),
      engagements: engagements
        .filter((e) => e.clientId === c.id && mayFileOnEngagement(who, e))
        .map((e) => ({ id: e.id, name: e.name }))
        .sort(byName),
    }))
    .filter((c) => c.canFile || c.engagements.length > 0)
    .sort(byName);
}

/** Why a file can't leave the client or engagement it is on, or null when it can. */
export function leaveRefusal(file: { archived: boolean; onHold: boolean; retainUntil: string | null }, today: string): string | null {
  if (file.archived) return "A removed file can't be moved. Restore it first.";
  if (file.onHold) return "This file is on hold, so it stays where it is filed.";
  if (file.retainUntil && file.retainUntil > today) {
    return `This file is retained until ${file.retainUntil}, so it stays where it is filed until then.`;
  }
  return null;
}
