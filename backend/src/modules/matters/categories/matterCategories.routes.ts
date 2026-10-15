const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { requirePermission } = require('../../lawfirms/roles/requirePermission');

const {
  createCategorySchema,
  updateCategorySchema,
} = require('./matterCategories.validation');
const categoriesService = require('./matterCategories.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/matters/categories
router.get('/categories',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => categoriesService.listCategories({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// GET /api/lawfirms/:lawFirmId/matters/categories/tree
router.get('/categories/tree',
  verifyToken,
  requirePermission('matters.view'),
  handler(async (req) => categoriesService.listCategoriesTree({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
  })),
);

// POST /api/lawfirms/:lawFirmId/matters/categories
router.post('/categories',
  verifyToken,
  requirePermission('matters.update'),
  validate(createCategorySchema),
  handler(async (req) => categoriesService.createCategory({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    body: req.body,
  }), 201),
);

// PUT /api/lawfirms/:lawFirmId/matters/categories/:categoryId
router.put('/categories/:categoryId',
  verifyToken,
  requirePermission('matters.update'),
  validate(updateCategorySchema),
  handler(async (req) => categoriesService.updateCategory({
    lawFirmId: req.params.lawFirmId,
    categoryId: req.params.categoryId,
    userId: req.user.uid,
    body: req.body,
  })),
);

// DELETE /api/lawfirms/:lawFirmId/matters/categories/:categoryId
router.delete('/categories/:categoryId',
  verifyToken,
  requirePermission('matters.update'),
  handler(async (req) => categoriesService.deleteCategory({
    lawFirmId: req.params.lawFirmId,
    categoryId: req.params.categoryId,
    userId: req.user.uid,
  })),
);

export = router;
