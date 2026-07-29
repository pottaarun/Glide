export interface MigrationDefaultZone {
  id: string;
  name: string;
  accountId?: string;
}

export interface MigrationExportTarget {
  accountId?: string;
  zoneId?: string;
  zoneName?: string;
}

export type MigrationTargetScope = "account" | "zone";

export type MigrationTargetResolution =
  | { ok: true; target: MigrationExportTarget }
  | { ok: false; message: string };

function sameId(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function normalizedId(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

function sameZoneName(left: string | undefined, right: string | undefined): boolean {
  const normalize = (value: string | undefined) => value?.trim().replace(/\.$/, "").toLowerCase();
  return Boolean(left && right && normalize(left) === normalize(right));
}

/** Resolve account and zone as one tuple; never borrow an unrelated default. */
export function resolveMigrationExportTarget(
  defaultAccountId: string | undefined,
  defaultZone: MigrationDefaultZone | undefined,
  args: MigrationExportTarget,
  scope: MigrationTargetScope,
): MigrationTargetResolution {
  if (scope === "account") {
    if (args.zoneId || args.zoneName) {
      return { ok: false, message: "This provider is account-scoped; omit zone id and zone name." };
    }
    const accountId = normalizedId(args.accountId ?? defaultAccountId ?? defaultZone?.accountId);
    return { ok: true, target: accountId ? { accountId } : {} };
  }

  if (args.zoneName && !args.zoneId) {
    return { ok: false, message: "A zone name can be exported only with its zone id." };
  }

  if (args.zoneId) {
    const matchesDefault = sameId(args.zoneId, defaultZone?.id);
    const knownAccountId = matchesDefault ? defaultZone?.accountId : undefined;
    if (matchesDefault && args.zoneName && !sameZoneName(args.zoneName, defaultZone?.name)) {
      return { ok: false, message: "The requested zone name does not match the selected default zone." };
    }
    if (args.accountId && knownAccountId && !sameId(args.accountId, knownAccountId)) {
      return { ok: false, message: "The requested account does not own the selected default zone." };
    }
    if (args.accountId && matchesDefault && !knownAccountId) {
      return {
        ok: false,
        message: "Glide cannot verify the legacy default zone's account. Select it with find_zone first.",
      };
    }
    if (args.accountId && !matchesDefault) {
      return {
        ok: false,
        message: "Glide cannot verify that account/zone tuple. Select the zone with find_zone first.",
      };
    }
    return {
      ok: true,
      target: {
        zoneId: normalizedId(args.zoneId),
        ...(args.accountId || knownAccountId ? { accountId: normalizedId(args.accountId ?? knownAccountId) } : {}),
        ...(args.zoneName || (matchesDefault ? defaultZone?.name : undefined)
          ? { zoneName: args.zoneName ?? defaultZone?.name }
          : {}),
      },
    };
  }

  if (args.accountId) {
    const matchingZone = sameId(args.accountId, defaultZone?.accountId) ? defaultZone : undefined;
    return {
      ok: true,
      target: {
        accountId: normalizedId(args.accountId),
        ...(matchingZone
          ? { zoneId: normalizedId(matchingZone.id), zoneName: matchingZone.name }
          : {}),
      },
    };
  }

  if (defaultZone) {
    return {
      ok: true,
      target: {
        zoneId: normalizedId(defaultZone.id),
        zoneName: defaultZone.name,
        ...(defaultZone.accountId ? { accountId: normalizedId(defaultZone.accountId) } : {}),
      },
    };
  }
  return { ok: true, target: defaultAccountId ? { accountId: normalizedId(defaultAccountId) } : {} };
}

/** Account-only changes must not retain a zone with different or unknown ownership. */
export function zoneAfterAccountChange(
  zone: MigrationDefaultZone | undefined,
  accountId: string,
): MigrationDefaultZone | undefined {
  return sameId(zone?.accountId, accountId) ? zone : undefined;
}
