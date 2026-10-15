import type { NextFunction, Request, Response } from 'express';

const usersRepo = require('../../modules/users/users.repository');
const { ForbiddenError } = require('../errors/AppError');

/**
 * Requires verifyToken to run first and allows only users with users/{uid}.isAdmin === true.
 */
export async function requireIsAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.uid;
    if (!userId) {
      return next(new ForbiddenError('Authentication required'));
    }

    const userData = await usersRepo.findById(userId);
    if (!userData) {
      return next(new ForbiddenError('Admin access required'));
    }

    if (userData.isAdmin !== true) {
      return next(new ForbiddenError('Admin access required'));
    }

    req.adminUser = {
      uid: userId,
      email: userData.email,
      name: userData.name,
      isAdmin: true,
    };

    return next();
  } catch (error) {
    return next(error);
  }
}
