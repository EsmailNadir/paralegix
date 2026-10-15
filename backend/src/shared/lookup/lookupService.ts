const { NotFoundError } = require('../errors/AppError');

export interface LookupServiceOptions {
  /** The module's repository, from `createLookupRepository`. */
  repository: any;
  /**
   * Human label for messages and 404s: `Court`, `Practice area`. Used verbatim,
   * so its capitalisation is the capitalisation the client sees.
   */
  label: string;
  /** Response key holding the rows on a list: `courts`, `practiceAreas`. */
  collectionKey: string;
  /** Response key holding the new id on a create: `courtId`, `practiceAreaId`. */
  idKey: string;
  /**
   * Body fields that map straight to columns, in the order they should be
   * written. A field absent from the body is stored as null on create, and left
   * untouched on update, which is what every one of these modules already did by
   * hand.
   */
  fields: string[];
}

/**
 * The five operations every reference list supports.
 *
 * Written out per module before this, at roughly sixty lines each, differing only
 * in the noun. The behaviour is deliberately preserved down to the response
 * shapes, including `mattersUpdated: 0` on update: no reference name is
 * denormalised onto `matters` any more, but the field is still in the responses
 * clients parse, so removing it here would be an API change rather than a
 * refactor.
 */
export function createLookupService({
  repository,
  label,
  collectionKey,
  idKey,
  fields,
}: LookupServiceOptions) {
  return {
    async create({ lawFirmId, userId, body }: any) {
      const data: Record<string, unknown> = { createdBy: userId };
      for (const field of fields) {
        data[field] = body[field] ?? null;
      }
      const result = await repository.create(lawFirmId, data);
      return { message: `${label} created successfully`, [idKey]: result.id };
    },

    async list({ lawFirmId }: any) {
      const rows = await repository.listOrdered(lawFirmId);
      return { [collectionKey]: rows, totalItems: rows.length };
    },

    async get({ lawFirmId, id }: any) {
      const row = await repository.findById(lawFirmId, id);
      if (!row) throw new NotFoundError(label);
      return row;
    },

    async update({ lawFirmId, id, body }: any) {
      // Existence is checked before the write so a missing row answers 404
      // rather than an update that silently matches nothing.
      await repository.findByIdOrFail(lawFirmId, id, label);

      const data: Record<string, unknown> = {};
      for (const field of fields) {
        if (body[field] !== undefined) data[field] = body[field];
      }
      await repository.update(lawFirmId, id, data);

      return { message: `${label} updated successfully`, mattersUpdated: 0 };
    },

    async delete({ lawFirmId, id }: any) {
      await repository.findByIdOrFail(lawFirmId, id, label);
      await repository.delete(lawFirmId, id);
      return { message: `${label} deleted successfully` };
    },
  };
}
