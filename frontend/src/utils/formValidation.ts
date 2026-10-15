export interface ValidationField {
  name: string;
  value: string | null | undefined;
  required?: boolean;
  label: string;
}

export function validateRequiredFields(fields: ValidationField[]): string | null {
  const missingFields = fields
    .filter(field => field.required && (!field.value || field.value.trim() === ''))
    .map(field => field.label);

  if (missingFields.length === 0) {
    return null;
  }

  if (missingFields.length === 1) {
    return `Missing ${missingFields[0].toLowerCase()}`;
  }

  const lastField = missingFields.pop();
  return `Missing ${missingFields.join(', ').toLowerCase()} and ${lastField?.toLowerCase()}`;
}
