import type { NextFunction, Request, Response } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMaintenanceModeEnabled() {
  return String(process.env.MAINTENANCE_MODE || '').toLowerCase() === 'true';
}

export function maintenanceMode(req: Request, res: Response, next: NextFunction) {
  if (!isMaintenanceModeEnabled()) return next();

  // Only block writes during maintenance cutovers.
  if (!MUTATING_METHODS.has(req.method)) return next();

  return res.status(503).json({
    error: 'The system is temporarily in maintenance mode for data migration. Please retry shortly.',
    code: 'MAINTENANCE_MODE',
  });
}
