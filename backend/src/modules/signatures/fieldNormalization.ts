function normalizeFieldIdValue(value: any, index: any) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || `field_${index + 1}`;
}

export function normalizeSignatureFields(fields = []) {
  if (!Array.isArray(fields)) {
    return { fields: [], changed: false };
  }

  const seenIds = new Set<string>();
  let changed = false;

  const normalizedFields = (fields as any[]).map((field: any, index: number) => {
    const baseId = normalizeFieldIdValue(field?.id, index);
    let nextId = baseId;
    let suffix = 2;

    while (seenIds.has(nextId)) {
      nextId = `${baseId}__${suffix}`;
      suffix += 1;
    }

    seenIds.add(nextId);

    if (nextId !== field?.id) {
      changed = true;
    }

    return {
      ...field,
      id: nextId,
    };
  });

  return { fields: normalizedFields, changed };
}
