/**
 * Reference-catalog service.
 *
 * Read side: search the global court_catalog, list UTBMS codes.
 * Adopt side: copy-on-adopt. Copies selected catalog entries into the firm's own
 * per-firm tables (courts / charge_codes / expense_categories), linking each
 * copy back to the catalog row via the catalog_court_id / utbms_code_id column.
 * The copies are ordinary editable per-firm rows; the link is provenance only.
 *
 * Adoption is idempotent: entries the firm has already adopted (same catalog
 * link) or whose code already exists are skipped, never duplicated.
 */

const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { ValidationError } = require('../../shared/errors/AppError');
const catalogRepo = require('./catalog.repository');
const courtsRepo = require('../courts/courts.repository');
const chargeCodesRepo = require('../billing/chargeCodes/chargeCodes.repository');
const expenseCategoriesRepo = require('../billing/expenseCategories/expenseCategories.repository');

function assertNonEmptyIdList(ids: any, label: any) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ValidationError(`${label} is required`);
  }
}

/** Search the global courts directory. */
export async function searchCourts({ lawFirmId, actingUserId, search, state, courtType, jurisdiction, limit, offset }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  return catalogRepo.searchCourts(lawFirmId, { search, state, courtType, jurisdiction, limit, offset });
}

/** List UTBMS codes (optionally filtered by type / practice set). */
export async function listUtbmsCodes({ lawFirmId, actingUserId, codeType, practiceSet }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  const codes = await catalogRepo.listUtbmsCodes({ codeType, practiceSet });
  return { utbmsCodes: codes, totalItems: codes.length };
}

/** Copy selected catalog courts into the firm's courts table. */
export async function adoptCourts({ lawFirmId, actingUserId, catalogCourtIds }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  assertNonEmptyIdList(catalogCourtIds, 'catalogCourtIds');

  const catalogRows = await catalogRepo.getCourtsByIds(catalogCourtIds);
  const alreadyAdopted = await catalogRepo.findAdoptedCatalogCourtIds(lawFirmId, catalogCourtIds);
  let nextOrder = await catalogRepo.getMaxSortOrder(lawFirmId, 'courts');

  let adopted = 0;
  const skipped = [];
  for (const c of catalogRows) {
    if (alreadyAdopted.has(c.id)) { skipped.push(c.id); continue; }
    nextOrder += 1;
    await courtsRepo.create(lawFirmId, {
      name: c.fullName,
      abbreviation: c.citationAbbrev || c.shortName || null,
      state: c.state || null,
      courtType: c.courtType || null,
      catalogCourtId: c.id,
      order: nextOrder,
      createdBy: actingUserId,
    });
    adopted += 1;
  }

  return {
    message: `Adopted ${adopted} court${adopted === 1 ? '' : 's'} from the catalog`,
    requested: catalogCourtIds.length,
    adopted,
    skipped: skipped.length,
  };
}

/**
 * Shared adopt routine for UTBMS-backed lists (charge codes / expense
 * categories). `kind` selects the code type + target repo/table.
 */
async function adoptUtbms({ lawFirmId, actingUserId, utbmsCodeIds, kind }: any) {
  assertNonEmptyIdList(utbmsCodeIds, 'utbmsCodeIds');

  const cfg = ({
    task: { repo: chargeCodesRepo, table: 'charge_codes', codeType: 'task', label: 'charge code' },
    expense: { repo: expenseCategoriesRepo, table: 'expense_categories', codeType: 'expense', label: 'expense category' },
  } as Record<string, any>)[kind];

  const rows = (await catalogRepo.getUtbmsCodesByIds(utbmsCodeIds))
    .filter((r: any) => r.codeType === cfg.codeType);

  const adoptedLinks = await catalogRepo.findAdoptedUtbmsCodeIds(lawFirmId, cfg.table, utbmsCodeIds);
  const existingCodes = await catalogRepo.findExistingCodes(lawFirmId, cfg.table, rows.map((r: any) => r.code));
  let nextOrder = await catalogRepo.getMaxSortOrder(lawFirmId, cfg.table);

  let adopted = 0;
  const skipped = [];
  for (const r of rows) {
    const code = String(r.code).toUpperCase();
    if (adoptedLinks.has(r.id) || existingCodes.has(code)) { skipped.push(r.code); continue; }
    nextOrder += 1;
    const data: any = {
      lawFirmId,
      code,
      name: r.name,
      isActive: true,
      order: nextOrder,
      utbmsCodeId: r.id,
      createdBy: actingUserId,
    };
    if (cfg.codeType === 'expense') data.isDefault = false;
    await cfg.repo.create(lawFirmId, data);
    existingCodes.add(code); // guard against duplicate codes within the same batch
    adopted += 1;
  }

  return {
    message: `Adopted ${adopted} ${cfg.label}${adopted === 1 ? '' : 's'} from UTBMS`,
    requested: utbmsCodeIds.length,
    adopted,
    skipped: skipped.length,
  };
}

export async function adoptChargeCodes({ lawFirmId, actingUserId, utbmsCodeIds }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  return adoptUtbms({ lawFirmId, actingUserId, utbmsCodeIds, kind: 'task' });
}

export async function adoptExpenseCategories({ lawFirmId, actingUserId, utbmsCodeIds }: any) {
  await assertLawFirmMembership(lawFirmId, actingUserId);
  return adoptUtbms({ lawFirmId, actingUserId, utbmsCodeIds, kind: 'expense' });
}
