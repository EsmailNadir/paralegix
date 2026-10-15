const leadsRepo = require('./leads.repository');
const leadStagesRepo = require('./stages/leadStages.repository');
const mattersRepo = require('../matters/matters.repository');
const clientsRepo = require('../clients/clients.repository');
const { assertLawFirmMembership } = require('../../shared/utils/membership');
const { NotFoundError, ValidationError } = require('../../shared/errors/AppError');
const { enforceCountLimit } = require('../../shared/plans/planEnforcement');
const { withDrizzleTransaction } = require('../../shared/database/queryContext');
const eventBus = require('../../shared/events/eventBus');
const {
  LEAD_CREATED,
  LEAD_UPDATED,
  LEAD_STAGE_CHANGED,
  LEAD_CONVERTED,
  LEAD_DELETED,
  MATTER_CREATED,
} = require('../../shared/events/eventTypes');
const { normalizeEmail } = require('../../shared/utils/normalizeEmail');

const trimOrNull = (v: any) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
};

async function getLeadOrThrow(lawFirmId: string, leadId: string) {
  const lead = await leadsRepo.getById(lawFirmId, leadId);
  if (!lead) throw new NotFoundError('Lead');
  return lead;
}

async function assertStageInFirm(lawFirmId: string, stageId: string) {
  if (!stageId) return;
  const ok = await leadStagesRepo.existsInFirm(lawFirmId, stageId);
  if (!ok) throw new ValidationError({ stageId: ['Invalid stageId for this law firm'] });
}

export async function listLeads({
  lawFirmId, userId, search, stageId, page, limit, offset, sort, sortBy, order,
}: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const { leads, totalItems } = await leadsRepo.listLeadsPaged(lawFirmId, {
    search,
    stageId,
    page,
    limit: limit ?? null,
    offset: offset ?? null,
    sort,
    sortBy,
    order,
  });
  return limit != null ? { leads, totalItems } : { leads };
}

export async function getLead({ lawFirmId, userId, leadId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const lead = await leadsRepo.getByIdWithIntakeStatus(lawFirmId, leadId);
  if (!lead) throw new NotFoundError('Lead');
  return { lead };
}

export async function createLead({ lawFirmId, userId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);

  const name = (body.name || '').trim();
  if (!name) throw new ValidationError({ name: ['Lead name is required'] });

  await assertStageInFirm(lawFirmId, body.stageId);

  let stageId = body.stageId || null;
  if (!stageId) {
    const defaultStage = await leadStagesRepo.getDefaultOpenStage(lawFirmId);
    stageId = defaultStage?.id || null;
  }

  const lead = await leadsRepo.create(lawFirmId, {
    name,
    email: normalizeEmail(body.email) || null,
    phone: trimOrNull(body.phone),
    organization: trimOrNull(body.organization),
    referralSource: trimOrNull(body.referralSource),
    notes: trimOrNull(body.notes),
    stageId,
    stageDate: body.stageDate || null,
    disqualifyReason: trimOrNull(body.disqualifyReason),
    createdBy: userId,
  });

  eventBus.emit(LEAD_CREATED, { lawFirmId, leadId: lead.id, lead, userId });
  return { message: 'Lead created successfully', leadId: lead.id, lead };
}

export async function updateLead({ lawFirmId, userId, leadId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const existing = await getLeadOrThrow(lawFirmId, leadId);

  if (Object.prototype.hasOwnProperty.call(body, 'stageId')) {
    await assertStageInFirm(lawFirmId, body.stageId);
  }

  const updates: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = (body.name || '').trim();
    if (!name) throw new ValidationError({ name: ['Lead name is required'] });
    updates.name = name;
  }
  if (body.email !== undefined) updates.email = normalizeEmail(body.email) || null;
  if (body.phone !== undefined) updates.phone = trimOrNull(body.phone);
  if (body.organization !== undefined) updates.organization = trimOrNull(body.organization);
  if (body.referralSource !== undefined) updates.referralSource = trimOrNull(body.referralSource);
  if (body.notes !== undefined) updates.notes = trimOrNull(body.notes);
  if (body.stageId !== undefined) updates.stageId = body.stageId || null;
  if (body.stageDate !== undefined) updates.stageDate = body.stageDate || null;
  if (body.disqualifyReason !== undefined) updates.disqualifyReason = trimOrNull(body.disqualifyReason);

  if (!Object.keys(updates).length) {
    return { message: 'No changes applied', lead: existing };
  }

  const lead = await leadsRepo.update(lawFirmId, leadId, updates);
  if (!lead) throw new NotFoundError('Lead');

  if (updates.stageId !== undefined && updates.stageId !== existing.stageId) {
    eventBus.emit(LEAD_STAGE_CHANGED, {
      lawFirmId, leadId, previousStageId: existing.stageId, stageId: lead.stageId, userId,
    });
  }
  eventBus.emit(LEAD_UPDATED, { lawFirmId, leadId, lead, userId, updates });

  return { message: 'Lead updated successfully', lead };
}

export async function deleteLead({ lawFirmId, userId, leadId }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  await getLeadOrThrow(lawFirmId, leadId);
  const ok = await leadsRepo.delete(lawFirmId, leadId);
  if (!ok) throw new NotFoundError('Lead');
  eventBus.emit(LEAD_DELETED, { lawFirmId, leadId, userId });
  return { message: 'Lead deleted successfully', leadId };
}

/**
 * Lock the lead row and recheck `convertedAt` INSIDE the caller's transaction,
 * then immediately claim the conversion by writing `convertedAt` in that same
 * transaction. "Claim before creating" is what closes the race: the client (and,
 * on the matter path, the matter) is created only after the claim is durable
 * within the transaction that holds the lock, so a second concurrent caller
 * blocked on the same lock re-reads a lead that is ALREADY converted the moment
 * it unblocks, before it creates anything of its own. See
 * `leads.repository.ts#lockForConversion` for why the lock is needed at all.
 */
async function claimLeadConversion(lawFirmId: string, leadId: string, executor: any) {
  const locked = await leadsRepo.lockForConversion(lawFirmId, leadId, executor);
  if (!locked) throw new NotFoundError('Lead');
  if (locked.convertedAt) throw new ValidationError('Lead already converted');
  await leadsRepo.update(lawFirmId, leadId, { convertedAt: new Date() }, executor);
}

/**
 * Convert a lead into a client + matter. Reuses createMatterWithMembersTx with
 * the lead's contact info as an inline clients array (find-or-create client,
 * create matter, link members atomically).
 *
 * `body.clientType === 'company'` converts the lead into a company client
 * instead of a person: `lead.organization` becomes the company's name, and the
 * lead's own name/email/phone become its first roster contact, created and
 * linked transactionally with the client (see `mattersRepo.findOrCreateClientForMatter`
 * / `findOrCreateClientsForMatter`). This is never inferred from `lead.organization`
 * merely being filled in - a person lead can have an employer noted there
 * without meaning "convert this into a company client" - the caller must ask
 * for it explicitly.
 */
/**
 * The client a conversion creates or reuses, in the shape
 * `findOrCreateClientsForMatter` takes.
 *
 * A person conversion copies the lead. A company conversion goes into the
 * organization the caller picked by id, else one named by the caller, else the
 * lead's own `organization` text. A typed or lead-supplied name still reuses a
 * firm organization with the same name. Either way the lead's person joins
 * that organization's roster.
 */
async function conversionClientInputs(lawFirmId: string, lead: any, body: any, userId: string) {
  if (body.clientType !== 'company') {
    return {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      organization: lead.organization,
      actingUserId: userId,
    };
  }
  const rosterContact = { name: lead.name, email: lead.email, phone: lead.phone };

  if (body.organizationClientId) {
    const org = await clientsRepo.findByIdRaw(lawFirmId, body.organizationClientId);
    if (!org || org.clientType !== 'company' || org.status === 'archived') {
      throw new ValidationError({ organizationClientId: ['Choose an active organization in this firm'] });
    }
    return { clientType: 'company', clientId: org.id, rosterContact, actingUserId: userId };
  }

  const name = (body.organizationName ?? '').trim() || (lead.organization || '').trim();
  if (!name) {
    throw new ValidationError({ organization: ['Choose or name the organization to convert this lead into'] });
  }
  return { clientType: 'company', name, rosterContact, actingUserId: userId };
}

export async function convertLead({ lawFirmId, userId, leadId, body }: any) {
  await assertLawFirmMembership(lawFirmId, userId);
  const lead = await getLeadOrThrow(lawFirmId, leadId);
  if (lead.convertedAt) throw new ValidationError('Lead already converted');

  const createMatter = body.createMatter !== false;
  const clientInputs = await conversionClientInputs(lawFirmId, lead, body, userId);

  if (!createMatter) {
    const closedStage = await leadStagesRepo.getFirstClosedStage(lawFirmId);
    const { clientId, updated } = await withDrizzleTransaction(async (transaction: any) => {
      await claimLeadConversion(lawFirmId, leadId, transaction);
      const [id] = await mattersRepo.findOrCreateClientsForMatter(lawFirmId, [clientInputs], transaction);
      const convertedLead = await leadsRepo.update(lawFirmId, leadId, {
        convertedClientId: id,
        stageId: closedStage?.id ?? lead.stageId,
      }, transaction);
      return { clientId: id, updated: convertedLead };
    });

    eventBus.emit(LEAD_CONVERTED, {
      lawFirmId,
      leadId,
      matterId: null,
      clientId,
      userId,
    });

    return {
      message: 'Lead converted successfully',
      lead: updated,
      matterId: null,
      clientId,
    };
  }

  await enforceCountLimit(lawFirmId, 'maxMatters', () => mattersRepo.countMatters(lawFirmId));

  const matterName = (body.name || '').trim();
  if (!matterName) throw new ValidationError({ name: ['Matter name is required'] });

  let validPracticeAreaId = null;
  if (body.practiceAreaId) {
    const pa = await mattersRepo.validatePracticeArea(lawFirmId, body.practiceAreaId);
    validPracticeAreaId = pa ? body.practiceAreaId : null;
  }
  let validCourtId = null;
  if (body.courtId) {
    const court = await mattersRepo.validateCourt(lawFirmId, body.courtId);
    validCourtId = court ? body.courtId : null;
  }

  const leadIds = Array.isArray(body.leadUserIds) && body.leadUserIds.length
    ? [...new Set(body.leadUserIds.filter(Boolean))]
    : [userId];
  const primaryLeadId = leadIds[0] || userId;

  const matterReferenceId = await mattersRepo.generateUniqueMatterReferenceId(lawFirmId);

  const closedStage = await leadStagesRepo.getFirstClosedStage(lawFirmId);
  let updated;
  const matter = await mattersRepo.createMatterWithMembersTx(
    lawFirmId,
    {
      name: matterName,
      matterNumber: body.matterNumber || null,
      description: body.description || '',
      status: 'active',
      matterReferenceId,
      createdBy: userId,
      leadUserId: primaryLeadId,
      practiceAreaId: validPracticeAreaId,
      category: body.category || null,
      courtId: validCourtId,
    },
    {
      leadIds,
      actingUserId: userId,
      clients: [clientInputs],
      // Claims the conversion (lock + recheck + set `convertedAt`) INSIDE the
      // same transaction as the matter insert, before the insert runs. An
      // already-converted lead throws here and rolls the whole matter create
      // back, rather than creating a matter for a lead a concurrent request
      // already converted. See `claimLeadConversion` above.
      beforeInsert: async (conn: any) => {
        await mattersRepo.lockFirmForMatterCountCheck(lawFirmId, conn);
        await enforceCountLimit(lawFirmId, 'maxMatters', () => mattersRepo.countMatters(lawFirmId, conn));
        await claimLeadConversion(lawFirmId, leadId, conn);
      },
      afterInsert: async (matterId: string, clientIds: string[], conn: any) => {
        updated = await leadsRepo.update(lawFirmId, leadId, {
          convertedClientId: clientIds[0] ?? null,
          convertedMatterId: matterId,
          stageId: closedStage?.id ?? lead.stageId,
        }, conn);
      },
    },
  );

  const convertedClientId = matter.clients?.[0]?.id ?? null;

  eventBus.emit(LEAD_CONVERTED, {
    lawFirmId,
    leadId,
    matterId: matter.id,
    clientId: convertedClientId,
    userId,
  });
  eventBus.emit(MATTER_CREATED, {
    lawFirmId,
    matterId: matter.id,
    memberUserIds: matter.memberUserIds || [primaryLeadId],
    matterData: matter,
    userId,
  });

  return {
    message: 'Lead converted successfully',
    lead: updated,
    matterId: matter.id,
    clientId: convertedClientId,
    matter,
  };
}
