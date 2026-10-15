export type Court = {
  id: string;
  lawFirmId: string;
  name: string;
  abbreviation?: string | null;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  courtType?: string | null;
};

export function formatCourtOptionLabel(court: Pick<Court, 'name' | 'abbreviation' | 'city'>): string {
  const abbreviation = court.abbreviation?.trim();
  const city = court.city?.trim();
  const name = abbreviation ? `${court.name} (${abbreviation})` : court.name;

  return city ? `${name}: ${city}` : name;
}

/** Formats a court's address fields into a single display/location string. */
export function formatCourtAddress(court?: Pick<Court, 'address' | 'city' | 'state'> | null): string {
  if (!court) return '';
  const cityState = [court.city?.trim(), court.state?.trim()].filter(Boolean).join(', ');
  return [court.address?.trim(), cityState].filter(Boolean).join(', ');
}
