const express = require('express');
const customers = require('../controllers/customerController');
const dashboard = require('../controllers/dashboardController');
const meta = require('../controllers/metaController');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();

router.get('/health', (req, res) => res.json({ status: 'ok' }));
router.get('/meta', meta.getMeta);

router.post('/customers', asyncHandler(customers.createCustomer));
router.get('/customers', asyncHandler(customers.listCustomers));
router.get('/customers/:id', asyncHandler(customers.getCustomer));

router.get('/dashboard/summary', asyncHandler(dashboard.getSummary));

// Scene 2: documents, KYC requirements, verification, completeness
router.use(require('./kyc'));

// Scene 3: beneficial ownership, owner screening, risk assessment
router.use(require('./ownership'));

// Scene 4: exceptions, review cases, periodic reviews
router.use(require('./reviews'));

// Scene 5: audit trail, alerts, analytics, data quality, exports
router.use(require('./reporting'));

// Phase 6: settings (expiry alert lead times), onboarding decisions, person view, detection jobs
router.use(require('./settings'));
router.use(require('./onboarding'));

module.exports = router;
