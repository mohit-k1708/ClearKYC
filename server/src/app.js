/**
 * Builds the Express application (no network listening here, so tests can reuse it).
 */
const express = require('express');
const cors = require('cors');
const env = require('./config/env');
const routes = require('./routes');
const { requestContext } = require('./utils/requestContext');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { rejectNulCharacters } = require('./middleware/rejectNulCharacters');

const app = express();
app.disable('x-powered-by'); // do not advertise the framework

app.use(cors({ origin: env.corsOrigin }));
app.use(express.json({ limit: '100kb' }));
app.use(rejectNulCharacters); // a NUL character cannot be stored by PostgreSQL: refuse it with a 400 instead of failing later with a 500
app.use(requestContext); // Scene 5: lets the audit trail see who acted and from which IP address

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
